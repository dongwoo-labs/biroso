"""업스트림 예약·패키지 이력을 비로소 Twenty로 옮긴다(환자를 먼저 import_upstream_patients.py로 옮긴 뒤).

환자는 차트번호로 찾는다. 각 줄은 업스트림 ID(없으면 차트번호+일시로 만든 키)를 `upstreamId`(고유값)에 남겨서
여러 번 실행해도 같은 건을 두 번 만들지 않는다. 기본은 **리허설**(미리보기): 아무것도 쓰지 않고 건수·금액 대사 보고를 낸다.

사용(맥에서, 원본 파일은 밖으로 보내지 않는다):
  python3 import_upstream_history.py appointments 예약.xlsx                 # 리허설
  python3 import_upstream_history.py packages 패키지.xlsx --usage 사용내역.xlsx  # 리허설(사용내역은 있으면)
  ... --apply                                                             # 실제로 쓰기
  ... --report 보고.json                                                   # 대사 보고를 파일로(환자 이름·번호 없음)
환경: TWENTY_URL, TWENTY_API_KEY(관리자 키). 먼저 setup_clinic_objects.py를 실행해 upstreamId 필드를 만든다.

열 이름은 업스트림 화면·API 이름을 여러 개 받는다(ALIASES). 파일은 .xlsx, .csv, .json(평평한 객체 배열).
- 예약: 차트번호, 예약일시(또는 예약일+예약시간), 상태, 진료의, 예약경로, 초재진, 메모, 취소사유, 예약ID
- 패키지: 차트번호, 패키지명, 유형(횟수·정액), 총횟수/총액, 사용횟수/잔여횟수, 시작일, 만료일, 상태, 종료사유, 패키지ID
- 사용내역: 패키지ID, 사용내역ID, 진료일자, 차감횟수(정액형은 차감금액), 취소여부

패키지 잔여는 화면이 원장(packageEntry)으로 다시 계산하므로, 이관 때 원장을 같이 만든다:
사용내역 줄마다 '차감' 한 줄, 그리고 업스트림 잔여와 맞지 않는 차이는 '이관 전 사용' 한 줄로 맞춘다.
수납(매출)은 만들지 않는다(업스트림 매출과 이중 계상 방지).
"""
import hashlib, json, os, re, sys, urllib.parse
import datetime as dt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import import_upstream_patients as base  # noqa: E402

KST = dt.timezone(dt.timedelta(hours=9))

ALIASES = {
    "chart": ["차트번호", "차트", "chartNo"],
    "appt_id": ["예약ID", "예약Id", "예약번호", "appointmentId", "id"],
    "datetime": ["예약일시", "시작일시", "예약시작"],
    "date": ["예약일", "예약일자", "날짜", "진료일", "진료일자"],
    "time": ["예약시간", "시간", "시작시간"],
    "status": ["상태", "예약상태"],
    "doctor": ["진료의", "담당의", "의사", "담당원장"],
    "source": ["예약경로", "경로", "채널", "예약채널"],
    "method": ["진료방법", "진료유형", "진료방식"],
    "visit": ["초재진", "초진/재진", "초진재진", "진료구분"],
    "memo": ["메모", "예약메모"],
    "cancel": ["취소사유", "취소·노쇼 사유"],
    "pkg_id": ["환자비급여패키지Id", "패키지Id", "패키지ID", "packageId", "id"],
    "pkg_name": ["패키지명", "상품명", "처방명"],
    "kind": ["유형", "종류", "패키지유형"],
    "total_count": ["총횟수", "제공횟수"],
    "total_amount": ["총액", "총금액", "충전금액"],
    "used": ["사용횟수", "사용금액"],
    "remaining": ["잔여횟수", "잔여금액", "잔여"],
    "start": ["시작일시", "시작일", "구매일시", "구매일"],
    "end": ["만료일시", "만료일", "유효기간"],
    "ended": ["종료일시", "종료일"],
    "end_reason": ["종료사유"],
    "use_id": ["사용내역Id", "사용내역ID", "id"],
    "use_date": ["진료일자", "사용일", "생성일시", "사용일시"],
    "use_amount": ["차감횟수", "차감금액", "사용횟수", "금액"],
    "use_cancelled": ["취소여부"],
}


def col(row, key):
    for name in ALIASES[key]:
        v = row.get(name)
        if v not in (None, ""):
            return str(v).strip()
    return ""


def read(path):
    if path.lower().endswith(".json"):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        rows = data.get("results", data) if isinstance(data, dict) else data
        return [{k: ("" if v is None else str(v)) for k, v in r.items()} for r in rows]
    return base.read_xlsx(path) if path.lower().endswith(".xlsx") else base.read_csv(path)


