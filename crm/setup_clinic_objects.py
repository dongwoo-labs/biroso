"""비로소한의원 Twenty 워크스페이스에 홈페이지·주문·진료 예약 객체와 필드를 만든다.

렌탈ON과 개인정보처리자가 다르고(한의원) 건강정보(민감정보)를 다루므로 렌탈ON과 다른 워크스페이스에 만든다.
사용: TWENTY_URL=https://crm.example.kr TWENTY_API_KEY=<관리자 키> python3 setup_clinic_objects.py
이미 있는 객체·필드는 건너뛰므로 여러 번 실행해도 된다.
"""
import json, os, sys, urllib.parse, urllib.request

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


def rest(method, path, body=None):
    req = urllib.request.Request(
        URL + "/rest" + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json", "User-Agent": UA},
    )
    return json.load(urllib.request.urlopen(req))


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
                  ("DECOCTION", "탕약 수壽"), ("SKINCARE", "RATIOLOGY 화장품"), ("RESERVATION", "진료 예약"), ("ETC", "기타"))
# 게시판 값 ↔ 기존 주소(board/category-N). 주소는 검색·블로그 링크가 걸려 있어 그대로 쓴다.
BOARDS = opts(("NEWS", "비로소 소식담기"), ("COLUMN", "비로소 질환칼럼"), ("START", "비로소 시작하기"), ("HEALTH", "비로소 건강의학"),
              ("LOCATION", "비로소 오시는길"), ("HERBAL", "비로소 한약치료"), ("PHARMACOPUNCTURE", "비로소 약침치료"),
              ("BALANCE", "비로소 균형치료"), ("DIET", "비로소 다이어트"), ("IMMUNE", "비로소 면역치료"),
              ("SOOBLOG", "공진단 효능 및 복용 안내"))
# 주문 상태는 진료·결제 흐름만, 배송은 배송 상태에 따로 둔다(메디스트림 관리자와 같은 구조).
ORDER_STATUS = opts(("PENDING", "결제 대기"), ("PAID", "결제 완료·진료 대기"), ("CONSULTED", "진료 완료"), ("PRESCRIBED", "처방 확정·조제"),
                    ("DONE", "주문 완료"), ("CANCELLED", "주문 취소(결제 전)"), ("PARTIAL_REFUNDED", "부분 환불"), ("REFUNDED", "환불"))
SHIPPING_STATUS = opts(("WAITING", "진료 대기"), ("READY", "발송 준비"), ("SHIPPED", "배송 중"), ("DELIVERED", "수령 완료"),
                       ("PICKUP_READY", "방문 수령 준비"), ("PICKED_UP", "방문 수령 완료"), ("NOT_REQUIRED", "배송 없음"), ("CANCELLED", "배송 취소"))
DELIVERY_METHODS = opts(("PARCEL", "택배"), ("QUICK", "퀵·직접 배송"), ("PICKUP", "한의원 방문 수령"))
CARRIERS = opts(("CJ", "CJ대한통운"), ("EPOST", "우체국택배"), ("HANJIN", "한진택배"), ("LOTTE", "롯데택배"), ("LOGEN", "로젠택배"),
                ("KDEXP", "경동택배"), ("DAESIN", "대신택배"), ("ILYANG", "일양로지스"), ("CHUNIL", "천일택배"), ("KUNYOUNG", "건영택배"),
                ("HDEXP", "합동택배"), ("ETC", "기타"))
# 문진 선택지(메디스트림 기본 문진표와 같은 목록). 값은 server/schema.mjs, src/components/IntakeFields.astro와 같아야 한다.
DISEASES = opts(("NONE", "해당 없음"), ("HEART", "심장질환"), ("DIABETES", "당뇨병"), ("HYPERTENSION", "고혈압"), ("HEPATITIS", "간염(보균)"),
                ("NEURO_PSYCH", "신경정신질환"), ("RESPIRATORY", "호흡기계질환"), ("GASTRO", "위장관계질환"), ("OSTEOPOROSIS", "골다공증"),
                ("HAIR_LOSS", "탈모"), ("KIDNEY_URO", "신장 및 비뇨기과질환"), ("ATOPY", "아토피"), ("PROSTATE", "전립선질환"), ("OTHER", "기타"))
