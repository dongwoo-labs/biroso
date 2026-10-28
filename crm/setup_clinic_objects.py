"""비로소한의원 Twenty 워크스페이스에 홈페이지·주문·진료 예약 객체와 필드를 만든다.

렌탈ON과 개인정보처리자가 다르고(한의원) 건강정보(민감정보)를 다루므로 렌탈ON과 다른 워크스페이스에 만든다.
사용: TWENTY_URL=https://crm.example.kr TWENTY_API_KEY=<관리자 키> python3 setup_clinic_objects.py
이미 있는 객체·필드는 건너뛰므로 여러 번 실행해도 된다.
"""
import json, os, sys, urllib.request

URL = os.environ.get("TWENTY_URL", "http://localhost:3000").rstrip("/")
KEY = os.environ.get("TWENTY_API_KEY", "")
# Twenty Cloud(Cloudflare)는 urllib 기본 User-Agent를 막는다(오류 1010)
UA = "biroso-setup/1.0"


def gql(query, variables=None):
    req = urllib.request.Request(
        URL + "/metadata",
        data=json.dumps({"query": query, "variables": variables or {}}).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json", "User-Agent": UA},
    )
    out = json.load(urllib.request.urlopen(req))
    if out.get("errors"):
        raise RuntimeError(out["errors"][0]["message"])
    return out["data"]


def objects(detail=False):
    d = gql("{objects(paging:{first:200}){edges{node{id nameSingular fields(paging:{first:200}){edges{node{id name label type options}}}}}}}")
    if detail:
        return {e["node"]["nameSingular"]: [f["node"] for f in e["node"]["fields"]["edges"]] for e in d["objects"]["edges"]}
    return {e["node"]["nameSingular"]: (e["node"]["id"], {f["node"]["name"] for f in e["node"]["fields"]["edges"]})
            for e in d["objects"]["edges"]}


def opts(*pairs):
    colors = ["blue", "green", "orange", "red", "purple", "sky", "turquoise", "yellow", "gray", "pink"]
    return [{"value": v, "label": l, "color": colors[i % len(colors)], "position": i} for i, (v, l) in enumerate(pairs)]


# 값은 홈페이지 코드(src/lib/content.ts, server/*.mjs)와 같아야 한다
KINDS = opts(("PAYMENT", "원내 상품(결제)"), ("RESERVATION", "진료 예약"))
CATEGORIES = opts(("DIET", "비로소 다이어트"), ("GONGJINDAN", "공진단 수壽"), ("GYEONGOKGO", "경옥고 수壽"), ("UHWANG", "우황청심원 수壽"),
                  ("DECOCTION", "탕약 수壽"), ("RESERVATION", "진료 예약"), ("ETC", "기타"))
# 게시판 값 ↔ 기존 주소(board/category-N). 주소는 검색·블로그 링크가 걸려 있어 그대로 쓴다.
BOARDS = opts(("NEWS", "비로소 소식담기"), ("COLUMN", "비로소 질환칼럼"), ("START", "비로소 시작하기"), ("HEALTH", "비로소 건강의학"),
              ("LOCATION", "비로소 오시는길"), ("HERBAL", "비로소 한약치료"), ("PHARMACOPUNCTURE", "비로소 약침치료"),
              ("BALANCE", "비로소 균형치료"), ("DIET", "비로소 다이어트"), ("IMMUNE", "비로소 면역치료"))
ORDER_STATUS = opts(("PENDING", "결제 대기"), ("PAID", "결제 완료·진료 대기"), ("CONSULTED", "진료 완료"), ("PRESCRIBED", "처방 확정·조제"),
                    ("SHIPPED", "발송"), ("DONE", "수령 완료"), ("CANCELLED", "주문 취소(결제 전)"), ("REFUNDED", "환불"))