def num(raw):
    s = (raw or "").replace(",", "").replace("원", "").replace("회", "").strip()
    try:
        return float(s) if s else None
    except ValueError:
        return None


def parse_dt(date_raw, time_raw=""):
    """'2026-11-03 14:30', '2026.11.3 오후 2:30', 날짜+'14:30', 엑셀 일련번호(45964.6041) → ISO(UTC). 시각이 없으면 None."""
    s = (date_raw or "").strip().replace("T", " ")
    if re.fullmatch(r"\d{5}\.\d+", s):  # 엑셀 날짜·시각 일련번호
        base_day = dt.datetime(1899, 12, 30, tzinfo=KST)
        when = base_day + dt.timedelta(days=float(s))
        when = when.replace(second=0, microsecond=0) + dt.timedelta(minutes=1 if when.second >= 30 else 0)
        return when.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    d = base.parse_date(s)
    if not d:
        return None
    t = (time_raw or "").strip() or s
    m = re.search(r"(\d{1,2}):(\d{2})", t)
    if not m:
        return None
    h, mi = int(m[1]), int(m[2])
    if ("오후" in t or "PM" in t.upper()) and h < 12:
        h += 12
    if ("오전" in t or "AM" in t.upper()) and h == 12:
        h = 0
    if h > 23 or mi > 59:
        return None
    return dt.datetime.fromisoformat(f"{d}T{h:02d}:{mi:02d}:00").replace(tzinfo=KST).astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def same(a, b):
    """Twenty가 돌려준 값과 비교(일시는 '...00.000Z'로 돌아온다)"""
    if isinstance(a, str) and isinstance(b, str) and a.endswith("Z") and b.endswith("Z") and len(b) > 10:
        try:
            return dt.datetime.fromisoformat(a.replace("Z", "+00:00")) == dt.datetime.fromisoformat(b.replace("Z", "+00:00"))
        except ValueError:
            pass
    return base.same(a, b)


def appt_status(raw, when, now):
    s = (raw or "").replace(" ", "")
    if "취소" in s:
        return "CANCELLED"
    if any(w in s for w in ("노쇼", "미내원", "부도", "불참")):
        return "NO_SHOW"
    if any(w in s for w in ("완료", "수납", "내원", "진료")):
        return "DONE"
    if any(w in s for w in ("요청", "신청")):
        return "REQUESTED"
    if any(w in s for w in ("확정", "예약", "접수")) or not s:
        # 지난 예약인데 완료 표시가 없으면 원무 기록이 없는 것 → 확인 필요
        return "CONFIRMED"
    return None


def appt_source(raw):
    s = raw or ""
    for word, v in (("네이버", "NAVER"), ("전화", "PHONE"), ("홈페이지", "HOMEPAGE"), ("온라인", "HOMEPAGE"), ("워크인", "WALKIN"), ("현장", "WALKIN")):
        if word in s:
            return v
    return "STAFF"


def short(x):
    """보고서에 남길 짧은 해시(차트번호 등 원값을 남기지 않음)"""
    return hashlib.sha256(str(x).encode()).hexdigest()[:10]


def plan_appointments(rows, people, members, existing, now):
    """예약 줄 → 만들기/고치기/건너뜀과 대사 보고. 화면 없이 테스트한다."""
    out = {"create": [], "update": [], "same": 0, "skip": [], "warn": [], "by_status": {}, "past_open": 0}
    seen = set()
    for i, row in enumerate(rows, start=2):
        chart = col(row, "chart")
        p = people.get(chart)
        when = parse_dt(col(row, "datetime") or col(row, "date"), col(row, "time"))
        if not chart or not p:
            out["skip"].append((i, "차트번호가 환자에 없음" if chart else "차트번호 없음"))
            continue
        if not when:
            out["skip"].append((i, "예약 일시를 읽지 못함"))
            continue
        status = appt_status(col(row, "status"), when, now)
        if not status:
            out["skip"].append((i, f"상태 '{col(row, 'status')}'"))
            continue
        uid = "upstream:appt:" + (col(row, "appt_id") or f"{chart}@{when}")
        if uid in seen:
            out["skip"].append((i, "파일 안에서 중복"))
            continue
        seen.add(uid)
        if status in ("CONFIRMED", "REQUESTED") and when < now:
            out["past_open"] += 1
        body = {
            "name": f"{when[:10]} 이관 예약",
            "customerId": p["id"],
            "scheduledAt": when,
            "appointmentStatus": status,
            "source": appt_source(col(row, "source")),
            "method": "PHONE" if "전화" in col(row, "method") + col(row, "visit") else "VISIT",
            "upstreamId": uid,
        }
        visit = col(row, "visit")
        if "초진" in visit:
            body["visitType"] = "NEW"
        elif "재진" in visit:
            body["visitType"] = "RETURN"
        doctor = col(row, "doctor")
        if doctor:
            mid = members.get(doctor.replace(" ", "").replace("원장", ""))
            if mid:
                body["doctorId"] = mid
            else:
                out["warn"].append((i, "진료의 이름이 직원에 없음 → 비워 둠"))
        for key, field in (("memo", "memo"), ("cancel", "cancelReason")):
            if col(row, key):
                body[field] = col(row, key)
        out["by_status"][status] = out["by_status"].get(status, 0) + 1
        have = existing.get(uid)
        if not have:
            out["create"].append(body)
        else:
            diff = {k: v for k, v in body.items() if k not in ("name",) and not same(have.get(k), v)}
            if diff:
                out["update"].append((have["id"], diff))
            else:
                out["same"] += 1
    return out


