"""기존 사이트에서 옮겨 온 콘텐츠(src/data/*.json)를 Twenty로 넣는다: 상품, 이벤트, 글, 자주 묻는 질문, 휴진일.

사용: TWENTY_URL=... TWENTY_API_KEY=<관리자 키> SITE_URL=https://biroso.vercel.app python3 seed_content.py
처음 한 번만 쓰는 스크립트다. 이후에는 Twenty 화면에서 고친다. 주소(slug)나 이름이 같은 레코드가 있으면 건너뛴다.
그림 주소는 SITE_URL을 붙인 절대 주소로 넣는다(Twenty 화면에서도 보이도록). 홈페이지 빌드가 다시 사이트 경로로 바꾼다.
"""
import json, os, pathlib, re, sys, urllib.parse, urllib.request
from setup_clinic_objects import KEY, UA, URL

SITE = os.environ.get("SITE_URL", "https://biroso.vercel.app").rstrip("/")
DATA = pathlib.Path(__file__).resolve().parent.parent / "src/data"


def rest(method, path, body=None):
    req = urllib.request.Request(
        URL + "/rest" + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json", "User-Agent": UA},
    )
    return json.load(urllib.request.urlopen(req))


def won(n):
    return None if n is None else {"amountMicros": int(n) * 1_000_000, "currencyCode": "KRW"}


def link(path):
    if not path:
        return {"primaryLinkUrl": "", "primaryLinkLabel": "", "secondaryLinks": []}
    return {"primaryLinkUrl": SITE + path if path.startswith("/") else path, "primaryLinkLabel": "", "secondaryLinks": []}


def absolute(md):
    """본문 속 /media/… 그림을 절대 주소로"""
    return re.sub(r"\]\((/media/[^)\s]+)\)", lambda m: f"]({SITE}{m.group(1)})", md or "")


def exists(plural, field, value):
    q = urllib.parse.quote(f'{field}[eq]:"{value}"')
    return rest("GET", f"/{plural}?limit=1&filter={q}")["data"][plural]


def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))["items"]


def main():
    for i, p in enumerate(load("products.json")):
        if exists("products", "slug", p["slug"]):
            print("있음:", p["name"]); continue
        rest("POST", "/products", {
            "name": p["name"], "kind": p["kind"], "category": p["category"], "slug": p["slug"], "title": p.get("title") or "",
            "summary": p.get("summary") or "", "body": {"markdown": absolute(p.get("body")), "blocknote": None},
            "regularPrice": won(p["regularPrice"]), "salePrice": won(p["salePrice"]), "soldOut": p["soldOut"], "taxFree": p["taxFree"],
            "freeShipping": p["freeShipping"], "telemedicine": p["telemedicine"], "inPerson": p["inPerson"],
            "attributes": p.get("attributes") or "", "imageUrl": link(p.get("image")),
            "gallery": "\n".join(SITE + g if g.startswith("/") else g for g in p.get("images", [])[1:]),
            "published": p["published"], "sortOrder": (i + 1) * 10,
        })
        print("상품:", p["name"])
    for i, e in enumerate(load("events.json")):
        if exists("clinicEvents", "slug", e["slug"]):
            print("있음:", e["name"]); continue
        rest("POST", "/clinicEvents", {
            "name": e["name"], "slug": e["slug"], "subtitle": e.get("subtitle") or "", "summary": e.get("summary") or "",
            "body": {"markdown": absolute(e.get("body")), "blocknote": None}, "imageUrl": link(e.get("image")),
            "startDate": e.get("startDate"), "endDate": e.get("endDate"), "published": True, "sortOrder": (i + 1) * 10,
        })
        print("이벤트:", e["name"])
    for i, p in enumerate(load("posts.json")):
        if exists("posts", "slug", p["slug"]):
            print("있음:", p["name"]); continue
        rest("POST", "/posts", {
            "name": p["name"], "board": p["board"], "slug": p["slug"], "summary": p.get("summary") or "",
            "body": {"markdown": absolute(p.get("body")), "blocknote": None}, "imageUrl": link(p.get("image")),
            "publishedOn": p.get("publishedAt") or None, "published": True, "sortOrder": p.get("sortOrder") or 0,
        })
        print("글:", p["name"])
    for i, f in enumerate(load("faqs.json")):
        if exists("faqs", "name", f["name"]):
            print("있음:", f["name"]); continue
        rest("POST", "/faqs", {"name": f["name"], "answer": f["answer"], "published": True, "sortOrder": (i + 1) * 10})
        print("FAQ:", f["name"])
    clinic = json.loads((DATA / "clinic.json").read_text(encoding="utf-8"))
    for d in clinic.get("holidays", []):
        if exists("closures", "date", d):
            continue
        rest("POST", "/closures", {"name": "휴진", "date": d})
        print("휴진일:", d)
    print("완료")


if __name__ == "__main__":
    sys.exit(main())