# (nameSingular, namePlural, 단수 라벨, 복수 라벨, 아이콘, [필드...])
# 필드: (name, type, label, extra)  extra에 options/defaultValue/relation 대상
OBJECTS = [
    # 원내 상품(결제형)과 진료 예약 상품(예약형). 이름은 기본 name 필드. 홈페이지는 배포할 때 노출=예인 것만 읽는다.
    ("product", "products", "상품", "상품", "IconPackage", [
        ("kind", "SELECT", "종류", {"options": KINDS, "defaultValue": "'PAYMENT'"}),
        ("category", "SELECT", "분류", {"options": CATEGORIES}),
        # 상품 주소(/telemedicine/<주소>). 옮겨 온 상품은 기존 사이트 주소를 그대로 쓴다. 비우면 레코드 ID.
        ("slug", "TEXT", "주소(영문·숫자)", {}),
        ("title", "TEXT", "상세 제목", {}),
        ("summary", "TEXT", "한 줄 설명", {}),
        ("body", "RICH_TEXT_V2", "상세 설명", {}),
        ("regularPrice", "CURRENCY", "정가", {}),
        ("salePrice", "CURRENCY", "판매가", {}),
        ("soldOut", "BOOLEAN", "품절", {"defaultValue": False}),
        # 한약(의약품)은 부가세 면세다. 결제 요청 때 면세 금액으로 보낸다.
        ("taxFree", "BOOLEAN", "면세", {"defaultValue": True}),
        ("freeShipping", "BOOLEAN", "무료 배송", {"defaultValue": False}),
        ("telemedicine", "BOOLEAN", "전화 진료 가능", {"defaultValue": False}),
        ("inPerson", "BOOLEAN", "내원 진료 가능", {"defaultValue": True}),
        # 상세 페이지 가격 아래 표. 한 줄에 "항목: 값"(예: 주요 성분: 마황 / 맥문동)
        ("attributes", "TEXT", "상품 정보", {}),
        ("imageUrl", "LINKS", "대표 그림", {}),
        ("gallery", "TEXT", "추가 그림 주소(한 줄에 하나)", {}),
        ("published", "BOOLEAN", "홈페이지 노출", {"defaultValue": False}),
        ("sortOrder", "NUMBER", "노출 순서", {}),
    ]),
    # 원내 상품 주문. 주문번호는 name. 금액은 주문 API가 Twenty 상품 가격으로 다시 계산해 넣는다(화면 값을 믿지 않는다).
    ("clinicOrder", "clinicOrders", "주문", "주문", "IconShoppingCart", [
        ("orderStatus", "SELECT", "주문 상태", {"options": ORDER_STATUS, "defaultValue": "'PENDING'"}),
        ("customer", "RELATION", "주문자", {"target": "person", "inverse": "clinicOrders", "inverseLabel": "주문"}),
        ("itemsSummary", "TEXT", "주문 상품", {}),
        ("items", "RAW_JSON", "주문 상품(상세)", {}),
        ("itemsAmount", "CURRENCY", "상품 금액", {}),
        ("shippingFee", "CURRENCY", "배송비", {}),
        ("totalAmount", "CURRENCY", "결제 금액", {}),
        ("taxFreeAmount", "CURRENCY", "면세 금액", {}),
        ("payMethod", "SELECT", "결제 수단", {"options": opts(("CARD", "신용카드"), ("KAKAOPAY", "카카오페이"), ("NAVERPAY", "네이버페이"), ("BANK", "계좌이체"))}),
        ("pgTid", "TEXT", "PG 거래번호", {}),
        ("paidAt", "DATE_TIME", "결제 일시", {}),
        ("receiptUrl", "LINKS", "매출전표", {}),
        ("recipientName", "TEXT", "받는 분", {}),
        ("recipientPhone", "PHONES", "받는 분 연락처", {}),
        ("shippingAddress", "ADDRESS", "배송지", {}),
        ("deliveryMemo", "TEXT", "배송 메모", {}),
        ("pickup", "BOOLEAN", "한의원 방문 수령", {"defaultValue": False}),
        ("consultTime", "TEXT", "희망 상담 시간", {}),
        ("trackingNo", "TEXT", "송장번호", {}),
        ("cancelReason", "TEXT", "취소 사유", {}),
        ("cancelledAt", "DATE_TIME", "취소 일시", {}),
    ]),
    # 진료 예약(전화 진료·내원 진료). 이름은 예약 요약(예: "10/30 14:00 전화 · 다이어트 처방 상담").
    ("appointment", "appointments", "진료 예약", "진료 예약", "IconCalendarEvent", [
        ("customer", "RELATION", "환자", {"target": "person", "inverse": "appointments", "inverseLabel": "진료 예약"}),
        ("product", "RELATION", "진료 상품", {"target": "product", "inverse": "appointments", "inverseLabel": "진료 예약"}),
        ("method", "SELECT", "진료 방법", {"options": opts(("PHONE", "전화 진료"), ("VISIT", "한의원 진료"))}),
        ("scheduledAt", "DATE_TIME", "예약 일시", {}),
        ("appointmentStatus", "SELECT", "예약 상태", {"options": opts(("REQUESTED", "예약 신청"), ("CONFIRMED", "확정"), ("DONE", "진료 완료"), ("NO_SHOW", "노쇼"), ("CANCELLED", "취소")), "defaultValue": "'REQUESTED'"}),
    ]),
    # 문진(건강정보 = 개인정보보호법 제23조 민감정보). 고객·주문과 따로 둬서 역할로 열람을 막을 수 있게 한다.
    ("intake", "intakes", "문진", "문진", "IconStethoscope", [
        ("customer", "RELATION", "환자", {"target": "person", "inverse": "intakes", "inverseLabel": "문진"}),
        ("clinicOrder", "RELATION", "주문", {"target": "clinicOrder", "inverse": "intakes", "inverseLabel": "문진"}),
        ("appointment", "RELATION", "진료 예약", {"target": "appointment", "inverse": "intakes", "inverseLabel": "문진"}),
        ("sex", "SELECT", "성별", {"options": opts(("F", "여성"), ("M", "남성"))}),
        ("birthYear", "NUMBER", "출생 연도", {}),
        ("heightCm", "NUMBER", "키(cm)", {}),
        ("weightKg", "NUMBER", "몸무게(kg)", {}),
        ("pregnancy", "SELECT", "임신·수유", {"options": opts(("NONE", "해당 없음"), ("PREGNANT", "임신 중"), ("NURSING", "수유 중"), ("PLANNING", "임신 계획 있음"))}),
        ("medications", "TEXT", "복용 중인 약", {}),
        ("conditions", "TEXT", "앓는 질환·수술력", {}),
        ("allergies", "TEXT", "알레르기·약 부작용", {}),
        ("dietHistory", "TEXT", "다이어트 한약 복용 경험", {}),
        ("symptoms", "TEXT", "불편한 증상·상담 내용", {}),
        ("purgeAfter", "DATE", "파기 예정일", {}),
    ]),
    ("clinicEvent", "clinicEvents", "이벤트", "이벤트", "IconGift", [
        ("slug", "TEXT", "주소(영문·숫자)", {}),
        ("subtitle", "TEXT", "부제", {}),
        ("summary", "TEXT", "요약", {}),
        ("body", "RICH_TEXT_V2", "본문", {}),
        ("imageUrl", "LINKS", "대표 그림", {}),
        ("startDate", "DATE", "시작일", {}),
        ("endDate", "DATE", "종료일", {}),
        ("published", "BOOLEAN", "홈페이지 노출", {"defaultValue": False}),
        ("sortOrder", "NUMBER", "노출 순서", {}),
    ]),
    # 게시판 글(소식·칼럼·진료 안내). 제목은 name.
    ("post", "posts", "글", "글", "IconArticle", [
        ("board", "SELECT", "게시판", {"options": BOARDS}),
        ("slug", "TEXT", "주소(영문·숫자)", {}),
        ("summary", "TEXT", "요약", {}),
        ("body", "RICH_TEXT_V2", "본문", {}),
        ("imageUrl", "LINKS", "대표 그림", {}),
        ("publishedOn", "DATE", "게시일", {}),
        ("published", "BOOLEAN", "홈페이지 노출", {"defaultValue": False}),
        ("sortOrder", "NUMBER", "노출 순서", {}),
    ]),
    ("faq", "faqs", "자주 묻는 질문", "자주 묻는 질문", "IconHelp", [
        ("answer", "TEXT", "답변", {}),
        ("published", "BOOLEAN", "홈페이지 노출", {"defaultValue": False}),
        ("sortOrder", "NUMBER", "노출 순서", {}),
    ]),
    # 휴진일(명절·임시 휴진). 일요일은 매주 휴진이라 넣지 않는다. 진료 예약 화면에서 이 날을 막는다.
    ("closure", "closures", "휴진일", "휴진일", "IconCalendarOff", [
        ("date", "DATE", "날짜", {}),
    ]),
    ("consentRecord", "consentRecords", "동의기록", "동의원장", "IconShieldCheck", [
        ("consentType", "SELECT", "동의 항목", {"options": opts(("PRIVACY", "개인정보 수집·이용(필수)"), ("SENSITIVE", "건강정보 수집·이용(필수)"),
                                                          ("TERMS", "구매 조건·약관(필수)"), ("MARKETING", "광고성 정보 수신(선택)"))}),
        ("granted", "BOOLEAN", "동의 여부", {"defaultValue": False}),
        ("noticeVersion", "TEXT", "동의문 버전", {}),
        ("collectedAt", "DATE_TIME", "수집 일시", {}),
        ("collectedIp", "TEXT", "수집 IP", {}),
        ("sourceUrl", "TEXT", "수집 페이지", {}),
        ("withdrawnAt", "DATE_TIME", "철회 일시", {}),
        ("person", "RELATION", "고객", {"target": "person", "inverse": "consentRecords", "inverseLabel": "동의기록"}),
    ]),
]

