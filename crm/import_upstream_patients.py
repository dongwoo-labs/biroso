"""업스트림 '환자 목록' 엑셀(.xlsx) 또는 CSV를 비로소 Twenty 환자(person)로 가져온다.

차트번호가 키다. 같은 차트번호가 Twenty에 있으면 업스트림에서 온 칸만 고치고, 없으면 새로 만든다.
전화번호로는 합치지 않는다(가족이 번호를 같이 쓰는 경우가 있다). 여러 번 실행해도 된다.

사용(맥에서, 원본 파일은 밖으로 보내지 않는다):
  TWENTY_URL=https://biroso.<CRM 도메인> TWENTY_API_KEY=<관리자 키> python3 import_upstream_patients.py 환자_목록.xlsx          # 미리보기
  TWENTY_URL=... TWENTY_API_KEY=... python3 import_upstream_patients.py 환자_목록.xlsx --apply  # 실제로 쓰기

먼저 setup_clinic_objects.py를 실행해 차트번호 등 필드를 만들어 둔다.
열(업스트림 2026-11 기준 15열): 환자명, 성별, 나이, 차트번호, 생년월일, 휴대폰번호, 전화번호, 최초내원일, 최종내원일,
주소, 특이사항, 소개자, 가족, 광고수신동의여부, 알림공지수신동의여부. 나이는 생년월일에서 계산되므로 쓰지 않는다.
"""
import csv, datetime, io, json, os, re, sys, urllib.parse, urllib.request, zipfile
import xml.etree.ElementTree as ET

URL = os.environ.get("TWENTY_URL", "http://localhost:3000").rstrip("/")
KEY = os.environ.get("TWENTY_API_KEY", "")
UA = "biroso-import/1.0"
NOTICE = "업스트림 이관(원 동의 시각 미상)"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
TWO_CHAR_SURNAMES = ["남궁", "제갈", "선우", "황보", "독고", "사공", "서문", "동방", "어금", "망절"]


# ---- 파일 읽기(표준 라이브러리만) ----