MEDS = opts(("NONE", "해당 없음"), ("ANTIDEPRESSANT", "우울증약"), ("ASTHMA", "천식약"), ("HYPERTENSION", "고혈압약"), ("THYROID", "갑상선약"),
            ("DIABETES", "당뇨약"), ("OTHER", "기타(두통약 등)"))

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
        # 수壽 상품은 수壽 본사 매장(thesoo.co/@biroso)에서 처방 신청·결제한다. 조제·배송·정산을 수壽가 맡기 때문이다.
        # 수壽 매장이면 상품 ID와 수량 옵션 이름(예: "30환 단품 【-15%】")을 넣는다. 빌드 때 수壽 공개 API에서 가격·판매 여부를 받아 온다.
        ("salesChannel", "SELECT", "판매 경로", {"options": opts(("OWN", "비로소 결제"), ("SOO_STORE", "수壽 매장")), "defaultValue": "'OWN'"}),
        ("sooProductId", "TEXT", "수壽 상품 ID", {}),
        ("sooOption", "TEXT", "수壽 수량 옵션", {}),
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
        ("shippingStatus", "SELECT", "배송 상태", {"options": SHIPPING_STATUS, "defaultValue": "'WAITING'"}),
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
        ("deliveryMethod", "SELECT", "수령 방식", {"options": DELIVERY_METHODS, "defaultValue": "'PARCEL'"}),
        ("consultTime", "TEXT", "희망 상담 시간", {}),
        ("carrier", "SELECT", "택배사", {"options": CARRIERS}),
        ("trackingNo", "TEXT", "송장번호(여러 개면 쉼표로)", {}),
        ("shippedAt", "DATE_TIME", "발송 일시", {}),
        # 환불한 금액의 합. 부분 환불이 쌓이면 남은 금액(결제 금액 - 환불 금액)만 더 환불할 수 있다.
        ("refundedAmount", "CURRENCY", "환불 금액(누적)", {}),
        ("cancelReason", "TEXT", "취소 사유", {}),
        ("cancelledAt", "DATE_TIME", "취소 일시", {}),
    ]),
    # 진료 예약(전화 진료·내원 진료). 이름은 예약 요약(예: "10/30 14:00 전화 · 다이어트 처방 상담").
    ("appointment", "appointments", "진료 예약", "진료 예약", "IconCalendarEvent", [
        ("customer", "RELATION", "환자", {"target": "person", "inverse": "appointments", "inverseLabel": "진료 예약"}),
        ("product", "RELATION", "진료 상품", {"target": "product", "inverse": "appointments", "inverseLabel": "진료 예약"}),
        ("method", "SELECT", "진료 방법", {"options": opts(("PHONE", "전화 진료"), ("VISIT", "한의원 진료"))}),
        ("scheduledAt", "DATE_TIME", "예약 일시", {}),
        # 예약 자리 키(<예약 시각>#<번호>). 고유값이라 같은 자리를 동시에 두 번 잡지 못한다. 홈페이지가 채우니 직원은 비워 둔다.
        ("slotKey", "TEXT", "예약 자리(자동)", {"isUnique": True}),
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
        ("diseases", "MULTI_SELECT", "질병 경험", {"options": DISEASES}),
        ("conditions", "TEXT", "질병 기타·수술력", {}),
        ("recentMeds", "MULTI_SELECT", "최근 한 달 복용 약", {"options": MEDS}),
        ("medications", "TEXT", "복용 약 기타(약 이름)", {}),
        ("allergies", "TEXT", "알레르기·약 부작용", {}),
        ("dietHistory", "TEXT", "다이어트 한약 복용 경험", {}),
        ("symptoms", "TEXT", "불편한 증상·상담 내용", {}),
        ("purgeAfter", "DATE", "파기 예정일", {}),
    ]),
    # 빠른 상담: 이름·휴대폰만 받는 전화 상담 신청. 이름은 "<신청자> 빠른 상담". 파기 예정일이 지나면 자동으로 지운다.
    ("consultRequest", "consultRequests", "빠른 상담", "빠른 상담", "IconPhoneCall", [
        ("customer", "RELATION", "신청자", {"target": "person", "inverse": "consultRequests", "inverseLabel": "빠른 상담"}),
        ("interest", "TEXT", "관심 진료", {}),
        ("consultStatus", "SELECT", "상담 상태", {"options": opts(("WAITING", "상담 대기"), ("DONE", "상담 완료")), "defaultValue": "'WAITING'"}),
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
                                                          ("TERMS", "구매 조건·약관(필수)"), ("DOSAGE", "복용 방법·주의사항 확인(필수)"),
                                                          ("MARKETING", "광고성 정보 수신(선택)"))}),
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
    wanted = {(sing, n): e["options"] for sing, *_, fs in OBJECTS for n, t, _, e in fs if t in ("SELECT", "MULTI_SELECT")}
    wanted.update({("person", n): e["options"] for n, t, _, e in PERSON_FIELDS if t in ("SELECT", "MULTI_SELECT")})
    for (sing, name), options in wanted.items():
        for f in fields_by_obj.get(sing, []):
            if f["name"] == name and f.get("options") is not None:
                have = {(o["value"], o["label"]) for o in f["options"]}
                if have != {(o["value"], o["label"]) for o in options}:
                    gql("mutation($i:UpdateOneFieldMetadataInput!){updateOneField(input:$i){id}}",
                        {"i": {"id": f["id"], "update": {"options": options}}})
                    print("  선택지 갱신:", sing, name)