def plan_packages(rows, usage_rows, people, existing, existing_entries):
    """패키지 줄 → 환자 패키지 + 원장 줄. 잔여는 업스트림 값과 원장 합이 같게 맞춘다."""
    out = {"create": [], "same": 0, "skip": [], "warn": [], "entries": [], "totals": {"COUNT": [0, 0], "AMOUNT": [0, 0]}, "by_status": {}}
    uses = {}
    cancelled = 0
    for r in usage_rows or []:
        if base.parse_yes(col(r, "use_cancelled")):
            cancelled += 1
            continue
        uses.setdefault(col(r, "pkg_id"), []).append(r)
    out["usage_cancelled"] = cancelled
    seen = set()
    for i, row in enumerate(rows, start=2):
        chart = col(row, "chart")
        p = people.get(chart)
        if not chart or not p:
            out["skip"].append((i, "차트번호가 환자에 없음" if chart else "차트번호 없음"))
            continue
        kind = "AMOUNT" if "정액" in col(row, "kind") or "금액" in col(row, "kind") else "COUNT"
        total = num(col(row, "total_count") if kind == "COUNT" else col(row, "total_amount"))
        if total is None:
            total = num(col(row, "total_amount") if kind == "COUNT" else col(row, "total_count"))
        if total is None:
            out["skip"].append((i, "총횟수·총액 없음"))
            continue
        remaining = num(col(row, "remaining"))
        if remaining is None:
            used = num(col(row, "used"))
            remaining = total - used if used is not None else None
        if remaining is None:
            out["skip"].append((i, "잔여·사용 없음"))
            continue
        pkg_id = col(row, "pkg_id")
        uid = "upstream:pkg:" + (pkg_id or f"{chart}@{col(row, 'pkg_name')}@{col(row, 'start')}")
        if uid in seen:
            out["skip"].append((i, "파일 안에서 중복"))
            continue
        seen.add(uid)
        st = col(row, "status")
        status = "REFUNDED" if "환불" in st else "ENDED" if ("종료" in st or "만료" in st or col(row, "ended")) else "ACTIVE"
        out["by_status"][status] = out["by_status"].get(status, 0) + 1
        out["totals"][kind][0] += total
        out["totals"][kind][1] += remaining if status == "ACTIVE" else 0
        body = {
            "name": col(row, "pkg_name") or "이관 패키지",
            "customerId": p["id"],
            "kind": kind,
            "total": total,
            "remaining": remaining,
            "packageStatus": status,
            "upstreamId": uid,
        }
        for key, field in (("start", "startsOn"), ("end", "endsOn")):
            d = base.parse_date(col(row, key))
            if d:
                body[field] = d
        if col(row, "end_reason"):
            body["endReason"] = col(row, "end_reason")
        if remaining > total:
            out["warn"].append((i, "잔여가 총량보다 큼"))
        # 원장: 사용내역 + 차이 맞춤
        entries = []
        for u in uses.get(pkg_id, []) if pkg_id else []:
            amt = num(col(u, "use_amount"))
            if not amt:
                continue
            uuid = "upstream:use:" + (col(u, "use_id") or f"{pkg_id}@{col(u, 'use_date')}@{amt}")
            at = base.parse_date(col(u, "use_date"))
            entries.append({"name": "차감(이관)", "entryKind": "USE", "amount": amt, "upstreamId": uuid,
                            **({"at": f"{at}T03:00:00Z"} if at else {}), "memo": "업스트림 사용내역"})
        gap = (total - remaining) - sum(e["amount"] for e in entries)
        if gap:
            entries.append({"name": "이관 전 사용" if gap > 0 else "이관 차이 맞춤", "entryKind": "USE" if gap > 0 else "CANCEL",
                            "amount": abs(gap), "upstreamId": f"{uid}:gap", "memo": "업스트림 잔여에 맞춤"})
        have = existing.get(uid)
        if have:
            out["same"] += 1
            # 이미 옮긴 패키지는 고치지 않는다(이관 뒤 이 화면에서 차감했을 수 있음). 빠진 원장만 더한다
            out["entries"] += [(have["id"], e) for e in entries if e["upstreamId"] not in existing_entries]
        else:
            out["create"].append((body, entries))
    return out


