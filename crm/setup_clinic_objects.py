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

# 예약 상태는 원무 흐름까지 이어진다. 값은 crm console(src/industries/clinic.ts)과 같아야 한다.
APPT_STATUS = opts(("REQUESTED", "예약 신청"), ("CONFIRMED", "확정"), ("ARRIVED", "도착·대기"), ("IN_ROOM", "진료 중"),
                   ("TREATED", "수납 대기"), ("DONE", "완료"), ("NO_SHOW", "노쇼"), ("CANCELLED", "취소"))
APPT_SOURCES = opts(("HOMEPAGE", "홈페이지"), ("PHONE", "전화"), ("NAVER", "네이버 예약"), ("WALKIN", "워크인"), ("STAFF", "직원 등록"))

# 발송. 값은 crm services/messenger, console(src/industries/messages.ts)과 같아야 한다(렌탈ON과 같은 모양).
MSG_CHANNELS = opts(("ALIMTALK", "알림톡(실패하면 문자)"), ("SMS", "문자"))
MSG_STATUS = opts(("QUEUED", "대기"), ("SENDING", "보내는 중"), ("SENT", "보냄"), ("FAILED", "실패"), ("SKIPPED", "안 보냄(동의·연락 그만)"), ("CANCELLED", "취소"))
MSG_TYPES = opts(("ATA", "알림톡"), ("SMS", "문자"), ("LMS", "장문 문자"))

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
        ("body", "RICH_TEXT", "상세 설명", {}),
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
    # 예약 한 건 = 내원 한 번. 원무(도착→진료→치료 끝→수납)도 이 레코드의 상태로 진행한다(업스트림 원무 보드 대체).
    # 홈페이지 예약·전화 예약·워크인 모두 여기에 쌓이고, 취소가 아닌 예약은 홈페이지 예약 칸을 막는다.
    ("appointment", "appointments", "진료 예약", "진료 예약", "IconCalendarEvent", [
        ("customer", "RELATION", "환자", {"target": "person", "inverse": "appointments", "inverseLabel": "진료 예약"}),
        ("product", "RELATION", "진료 상품", {"target": "product", "inverse": "appointments", "inverseLabel": "진료 예약"}),
        ("method", "SELECT", "진료 방법", {"options": opts(("PHONE", "전화 진료"), ("VISIT", "한의원 진료"))}),
        ("scheduledAt", "DATE_TIME", "예약 일시", {}),
        # 예약 자리 키(<예약 시각>#<번호>). 고유값이라 같은 자리를 동시에 두 번 잡지 못한다. 홈페이지가 채우니 직원은 비워 둔다.
        ("slotKey", "TEXT", "예약 자리(자동)", {"isUnique": True}),
        ("appointmentStatus", "SELECT", "예약 상태", {"options": APPT_STATUS, "defaultValue": "'REQUESTED'"}),
        ("source", "SELECT", "예약 경로", {"options": APPT_SOURCES, "defaultValue": "'HOMEPAGE'"}),
        ("visitType", "SELECT", "초진·재진", {"options": opts(("NEW", "초진"), ("RETURN", "재진"))}),
        ("doctor", "RELATION", "진료의", {"target": "workspaceMember", "inverse": "doctorAppointments", "inverseLabel": "진료 예약"}),
        ("room", "TEXT", "치료실", {}),
        ("arrivedAt", "DATE_TIME", "도착", {}),
        ("roomAt", "DATE_TIME", "진료실 들어감", {}),
        ("treatedAt", "DATE_TIME", "치료 끝", {}),
        ("paidAt", "DATE_TIME", "수납", {}),
        ("cancelReason", "TEXT", "취소·노쇼 사유", {}),
        ("memo", "TEXT", "예약 메모", {}),
        ("upstreamId", "TEXT", "업스트림 ID(이관)", {"isUnique": True}),
    ]),
    # 수납(내원 진료비). 온라인 주문 결제(clinicOrder)와 따로 둔다. 금액은 원장이 정한 비급여·본인부담 합계.
    ("payment", "payments", "수납", "수납", "IconCash", [
        ("customer", "RELATION", "환자", {"target": "person", "inverse": "payments", "inverseLabel": "수납"}),
        ("appointment", "RELATION", "내원", {"target": "appointment", "inverse": "payments", "inverseLabel": "수납"}),
        ("amount", "CURRENCY", "금액", {}),
        ("payMethod", "SELECT", "결제 수단", {"options": opts(("CARD", "카드"), ("CASH", "현금"), ("TRANSFER", "계좌이체"), ("LOCAL", "지역화폐"), ("PACKAGE", "패키지 차감"), ("ETC", "기타"))}),
        ("paidAt", "DATE_TIME", "수납 일시", {}),
        ("memo", "TEXT", "메모", {}),
    ]),
    # 처방 요약(복약 관리용). 약재·용량 같은 처방 상세는 두지 않는다(진료기록 쪽). 복용 종료일 = 수령일(없으면 처방일) + 복용 일수 - 1.
    # 연락 여정의 복약 3일차·중간·소진 전 연락이 이 날짜들을 기준으로 생긴다.
    ("prescription", "prescriptions", "처방", "처방", "IconPill", [
        ("customer", "RELATION", "환자", {"target": "person", "inverse": "prescriptions", "inverseLabel": "처방"}),
        ("appointment", "RELATION", "내원", {"target": "appointment", "inverse": "prescriptions", "inverseLabel": "처방"}),
        ("clinicOrder", "RELATION", "주문", {"target": "clinicOrder", "inverse": "prescriptions", "inverseLabel": "처방"}),
        ("prescribedOn", "DATE", "처방일", {}),
        ("days", "NUMBER", "복용 일수", {}),
        ("receivedOn", "DATE", "수령일", {}),
        ("endsOn", "DATE", "복용 종료일", {}),
        ("doneCheckedAt", "DATE_TIME", "복용 완료 확인", {}),
        ("doneCheckedBy", "RELATION", "복용 완료 확인자", {"target": "workspaceMember", "inverse": "checkedPrescriptions", "inverseLabel": "복용 완료 확인"}),
        ("memo", "TEXT", "메모", {}),
    ]),
    # 패키지 상품 정의. 횟수형(COUNT: 10회권)·정액형(AMOUNT: 50만 원 충전). 이름은 name.
    ("packageProduct", "packageProducts", "패키지 상품", "패키지 상품", "IconTicket", [
        ("kind", "SELECT", "종류", {"options": opts(("COUNT", "횟수형"), ("AMOUNT", "정액형")), "defaultValue": "'COUNT'"}),
        ("total", "NUMBER", "제공 횟수·금액(원)", {}),
        ("price", "CURRENCY", "판매가", {}),
        ("validDays", "NUMBER", "사용 기간(일)", {}),
        ("active", "BOOLEAN", "판매 중", {"defaultValue": True}),
    ]),
    # 환자가 산 패키지. 잔여는 사용 원장으로 계산하고, remaining은 마지막 계산값(목록·필터용)이다.
    ("patientPackage", "patientPackages", "환자 패키지", "환자 패키지", "IconTicket", [
        ("customer", "RELATION", "환자", {"target": "person", "inverse": "patientPackages", "inverseLabel": "패키지"}),
        ("packageProduct", "RELATION", "패키지 상품", {"target": "packageProduct", "inverse": "patientPackages", "inverseLabel": "판매"}),
        ("kind", "SELECT", "종류", {"options": opts(("COUNT", "횟수형"), ("AMOUNT", "정액형")), "defaultValue": "'COUNT'"}),
        ("total", "NUMBER", "제공 횟수·금액(원)", {}),
        ("remaining", "NUMBER", "잔여(계산값)", {}),
        ("startsOn", "DATE", "시작일", {}),
        ("endsOn", "DATE", "만료일", {}),
        ("packageStatus", "SELECT", "상태", {"options": opts(("ACTIVE", "사용 중"), ("ENDED", "종료"), ("REFUNDED", "환불")), "defaultValue": "'ACTIVE'"}),
        ("endReason", "TEXT", "종료 사유", {}),
        ("upstreamId", "TEXT", "업스트림 ID(이관)", {"isUnique": True}),
    ]),
    # 패키지 사용 원장. 고치지 않고 줄을 더한다(차감 취소도 한 줄). amount: 쓴 횟수·금액(취소는 음수로 계산).
    ("packageEntry", "packageEntries", "패키지 원장", "패키지 원장", "IconListDetails", [
        ("patientPackage", "RELATION", "환자 패키지", {"target": "patientPackage", "inverse": "entries", "inverseLabel": "원장"}),
        ("appointment", "RELATION", "내원", {"target": "appointment", "inverse": "packageEntries", "inverseLabel": "패키지 사용"}),
        ("entryKind", "SELECT", "구분", {"options": opts(("USE", "차감"), ("CANCEL", "차감 취소"), ("EXTEND", "기간 연장"), ("END", "종료"))}),
        ("amount", "NUMBER", "횟수·금액(원)", {}),
        ("extendDays", "NUMBER", "연장 일수", {}),
        ("at", "DATE_TIME", "일시", {}),
        ("memo", "TEXT", "메모", {}),
        ("upstreamId", "TEXT", "업스트림 ID(이관)", {"isUnique": True}),
    ]),
    # 진료기록(차팅). 원장이 업무 화면 '진료실'에서 쓰고 서명한다. 서명한 기록은 고치지 않고, 고칠 때는 사유와 함께 새 판을 만든다
    # (같은 chainId, version + 1, supersedes = 앞 판 id). contentHash는 서명할 때 화면이 계산한 내용 해시이고,
    # 서버의 봉인 작업(server/charts.mjs)이 서명한 기록을 Twenty 밖 장부에 암호화해 남긴 뒤 sealedAt·sealNo를 채운다.
    # 보존: 진료기록부 보존 기간 동안 지우지 않는다(파기 작업은 진료기록이 있는 환자를 지우지 않는다).
    # 권한: Twenty 설정 > 역할에서 진료 역할만 이 객체를 읽고 쓰게 하고, 삭제는 누구에게도 주지 않는다(README '진료기록').
    ("medicalRecord", "medicalRecords", "진료기록", "진료기록", "IconStethoscope", [
        ("customer", "RELATION", "환자", {"target": "person", "inverse": "medicalRecords", "inverseLabel": "진료기록"}),
        ("appointment", "RELATION", "내원", {"target": "appointment", "inverse": "medicalRecords", "inverseLabel": "진료기록"}),
        ("doctor", "RELATION", "진료의(서명)", {"target": "workspaceMember", "inverse": "writtenMedicalRecords", "inverseLabel": "작성한 진료기록"}),
        ("visitAt", "DATE_TIME", "진료 일시", {}),
        ("chiefComplaint", "TEXT", "주소(주된 호소)", {}),
        ("history", "TEXT", "현병력·과거력", {}),
        ("findings", "TEXT", "진찰 소견", {}),
        ("diagnosis", "TEXT", "진단(상병)", {}),
        ("treatment", "TEXT", "치료", {}),
        ("prescriptionNote", "TEXT", "처방", {}),
        ("carePlan", "TEXT", "계획·주의", {}),  # plan은 Twenty 예약어
        ("recordStatus", "SELECT", "상태", {"options": opts(("DRAFT", "작성 중"), ("SIGNED", "서명")), "defaultValue": "'DRAFT'"}),
        ("signedAt", "DATE_TIME", "서명 일시", {}),
        ("contentHash", "TEXT", "서명 해시", {}),
        ("chainId", "TEXT", "기록 묶음(판끼리 같음)", {}),
        ("version", "NUMBER", "판", {}),
        ("supersedes", "TEXT", "앞 판 ID", {}),
        ("amendReason", "TEXT", "수정 사유", {}),
        ("sealedAt", "DATE_TIME", "봉인 일시", {}),
        ("sealNo", "NUMBER", "봉인 번호", {}),
    ]),
    # 연락 여정의 단계 하나: 기준 사건 + N일 뒤 시각에 전화·메시지. journey가 같은 단계끼리 한 여정이다.
    # activeFrom 이후에 생긴 사건만 대상('지금부터 들어오는 건만'). 값은 server/journey.mjs와 같아야 한다.
    ("contactRule", "contactRules", "연락 단계", "연락 여정", "IconRoute", [
        ("journey", "TEXT", "여정", {}),
        ("triggerEvent", "SELECT", "기준 사건", {"options": opts(
            ("RX_START", "복약 시작"), ("RX_MID", "복약 중간"), ("RX_END", "복약 끝"), ("VISIT_DONE", "내원 완료"),
            ("FIRST_VISIT", "첫 내원"), ("NO_SHOW", "노쇼"), ("CANCELLED", "예약 취소"), ("NO_RETURN", "마지막 내원"),
            ("PACKAGE_END", "패키지 만료"), ("APPT", "예약일"))}),
        ("offsetDays", "NUMBER", "며칠 뒤(앞이면 음수)", {}),
        ("timeOfDay", "TEXT", "시각(HH:MM)", {}),
        ("channel", "SELECT", "방법", {"options": opts(("CALL", "전화"), ("MESSAGE", "메시지")), "defaultValue": "'CALL'"}),
        ("isAd", "BOOLEAN", "광고성", {"defaultValue": False}),
        ("script", "TEXT", "안내 문구", {}),
        # 메시지 단계에 문구를 고르면 직원 연락 업무 대신 그 시각에 자동 발송한다(발송 내역에 남음). 비우면 직원이 보낼 연락 업무.
        ("messageTemplate", "RELATION", "자동 발송 문구", {"target": "messageTemplate", "inverse": "contactRules", "inverseLabel": "연락 단계"}),
        ("active", "BOOLEAN", "사용", {"defaultValue": False}),
        ("activeFrom", "DATE_TIME", "적용 시작", {}),
        ("sortOrder", "NUMBER", "순서", {}),
    ]),
    # 연락 업무(실행 기록). 여정이 만들거나 직원이 직접 만든다. dedupeKey(<단계>:<사건 레코드>)로 같은 연락을 두 번 만들지 않는다.
    ("contactTask", "contactTasks", "연락 업무", "연락 업무", "IconPhoneCall", [
        ("customer", "RELATION", "환자", {"target": "person", "inverse": "contactTasks", "inverseLabel": "연락 업무"}),
        ("contactRule", "RELATION", "연락 단계", {"target": "contactRule", "inverse": "tasks", "inverseLabel": "연락 업무"}),
        ("channel", "SELECT", "방법", {"options": opts(("CALL", "전화"), ("MESSAGE", "메시지")), "defaultValue": "'CALL'"}),
        ("isAd", "BOOLEAN", "광고성", {"defaultValue": False}),
        ("dueAt", "DATE_TIME", "예정", {}),
        ("taskStatus", "SELECT", "상태", {"options": opts(("TODO", "할 일"), ("DONE", "완료"), ("CANCELLED", "자동 취소")), "defaultValue": "'TODO'"}),
        ("result", "SELECT", "결과", {"options": opts(("REACHED", "통화함"), ("NO_ANSWER", "안 받음"), ("CALLBACK", "다시 연락"),
                                                    ("REACTION", "이상 반응"), ("STOP", "연락 그만"), ("SENT", "보냄"))}),
        ("resultNote", "TEXT", "결과 메모", {}),
        ("doneAt", "DATE_TIME", "처리 일시", {}),
        ("sourceEvent", "TEXT", "원인 사건", {}),
        ("sourceId", "TEXT", "원인 레코드", {}),
        ("dedupeKey", "TEXT", "중복 방지 키", {"isUnique": True}),
        ("cancelReason", "TEXT", "취소 사유", {}),
        # 이상 반응 등 원장이 봐야 할 건. 원장 확인함에 뜨고, 확인하면 일시가 남는다.
        ("needsDoctor", "BOOLEAN", "원장 확인 필요", {"defaultValue": False}),
        ("doctorCheckedAt", "DATE_TIME", "원장 확인", {}),
    ]),
    # 환자에게 보내는 메시지(솔라피 알림톡, 실패하면 문자 대체). 공용 CRM의 발송 서비스(dongwoo-labs/crm services/messenger)가
    # '대기' 건을 보내기 직전에 동의·연락 그만을 다시 확인하고 보낸다. 건강정보는 문구에 넣지 않는다.
    ("messageTemplate", "messageTemplates", "메시지 문구", "메시지 문구", "IconTemplate", [
        ("channel", "SELECT", "보내는 방식", {"options": MSG_CHANNELS, "defaultValue": "'ALIMTALK'"}),
        # 카카오 검수를 받은 알림톡 템플릿 ID(솔라피). 문구는 검수받은 글과 같아야 한다. #{고객}, #{날짜} 같은 변수를 쓴다.
        ("kakaoTemplateId", "TEXT", "알림톡 템플릿 ID", {}),
        ("body", "TEXT", "문구", {}),
        ("isAd", "BOOLEAN", "광고", {"defaultValue": False}),
        ("active", "BOOLEAN", "사용", {"defaultValue": False}),
        ("sortOrder", "NUMBER", "순서", {}),
    ]),
    ("message", "messages", "발송", "발송 내역", "IconSend", [
        ("customer", "RELATION", "받는 분", {"target": "person", "inverse": "messages", "inverseLabel": "발송 내역"}),
        ("messageTemplate", "RELATION", "문구", {"target": "messageTemplate", "inverse": "messages", "inverseLabel": "발송"}),
        ("sentBy", "RELATION", "보낸 직원", {"target": "workspaceMember", "inverse": "sentMessages", "inverseLabel": "보낸 메시지"}),
        ("text", "TEXT", "보낸 글", {}),
        ("variables", "RAW_JSON", "변수", {}),
        ("isAd", "BOOLEAN", "광고", {"defaultValue": False}),
        ("msgStatus", "SELECT", "발송 상태", {"options": MSG_STATUS, "defaultValue": "'QUEUED'"}),
        ("sentType", "SELECT", "보낸 방식", {"options": MSG_TYPES}),
        ("fallback", "BOOLEAN", "문자 대체", {"defaultValue": False}),
        ("batch", "TEXT", "발송 묶음", {}),
        ("scheduledAt", "DATE_TIME", "보낼 시각", {}),
        ("sentAt", "DATE_TIME", "보낸 시각", {}),
        ("doneAt", "DATE_TIME", "결과 시각", {}),
        ("error", "TEXT", "실패·제외 사유", {}),
        ("providerId", "TEXT", "솔라피 메시지 ID", {}),
        ("dedupeKey", "TEXT", "중복 방지 키", {"isUnique": True}),
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
        ("body", "RICH_TEXT", "본문", {}),
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
        ("body", "RICH_TEXT", "본문", {}),
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
    # 환자 정보(업스트림 환자 목록에서 가져옴, import_upstream_patients.py). 차트번호가 환자를 가리키는 키다.
    # 전화번호는 가족이 같이 쓰는 경우가 있어 환자를 합치는 키로 쓰지 않는다.
    ("chartNo", "TEXT", "차트번호", {}),
    ("birthDate", "DATE", "생년월일", {}),
    ("sex", "SELECT", "성별", {"options": opts(("F", "여성"), ("M", "남성"))}),
    ("homeAddress", "ADDRESS", "주소", {}),  # address는 Twenty 예약어
    ("firstVisitAt", "DATE", "첫 내원", {}),
    ("lastVisitAt", "DATE", "마지막 내원", {}),
    ("referredBy", "TEXT", "소개자", {}),
    ("familyNote", "TEXT", "가족", {}),
    # 업스트림 '특이사항'. 건강정보가 섞일 수 있어 console에는 보이지 않는다(Twenty에서 역할 권한으로 연다).
    ("upstreamNote", "TEXT", "특이사항(업스트림)", {}),
    # 예약 안내·공지 같은 정보성 알림. 광고(consentMarketing)와 따로 받는다.
    ("consentNotice", "BOOLEAN", "알림·공지 수신", {"defaultValue": True}),
    # 연락 그만하기. 범위: 광고 전체(AD) 또는 모든 연락(ALL). 여정 하나만 그만둘 때는 stoppedJourneys에 여정 이름을 쉼표로 더한다.
    ("contactStop", "SELECT", "연락 그만", {"options": opts(("AD", "광고 연락 그만"), ("ALL", "모든 연락 그만"))}),
    ("stoppedJourneys", "TEXT", "그만둔 연락 여정", {}),
]

# 연락 여정 기본값(업스트림·우주CRM의 흔한 시나리오). 처음 한 번만 넣고 꺼 둔다. 켜는 시점부터 들어오는 건만 대상이다.
DEFAULT_RULES = [
    ("복약 관리", "RX_START", 3, "11:00", "CALL", False, "복약 3일째예요. 드시기 불편한 점이 없는지 여쭤봐요."),
    ("복약 관리", "RX_MID", 0, "11:00", "MESSAGE", False, "복약 중간 안내: 식사·수분 섭취와 복용 시간을 다시 알려 드려요."),
    ("복약 관리", "RX_END", -3, "11:00", "CALL", False, "약이 3일 남았어요. 경과를 여쭤보고 다음 진료를 안내해요."),
    ("노쇼·취소", "NO_SHOW", 1, "10:30", "CALL", False, "어제 예약에 오지 못하신 이유를 여쭤보고 다시 잡아 드려요."),
    ("노쇼·취소", "CANCELLED", 7, "10:30", "CALL", False, "취소하신 뒤 다시 예약하지 않으셨어요. 불편한 점을 여쭤봐요."),
    ("재내원", "NO_RETURN", 90, "14:00", "MESSAGE", True, "마지막 내원 뒤 3개월이 지났어요. 계절 진료를 안내해요."),
    ("패키지", "PACKAGE_END", -14, "11:00", "CALL", False, "패키지 만료 2주 전이에요. 남은 횟수를 알려 드려요."),
    ("예약 알림", "APPT", -1, "18:00", "MESSAGE", False, "내일 예약을 문자로 알려 드려요."),
]

# 메시지 문구 기본값. 알림톡은 카카오 검수가 필요해 처음에는 문자(SMS)로 넣고 꺼 둔다. 변수: #{고객} #{날짜} #{시간} #{한의원}
DEFAULT_TEMPLATES = [
    ("예약 알림", "SMS", False, "[#{한의원}] #{고객}님, 내일 #{날짜} #{시간} 예약을 알려 드려요. 바꾸시려면 전화 주세요."),
    ("복약 중간 안내", "SMS", False, "[#{한의원}] #{고객}님, 복약 중간이에요. 식사·수분 섭취와 복용 시간을 지켜 주세요. 불편하시면 전화 주세요."),
    ("재내원 안내", "SMS", True, "[#{한의원}] #{고객}님, 마지막 내원 뒤 3개월이 지났어요. 계절 진료를 안내해 드려요."),
]


def seed_contact_rules():
    """기본 단계 중 없는 것(같은 여정·기준 사건)만 꺼 둔 채로 넣는다. 문구 기본값도 같은 이름이 없을 때만 넣고, 같은 이름의 단계에 건다."""
    templates = {t["name"]: t["id"] for t in rest("GET", "/messageTemplates?limit=200")["data"]["messageTemplates"]}
    added_t = 0
    for i, (name, channel, ad, body) in enumerate(DEFAULT_TEMPLATES):
        if name not in templates:
            templates[name] = rest("POST", "/messageTemplates", {"name": name, "channel": channel, "isAd": ad, "body": body, "active": False, "sortOrder": i})["data"]["createMessageTemplate"]["id"]
            added_t += 1
    have = {(r["journey"], r["triggerEvent"]) for r in rest("GET", "/contactRules?limit=200")["data"]["contactRules"]}
    added = 0
    for i, (journey, event, days, time, channel, ad, script) in enumerate(DEFAULT_RULES):
        if (journey, event) in have:
            continue
        tpl = templates.get(journey) if channel == "MESSAGE" else None
        rest("POST", "/contactRules", {"name": f"{journey} · {script.split('.')[0][:20]}", "journey": journey, "triggerEvent": event, "offsetDays": days,
                                        "timeOfDay": time, "channel": channel, "isAd": ad, "script": script, "active": False, "sortOrder": i,
                                        **({"messageTemplateId": tpl} if tpl else {})})
        added += 1
    if added or added_t:
        print("  연락 여정 기본값", added, "단계, 문구", added_t, "개(꺼 둠)")


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
    # 새 필드는 기본값(진료 대기·택배)으로 채워지므로, 이미 끝난 주문과 방문 수령 주문만 고친다.
    # 선택지에 없는 값(옮긴 뒤 지운 SHIPPED)으로 거르면 Twenty가 400을 내므로 지금 있는 값만 쓴다.
    have = {o["value"] for o in (names.get("orderStatus", {}).get("options") or [])}
    states = [v for v in ("SHIPPED", "DONE", "CANCELLED", "REFUNDED") if v in have]
    done = 'and(shippingStatus[eq]:"WAITING",orderStatus[in]:[' + ",".join(f'"{v}"' for v in states) + '])'
    for o in (list_all("clinicOrders", done) if states else []):
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
    seed_contact_rules()
    print("완료")


if __name__ == "__main__":
    sys.exit(main())