# 기존 person(환자·주문자)에 붙일 필드. 유입 경로 값은 server/channel.mjs의 CHANNELS와 같다.
PERSON_FIELDS = [
    ("utmSource", "TEXT", "utm_source", {}), ("utmMedium", "TEXT", "utm_medium", {}),
    ("utmCampaign", "TEXT", "utm_campaign", {}), ("utmContent", "TEXT", "utm_content", {}),
    ("utmTerm", "TEXT", "utm_term", {}), ("landingPage", "TEXT", "첫 랜딩 URL", {}),
    ("clickId", "TEXT", "광고 클릭 ID", {}),
    ("acquisitionChannel", "SELECT", "유입 경로", {"options": opts(
        ("AD", "유료 광고"), ("NAVER_SEARCH", "네이버 검색"), ("GOOGLE_SEARCH", "구글 검색"),
        ("OTHER_SEARCH", "기타 검색(다음·빙 등)"), ("COMMUNITY", "블로그·카페"), ("SOCIAL", "SNS"),
        ("MESSAGE", "문자·카카오톡"), ("OFFLINE", "전단·QR"), ("CAMPAIGN", "기타 홍보 링크"),
        ("REFERRAL", "다른 사이트"), ("DIRECT", "직접 방문"))}),
    ("referrer", "TEXT", "이전 사이트", {}),
    ("searchKeyword", "TEXT", "검색어", {}),
    ("consentMarketing", "BOOLEAN", "광고 수신 동의", {"defaultValue": False}),
]