# ---- Twenty ----

def list_all(plural, flt="", depth=0):
    out, cursor = [], ""
    while True:
        qs = f"?limit=60&depth={depth}" + (("&filter=" + urllib.parse.quote(flt)) if flt else "") + (f"&starting_after={cursor}" if cursor else "")
        r = base.rest("GET", f"/{plural}{qs}")
        out += r["data"][plural]
        if not r.get("pageInfo", {}).get("hasNextPage"):
            return out
        cursor = r["pageInfo"]["endCursor"]


def by_upstream(plural):
    return {x["upstreamId"]: x for x in list_all(plural, "upstreamId[is]:NOT_NULL") if x.get("upstreamId")}


def members():
    out = {}
    for m in list_all("workspaceMembers"):
        n = m.get("name") or {}
        full = f"{n.get('lastName', '')}{n.get('firstName', '')}".replace(" ", "")
        if full:
            out[full] = m["id"]
            out[full[1:]] = out.get(full[1:], m["id"])  # '정원장'처럼 성만 붙인 경우도
    return out


def report_of(kind, p, rows):
    rep = {"kind": kind, "rows": len(rows), "create": len(p["create"]), "same": p["same"], "skip": len(p["skip"]),
           "skip_reasons": {}, "warn": len(p["warn"]), "by_status": p["by_status"]}
    for _, why in p["skip"]:
        rep["skip_reasons"][why] = rep["skip_reasons"].get(why, 0) + 1
    if kind == "appointments":
        rep["update"] = len(p["update"])
        rep["past_open"] = p["past_open"]
    else:
        rep["totals"] = {k: {"total": v[0], "remaining_active": v[1]} for k, v in p["totals"].items()}
        rep["entries_new"] = sum(len(e) for _, e in p["create"]) + len(p["entries"])
        rep["usage_cancelled_skipped"] = p["usage_cancelled"]
    return rep


def main(argv):
    flags = {a for a in argv if a.startswith("--")}
    args = [a for a in argv if not a.startswith("--")]
    opt = lambda name: argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None
    args = [a for a in args if a not in (opt("--usage"), opt("--report"))]
    if len(args) < 2 or args[0] not in ("appointments", "packages"):
        print(__doc__)
        return 1
    if not base.KEY:
        print("TWENTY_API_KEY가 필요합니다.", file=sys.stderr)
        return 1
    kind, path = args[0], args[1]
    rows = read(path)
    people = base.existing_by_chart()
    now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    if kind == "appointments":
        p = plan_appointments(rows, people, members(), by_upstream("appointments"), now)
    else:
        usage = read(opt("--usage")) if opt("--usage") else []
        p = plan_packages(rows, usage, people, by_upstream("patientPackages"), set(by_upstream("packageEntries")))
    rep = report_of(kind, p, rows)
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    for i, why in (p["skip"] + p["warn"])[:30]:
        print(f"  {i}행: {why}")
    if opt("--report"):
        with open(opt("--report"), "w", encoding="utf-8") as f:
            json.dump({**rep, "at": now, "file_sha": short(open(path, "rb").read())}, f, ensure_ascii=False, indent=2)
    if "--apply" not in flags:
        print("리허설만 했어요(쓰지 않음). 대사 보고를 확인한 뒤 --apply로 다시 실행하세요.")
        return 0
    if kind == "appointments":
        for body in p["create"]:
            base.rest("POST", "/appointments", body)
        for aid, diff in p["update"]:
            base.rest("PATCH", f"/appointments/{aid}", diff)
    else:
        for body, entries in p["create"]:
            pkg = base.rest("POST", "/patientPackages", body)["data"]
            pid = (pkg.get("createPatientPackage") or next(iter(pkg.values())))["id"]
            for e in entries:
                base.rest("POST", "/packageEntries", {**e, "patientPackageId": pid})
        for pid, e in p["entries"]:
            base.rest("POST", "/packageEntries", {**e, "patientPackageId": pid})
    print("완료")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