def sync_labels(fields_by_obj):
    """라벨을 바꾼 필드는 Twenty에도 반영한다."""
    for sing, *_, specs in OBJECTS:
        for name, _, label, _ in specs:
            for f in fields_by_obj.get(sing, []):
                if f["name"] == name and f["label"] != label:
                    gql("mutation($i:UpdateOneFieldMetadataInput!){updateOneField(input:$i){id}}",
                        {"i": {"id": f["id"], "update": {"label": label}}})
                    print("  라벨 변경:", sing, name, "->", label)


def list_all(plural, flt):
    out, cursor = [], ""
    while True:
        qs = "?limit=60&filter=" + urllib.parse.quote(flt) + (f"&starting_after={cursor}" if cursor else "")
        r = rest("GET", f"/{plural}{qs}")
        out += r["data"][plural]
        if not r.get("pageInfo", {}).get("hasNextPage"):
            return out
        cursor = r["pageInfo"]["endCursor"]


def migrate_orders(fields_by_obj):
    """주문 상태 하나(발송·수령 완료 포함)로 쓰던 주문을 주문 상태 + 배송 상태 + 수령 방식으로 옮긴다.
    옛 '한의원 방문 수령'(pickup) 필드는 수령 방식으로 옮긴 뒤 지운다. 여러 번 실행해도 된다."""
    names = {f["name"]: f for f in fields_by_obj.get("clinicOrder", [])}
    legacy = names.get("pickup")
    # 새 필드는 기본값(진료 대기·택배)으로 채워지므로, 이미 끝난 주문과 방문 수령 주문만 고친다
    done = 'and(shippingStatus[eq]:"WAITING",orderStatus[in]:["SHIPPED","DONE","CANCELLED","REFUNDED"])'
    for o in list_all("clinicOrders", done):
        pickup = bool(o.get("pickup"))
        status = o.get("orderStatus")
        ship = {"SHIPPED": "SHIPPED", "DONE": "PICKED_UP" if pickup else "DELIVERED", "CANCELLED": "CANCELLED", "REFUNDED": "CANCELLED"}.get(status, "WAITING")
        patch = {"shippingStatus": ship, "deliveryMethod": "PICKUP" if pickup else "PARCEL"}
        if status == "SHIPPED":
            patch["orderStatus"] = "PRESCRIBED"
        rest("PATCH", f"/clinicOrders/{o['id']}", patch)
        print("  주문 옮김:", o.get("name"), status, "->", patch)
    if legacy:
        for o in list_all("clinicOrders", "pickup[eq]:true"):
            if o.get("deliveryMethod") != "PICKUP":
                rest("PATCH", f"/clinicOrders/{o['id']}", {"deliveryMethod": "PICKUP"})
        gql("mutation($i:UpdateOneFieldMetadataInput!){updateOneField(input:$i){id}}", {"i": {"id": legacy["id"], "update": {"isActive": False}}})
        gql("mutation($i:DeleteOneFieldInput!){deleteOneField(input:$i){id}}", {"i": {"id": legacy["id"]}})
        print("  옛 필드 삭제: clinicOrder pickup")


def create_field(obj_id, name, ftype, label, extra, ids):
    field = {"objectMetadataId": obj_id, "type": ftype, "name": name, "label": label}
    if "options" in extra:
        field["options"] = extra["options"]
    if "defaultValue" in extra:
        field["defaultValue"] = extra["defaultValue"]
    if extra.get("isUnique"):
        field["isUnique"] = True
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
    detail = objects(detail=True)
    # 배송 상태를 먼저 채운 뒤 주문 상태 선택지(발송·수령 완료 제거)를 바꾼다
    sync_select_options({k: v for k, v in detail.items() if k != "clinicOrder"} | {"clinicOrder": [f for f in detail["clinicOrder"] if f["name"] != "orderStatus"]})
    migrate_orders(detail)
    sync_select_options(objects(detail=True))
    sync_labels(objects(detail=True))
    print("완료")


if __name__ == "__main__":
    sys.exit(main())