def fix_inverse_names():
    """Twenty는 역방향 필드 이름을 한글 라벨에서 음차(예: munjin)로 만든다. 영문 이름으로 바꾼다."""
    fields = objects(detail=True)
    for _, *_, specs in OBJECTS:
        for _, ftype, _, extra in specs:
            if ftype != "RELATION":
                continue
            for f in fields[extra["target"]]:
                if f["type"] == "RELATION" and f["label"] == extra["inverseLabel"] and f["name"] != extra["inverse"]:
                    gql("mutation($i:UpdateOneFieldMetadataInput!){updateOneField(input:$i){id}}",
                        {"i": {"id": f["id"], "update": {"name": extra["inverse"], "isLabelSyncedWithName": False}}})
                    print("  역방향 이름 변경:", extra["target"], f["name"], "->", extra["inverse"])


def sync_select_options(fields_by_obj):
    """이미 있는 SELECT 필드에 새 선택지가 추가됐으면 반영한다."""
    wanted = {(sing, n): e["options"] for sing, *_, fs in OBJECTS for n, t, _, e in fs if t == "SELECT"}
    wanted.update({("person", n): e["options"] for n, t, _, e in PERSON_FIELDS if t == "SELECT"})
    for (sing, name), options in wanted.items():
        for f in fields_by_obj.get(sing, []):
            if f["name"] == name and f.get("options") is not None:
                have = {o["value"] for o in f["options"]}
                if not {o["value"] for o in options} <= have:
                    gql("mutation($i:UpdateOneFieldMetadataInput!){updateOneField(input:$i){id}}",
                        {"i": {"id": f["id"], "update": {"options": options}}})
                    print("  선택지 갱신:", sing, name)


def create_field(obj_id, name, ftype, label, extra, ids):
    field = {"objectMetadataId": obj_id, "type": ftype, "name": name, "label": label}
    if "options" in extra:
        field["options"] = extra["options"]
    if "defaultValue" in extra:
        field["defaultValue"] = extra["defaultValue"]
    if ftype == "RELATION":
        field["relationCreationPayload"] = {
            "type": "MANY_TO_ONE", "targetObjectMetadataId": ids[extra["target"]][0],
            "targetFieldLabel": extra["inverseLabel"], "targetFieldIcon": "IconLink",
        }
    gql("mutation($f:CreateFieldInput!){createOneField(input:{field:$f}){id}}", {"f": field})


def main():
    if not KEY:
        print("TWENTY_API_KEY가 필요합니다.", file=sys.stderr)
        return 1
    ids = objects()
    for sing, plur, ls, lp, icon, _ in OBJECTS:
        if sing not in ids:
            gql("mutation($o:CreateObjectInput!){createOneObject(input:{object:$o}){id}}",
                {"o": {"nameSingular": sing, "namePlural": plur, "labelSingular": ls, "labelPlural": lp, "icon": icon}})
            print("객체 생성:", ls)
    ids = objects()
    for sing, *_, fields in OBJECTS:
        for name, ftype, label, extra in fields:
            if name not in ids[sing][1]:
                create_field(ids[sing][0], name, ftype, label, extra, ids)
                print("  필드 생성:", sing, name)
                ids = objects()
    for name, ftype, label, extra in PERSON_FIELDS:
        if name not in ids["person"][1]:
            create_field(ids["person"][0], name, ftype, label, extra, ids)
            print("  필드 생성: person", name)
    fix_inverse_names()
    sync_select_options(objects(detail=True))
    print("완료")


if __name__ == "__main__":
    sys.exit(main())