def read_xlsx(path):
    """첫 시트를 [{열 이름: 값}]으로. 모든 값은 문자열(차트번호 앞자리 0 보존)."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
        sheets = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
        root = ET.fromstring(z.read(sheets[0]))
    rows = []
    for row in root.iter("{%s}row" % NS["m"]):
        cells = {}
        for c in row.findall("m:c", NS):
            col = re.match(r"[A-Z]+", c.get("r")).group(0)
            v = c.find("m:v", NS)
            if c.get("t") == "s" and v is not None:
                val = shared[int(v.text)]
            elif c.get("t") == "inlineStr":
                val = "".join(t.text or "" for t in c.iter("{%s}t" % NS["m"]))
            else:
                val = v.text if v is not None else ""
            cells[col_index(col)] = val or ""
        if cells:
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
    return to_dicts(rows)


def col_index(col):
    n = 0
    for ch in col:
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return to_dicts(list(csv.reader(f)))


def to_dicts(rows):
    if not rows:
        return []
    head = [h.strip() for h in rows[0]]
    return [{h: (r[i].strip() if i < len(r) else "") for i, h in enumerate(head)} for r in rows[1:] if any(x.strip() for x in r)]


# ---- 값 바꾸기 ----

def parse_date(raw):
    """'1985-03-02', '1985.03.02', '19850302', '1985/3/2', 엑셀 날짜 숫자(32204)를 YYYY-MM-DD로. 못 읽으면 None."""
    s = (raw or "").strip()
    if not s:
        return None
    if re.fullmatch(r"\d{5}(\.0+)?", s):  # 엑셀 날짜 일련번호
        return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(s)))).isoformat()
    m = re.fullmatch(r"(\d{4})[-./]?\s*(\d{1,2})[-./]?\s*(\d{1,2})\.?(?:\s.*)?", s)
    if not m:
        return None
    try:
        return datetime.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    except ValueError:
        return None


def parse_phone(raw):
    """국내 번호를 Twenty PHONES 형식(앞 0 뺀 국내번호)으로. 휴대폰이 아니어도 받는다. 못 읽으면 None."""
    d = re.sub(r"\D", "", raw or "")
    if d.startswith("82"):
        d = "0" + d[2:]
    if not re.fullmatch(r"0\d{8,10}", d):
        return None
    return d[1:]


def parse_yes(raw):
    s = (raw or "").strip().upper()
    if s in ("Y", "YES", "TRUE", "1", "O", "동의", "수신", "예"):
        return True
    if s in ("N", "NO", "FALSE", "0", "X", "미동의", "거부", "수신거부", "아니오", ""):
        return False
    return None


def split_name(full):
    full = re.sub(r"\s+", "", full or "")
    if len(full) <= 1:
        return {"lastName": "", "firstName": full}
    cut = 2 if full[:2] in TWO_CHAR_SURNAMES and len(full) > 2 else 1
    return {"lastName": full[:cut], "firstName": full[cut:]}


def to_person(row):
    """엑셀 한 줄 → (Twenty person 패치, 문제 목록). 업스트림에서 오는 칸만 담는다."""
    issues = []
    chart = (row.get("차트번호") or "").strip()
    if not chart:
        return None, ["차트번호 없음"]
    p = {"chartNo": chart, "name": split_name(row.get("환자명"))}
    if not row.get("환자명", "").strip():
        issues.append("이름 없음")
    sex = (row.get("성별") or "").strip()
    if sex:
        p["sex"] = {"여": "F", "여성": "F", "F": "F", "남": "M", "남성": "M", "M": "M"}.get(sex.upper() if len(sex) == 1 else sex)
        if not p["sex"]:
            issues.append(f"성별 '{sex}'")
            del p["sex"]
    for col, key in (("생년월일", "birthDate"), ("최초내원일", "firstVisitAt"), ("최종내원일", "lastVisitAt")):
        raw = row.get(col, "")
        if raw:
            d = parse_date(raw)
            if d:
                p[key] = d
            else:
                issues.append(f"{col} '{raw}'")
    mobile, tel = row.get("휴대폰번호", ""), row.get("전화번호", "")
    m, t = parse_phone(mobile), parse_phone(tel)
    if mobile and not m:
        issues.append("휴대폰번호 형식")
    if tel and not t:
        issues.append("전화번호 형식")
    main = m or t
    if main:
        p["phones"] = {"primaryPhoneNumber": main, "primaryPhoneCountryCode": "KR", "primaryPhoneCallingCode": "+82",
                       "additionalPhones": [{"number": t, "countryCode": "KR", "callingCode": "+82"}] if (m and t and t != m) else []}
    if row.get("주소"):
        p["address"] = {"addressStreet1": row["주소"], "addressCountry": "South Korea"}
    for col, key in (("소개자", "referredBy"), ("가족", "familyNote"), ("특이사항", "upstreamNote")):
        if row.get(col):
            p[key] = row[col]
    ad, notice = parse_yes(row.get("광고수신동의여부")), parse_yes(row.get("알림공지수신동의여부"))
    if ad is None:
        issues.append(f"광고수신동의여부 '{row.get('광고수신동의여부')}'")
    else:
        p["consentMarketing"] = ad
    if notice is None:
        issues.append(f"알림공지수신동의여부 '{row.get('알림공지수신동의여부')}'")
    else:
        p["consentNotice"] = notice
    return p, issues


# ---- Twenty ----

def rest(method, path, body=None):
    req = urllib.request.Request(
        URL + "/rest" + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json", "User-Agent": UA},
    )
    return json.load(urllib.request.urlopen(req))


def existing_by_chart():
    out, cursor = {}, ""
    while True:
        qs = "?limit=60&filter=" + urllib.parse.quote('chartNo[is]:NOT_NULL') + (f"&starting_after={cursor}" if cursor else "")
        r = rest("GET", "/people" + qs)
        for p in r["data"]["people"]:
            if p.get("chartNo"):
                out[p["chartNo"]] = p
        if not r.get("pageInfo", {}).get("hasNextPage"):
            return out
        cursor = r["pageInfo"]["endCursor"]


def plan(rows, existing):
    """각 줄을 만들기/고치기/그대로/건너뜀으로 나눈다. 화면 없이 테스트한다."""
    out = {"create": [], "update": [], "same": [], "skip": [], "issues": []}
    seen = set()
    phone_count = {}
    for i, row in enumerate(rows, start=2):
        p, issues = to_person(row)
        if p is None:
            out["skip"].append((i, issues))
            continue
        if p["chartNo"] in seen:
            out["skip"].append((i, ["파일 안에서 차트번호 중복"]))
            continue
        seen.add(p["chartNo"])
        if issues:
            out["issues"].append((i, p["chartNo"], issues))
        num = p.get("phones", {}).get("primaryPhoneNumber")
        if num:
            phone_count[num] = phone_count.get(num, 0) + 1
        have = existing.get(p["chartNo"])
        if not have:
            out["create"].append(p)
        else:
            diff = {k: v for k, v in p.items() if not same(have.get(k), v)}
            (out["update"] if diff else out["same"]).append((have["id"], diff))
    out["shared_phones"] = {n: c for n, c in phone_count.items() if c > 1}
    return out


def same(a, b):
    if isinstance(b, dict):
        return isinstance(a, dict) and all(same(a.get(k), v) for k, v in b.items())
    if isinstance(b, list):
        return (a or []) == b
    if isinstance(a, str) and isinstance(b, str) and len(b) == 10 and a[:10] == b:
        return True  # DATE는 2026-11-02T00:00:00Z로 돌아올 수 있다
    return a == b


def consent_record(person_id, now):
    return {"name": "광고성 정보 수신(업스트림 이관)", "consentType": "MARKETING", "granted": True, "noticeVersion": NOTICE,
            "collectedAt": now, "sourceUrl": "upstream-import", "personId": person_id}


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    apply = "--apply" in argv
    if not args:
        print(__doc__)
        return 1
    if not KEY:
        print("TWENTY_API_KEY가 필요합니다.", file=sys.stderr)
        return 1
    path = args[0]
    rows = read_xlsx(path) if path.lower().endswith(".xlsx") else read_csv(path)
    need = {"환자명", "차트번호"}
    if rows and not need <= set(rows[0]):
        print("열 이름이 다릅니다. 필요한 열:", ", ".join(sorted(need)), "/ 파일 열:", ", ".join(rows[0]), file=sys.stderr)
        return 1
    p = plan(rows, existing_by_chart())
    print(f"줄 {len(rows)} · 새로 만들기 {len(p['create'])} · 고치기 {len(p['update'])} · 그대로 {len(p['same'])} · 건너뜀 {len(p['skip'])}")
    print(f"여러 환자가 같이 쓰는 번호 {len(p['shared_phones'])}개(합치지 않음)")
    for i, chart, issues in p["issues"][:30]:
        print(f"  {i}행 차트 {chart}: {', '.join(issues)} → 그 칸은 비워 둠")
    for i, issues in p["skip"][:30]:
        print(f"  {i}행 건너뜀: {', '.join(issues)}")
    if not apply:
        print("미리보기만 했어요. 쓰려면 --apply를 붙여 다시 실행하세요.")
        return 0
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for body in p["create"]:
        created = rest("POST", "/people", body)["data"]
        pid = (created.get("createPerson") or next(iter(created.values())))["id"]
        if body.get("consentMarketing"):
            rest("POST", "/consentRecords", consent_record(pid, now))
    for pid, diff in p["update"]:
        rest("PATCH", f"/people/{pid}", diff)
    print("완료")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
