# 비로소한의원 홈페이지

기존 사이트(biroso.kmdclinic.co.kr, 메디스트림 KMD clinic)를 렌탈ON 랜딩과 같은 방식(Astro 정적 사이트 + Vercel 함수 + Twenty CRM)으로 옮긴 것이다.
렌탈ON과는 사업자·개인정보처리자가 다르므로 저장소, Vercel 프로젝트, Twenty 워크스페이스를 모두 따로 쓴다.

## 흐름 (기존 사이트와 같음)

- **원내 상품**: 장바구니 또는 바로 처방 신청 → 주문서(받는 방법, 문진, 동의, 복용 방법 확인) → 나이스페이 결제 → 원장님 전화 진료 → 처방 확정·조제 → 발송
  - Twenty 주문은 **주문 상태**(결제 대기 → 결제 완료·진료 대기 → 진료 완료 → 처방 확정·조제 → 주문 완료, 취소·부분 환불·환불)와 **배송 상태**(진료 대기 → 발송 준비 → 배송 중 → 수령 완료, 방문 수령 준비·완료, 배송 취소)를 따로 쓴다. 수령 방식(택배/퀵·직접/방문 수령), 택배사, 송장번호(여러 개면 쉼표), 발송 일시는 직원이 고친다.
  - 결제 금액은 주문 API가 Twenty 상품 가격으로 다시 계산한다. 화면 값은 쓰지 않는다.
  - 결제창 인증 결과는 서명(`sha256(authToken+clientId+amount+SecretKey)`)과 주문 금액을 확인한 뒤 승인한다. 승인 응답의 주문번호가 주문과 다르거나 Twenty 기록이 실패하면 자동 취소하고, 승인 응답을 읽지 못하면 망취소한다.
  - 처방 확정 전 취소는 `POST /api/v1/orders/refund`(Bearer `ADMIN_SECRET`, 본문 `{ "orderNo", "reason", "amount"? }`)로 환불한다. `amount`가 없으면 남은 금액 전부, 있으면 그만큼만 돌려주고 주문을 '부분 환불'로 둔다. 환불 금액은 '환불 금액(누적)'에 쌓이고, 남은 금액 안에서 다시 환불할 수 있다. 면세(한약)·과세(배송비)가 섞인 결제는 면세 금액부터 돌려준다. 처방 확정·주문 완료 주문은 `force`가 있어야 환불되고, 부분 환불해도 상태를 그대로 둬 다음 환불에도 `force`가 필요하다. 같은 API 프로세스에서 같은 주문의 환불이 진행 중이면 두 번째 요청은 `409 refund_in_progress`로 거절한다. 첫 요청이 끝나면 최신 주문을 읽고 다음 환불을 처리한다. 이 가드는 프로세스 재시작·여러 인스턴스·응답 유실 후 재시도의 중복 환불을 막지는 않는다. PG 응답이나 CRM 기록이 실패한 경우에는 자동 재환불하지 말고 PG 내역과 주문 기록을 먼저 대조해야 한다. 지속 처리 이력·중복 요청 식별·대사·복구 경로는 아직 보강이 필요하다. Twenty 워크플로에서 주문 상태를 '환불'로 바꿀 때 부르게 연결하면 된다.
- **수壽 상품**: 판매 경로가 '수壽 매장'인 상품은 장바구니·결제 대신 비로소한의원 전용 수壽 매장(`thesoo.co/@biroso/products/<수壽 상품 ID>`, utm 포함)으로 보낸다. 조제·배송·정산을 수壽가 맡기 때문이다. 빌드 때 수壽 공개 API(`public-api.thesoo.co/market/products/<ID>`)에서 '수壽 수량 옵션'에 맞는 가격과 판매 여부를 받아 온다(실패하면 Twenty 값).
- **빠른 상담**: 첫 화면에서 이름·휴대폰(+관심 진료)만 받아 Twenty '빠른 상담'에 상담 대기로 쌓는다(`POST /api/v1/consults`). 90일 뒤 자동 파기.
- **진료 예약**: 진료 상품 → 전화/한의원 진료 → 날짜·시간(진료시간·휴진일·이미 찬 칸 제외) → 문진·동의 → Twenty '진료 예약'
  - 같은 칸 동시 신청은 '예약 자리(자동)' 고유값 필드(slotKey)로 막는다. 직원은 이 칸을 비워 두고, 취소·시간 변경만 하면 홈페이지가 자리를 알아서 푼다.
- **이벤트·게시판·FAQ**: Twenty에서 고치고, 배포 훅(또는 매일 03:00 KST 재배포)으로 반영한다.
- 주소는 기존 사이트와 같다(`/telemedicine/<상품 ID>`, `/board/category-N/<게시판 ID>/<글 ID>` 등). 도메인만 옮기면 검색·블로그 링크가 그대로 산다.

## 폴더

| 위치 | 내용 |
| --- | --- |
| `src/` | Astro 페이지. `src/lib/content.ts`가 빌드 때 Twenty(없으면 `src/data/*.json`)에서 콘텐츠를 읽는다 |
| `src/data/` | 기존 사이트에서 옮겨 온 상품·이벤트·글·FAQ, 한의원 정보(`clinic.json`: 진료시간·바로가기 링크·배송비·정책 문구), 동의문(`notice.json`), 비급여 항목(`npay.json`) |
| `public/media/` | 기존 사이트 그림(1200px webp로 줄임) |
| `server/` | 주문·결제·예약·환불·파기 API (`handler.mjs`가 라우터) |
| `api/` | Vercel 함수(전부 `server/handler.mjs`를 부른다) |
| `crm/` | Twenty 객체 만들기(`setup_clinic_objects.py`), 옮겨 온 콘텐츠 넣기(`seed_content.py`), 업스트림 환자 가져오기(`import_upstream_patients.py`), 예약·패키지 이력 가져오기(`import_upstream_history.py`) |
| `scripts/import-site.mjs` | 기존 사이트에서 콘텐츠·그림 다시 가져오기(`npm run import-site`) |

## 처음 설정

1. Twenty에 비로소한의원용 워크스페이스를 새로 만들고 관리자 API 키를 발급한다.
2. `TWENTY_URL=… TWENTY_API_KEY=… python3 crm/setup_clinic_objects.py` (이미 만든 워크스페이스에 다시 돌리면 새 필드·객체를 더하고, 옛 주문을 주문 상태 + 배송 상태로 옮긴 뒤 옛 '한의원 방문 수령' 필드를 지운다)
3. `TWENTY_URL=… TWENTY_API_KEY=… SITE_URL=https://<배포 주소> python3 crm/seed_content.py`
4. Vercel에 이 저장소로 새 프로젝트를 만든다(프레임워크 Astro, 설정은 `vercel.json`). 환경변수:

| 변수 | 설명 |
| --- | --- |
| `TWENTY_URL`, `TWENTY_API_KEY` | 주문·예약 기록과 빌드 때 콘텐츠 읽기 |
| `TWENTY_CONTENT_KEY` | (선택) 빌드 전용 읽기 키. 없으면 `TWENTY_API_KEY` |
| `NICEPAY_CLIENT_ID`, `NICEPAY_SECRET_KEY` | 나이스페이 키. `S1_`/`S2_`로 시작하는 샌드박스 키면 샌드박스로 승인한다. 없으면 결제를 받지 않는다 |
| `SITE_URL` | 운영 주소(결제 완료 후 돌아올 주소). 없으면 Vercel 운영 주소 |
| `ADMIN_SECRET` | 환불 API 키 |
| `CRON_SECRET` | Vercel 크론(파기, 재배포) |
| `VERCEL_DEPLOY_HOOK_URL` | 재배포 훅 |
| `PUBLIC_LIVE=1` | 실제 운영 시작. 없으면 '시범 사이트' 표시와 검색 차단 |
| `PUBLIC_SITE_URL`, `PUBLIC_GA4_ID`, `PUBLIC_NAVER_SITE_VERIFICATION`, `PUBLIC_GOOGLE_SITE_VERIFICATION` | 검색·분석 |
| `INTAKE_RETENTION_DAYS`(365), `QUICK_CONSULT_RETENTION_DAYS`(90), `PENDING_ORDER_HOURS`(24), `SLOT_CAPACITY`(1), `SLOT_MINUTES`(30), `SLOT_LEAD_HOURS`(2) | 보유기간·예약 칸 |

5. 나이스페이 가맹점 관리자에서 결제 도메인으로 배포 주소를 등록한다.

## 맥 셀프호스팅

운영은 맥북 한 대에서 docker compose로 한다(`docker-compose.yml`, Cloudflare Tunnel). Vercel 함수(`api/`)와 `vercel.json`은 되돌릴 때를 위해 남겨 둔다.

- `server/server.mjs`가 `server/handler.mjs`를 node:http로 띄우고, Caddy가 `/api/*`를 넘긴다(주소는 Vercel 때와 같다).
- 배포 훅·크론 대신 `builder`(재빌드)와 `cron`(03:00 재빌드, 04:00 파기)이 돈다.
- Twenty는 공용 스택(`dongwoo-labs/crm`, `~/srv/crm`)의 `biroso` 워크스페이스를 쓴다. 렌탈ON과 사용자·역할·API 키·데이터 스키마가 따로고, DB 인스턴스와 접속기록 프록시는 같이 쓴다.
- 설치, Cloudflare, 백업·복원, 맥 보호 조치: `infra/mac/README.md`

## 업스트림 환자 가져오기

업스트림 '환자 목록'에서 내려받은 엑셀(15열)을 Twenty 환자로 옮긴다. 원본 파일에는 환자 개인정보가 있으니 맥 밖으로 보내지 않는다.

```bash
cd crm
TWENTY_URL=… TWENTY_API_KEY=… python3 import_upstream_patients.py ~/Downloads/환자_목록.xlsx          # 미리보기(건수·형식 문제만 출력)
TWENTY_URL=… TWENTY_API_KEY=… python3 import_upstream_patients.py ~/Downloads/환자_목록.xlsx --apply  # 쓰기
```

- 차트번호가 키다(앞자리 0 그대로). 같은 차트번호가 있으면 바뀐 칸만 고치고 없으면 만든다. 전환 전까지 여러 번 돌려도 된다. 전환 뒤에는 CRM에서 고친 값을 덮어쓰므로 돌리지 않는다.
- 전화번호로 환자를 합치지 않는다. 같은 번호를 쓰는 환자 수를 미리보기에 보여 준다.
- 광고 수신 동의가 '예'인 환자는 동의원장에 '업스트림 이관(원 동의 시각 미상)'으로 한 줄 남긴다.
- 특이사항은 건강정보가 섞일 수 있어 console에 보이지 않는 `특이사항(업스트림)` 칸에 둔다.
- 나이 열은 생년월일에서 계산되므로 쓰지 않는다. 예약·패키지·진료 이력은 이 파일에 없다.
- 테스트: `python3 -m unittest crm/test_import_upstream.py`

## 업스트림 예약·패키지 이력 옮기기(전환)

환자를 먼저 옮긴 뒤 예약·패키지를 옮긴다. 기본은 **리허설**이라 아무것도 쓰지 않고 대사 보고(건수·상태별 건수·패키지 총량·잔여 합, 건너뛴 이유)만 낸다. 보고에는 환자 이름·차트번호가 없다.

```bash
cd crm
python3 setup_clinic_objects.py                                                       # upstreamId 칸 만들기(한 번)
python3 import_upstream_history.py appointments ~/Downloads/예약.xlsx --report 예약_리허설.json
python3 import_upstream_history.py packages ~/Downloads/패키지.xlsx --usage ~/Downloads/사용내역.xlsx --report 패키지_리허설.json
# 보고를 업스트림 화면 숫자와 맞춘 뒤 같은 명령에 --apply
```

- 각 건은 업스트림 ID(없으면 차트번호+일시)를 `upstreamId`(고유값)에 남긴다. 여러 번 돌려도 같은 건을 두 번 만들지 않는다. 예약은 바뀐 칸만 고치고, 이미 옮긴 패키지는 고치지 않고 빠진 원장 줄만 더한다.
- 열 이름은 업스트림 화면·API 이름 여러 개를 받는다(`ALIASES`). 파일은 .xlsx, .csv, .json.
- 패키지 잔여는 원장으로 계산되므로, 사용내역마다 '차감' 한 줄을 만들고 업스트림 잔여와의 차이는 '이관 전 사용'(또는 '이관 차이 맞춤') 한 줄로 맞춘다. 취소된 사용내역은 건너뛴다.
- 수납(매출)은 만들지 않는다. 이관 전 매출은 업스트림 기록으로 본다.
- `past_open`: 지난 날짜인데 완료·노쇼 표시가 없는 예약 수. 0이 아니면 업스트림 원무 기록이 빠진 것이라 확인한다.
- 미래 예약도 옮겨지므로 예약 알림 단계를 켜 두었다면 그 예약에도 알림이 잡힌다.

전환 순서:
1. **리허설**: 지금 파일로 환자 → 예약 → 패키지를 미리보기만 돌려 건너뛴 줄을 고친다.
2. **대사**: 보고의 상태별 건수, 활성 패키지 잔여 합(횟수형·정액형)을 업스트림 화면 숫자와 맞춘다.
3. **전환일**: 업스트림 신규 입력을 멈추고(읽기 전용) 마지막 파일을 내려받아 세 가지를 `--apply`로 돌린다. 보고 파일을 남긴다.
4. 그 뒤로는 CRM에서만 입력한다. 전환 뒤에는 이관 스크립트를 다시 돌리지 않는다(CRM에서 고친 값을 덮어쓴다).

- 테스트: `python3 -m unittest crm/test_import_history.py`

## 연락 여정 (복약·노쇼·재내원·패키지·예약 알림)

업스트림 연락 여정을 대신한다. Twenty의 **연락 여정**(`contactRule`)에 단계(기준 사건 + N일, 시각, 전화/메시지, 광고성)를 두면, 매일 07:00·13:00·19:00 크론이 `GET /v1/journeys`로 그날 할 **연락 업무**(`contactTask`)를 만든다. 직원은 업무 화면(crm console)의 연락 업무에서 전화하고 결과를 남긴다.

- 기준 사건: 복약 시작·중간·끝(처방의 수령일·복용 일수), 내원 완료, 첫 내원, 노쇼, 예약 취소, 마지막 내원(미내원 N일), 패키지 만료, 예약일(예약 알림)
- 단계를 켠 시각(적용 시작) 뒤에 생긴 사건만 대상이다. 예정일이 지난 3일 안이면 따라잡아 만들고, 같은 단계·사건으로는 한 번만 만든다(`dedupeKey`).
- 광고성 단계는 광고 수신 동의자만, 정보성 메시지는 알림 수신 거부자를 뺀다. 환자의 '연락 그만'(광고 전체·모든 연락)과 '그만둔 연락 여정'을 지킨다.
- 아직 하지 않은 연락은 사건이 바뀌면 자동 취소한다: 다시 예약함, 예약 상태가 바뀜, 복용 완료 확인, 패키지 연장·종료, 수신 거부, 단계 끔.
- `setup_clinic_objects.py`가 기본 단계 8개(복약 3일차·중간·소진 3일 전, 노쇼 다음날, 취소 7일, 미내원 90일 광고, 패키지 만료 2주 전, 예약 전날 18:00 알림)와 메시지 문구 3개를 **꺼 둔 채로** 넣는다(없는 것만). 한의원이 확인하고 켠다.
- **자동 발송**: 메시지 단계에 '자동 발송 문구'를 고르면 연락 업무 대신 **발송**(`message`, 대기)을 만든다. 공용 CRM의 발송 서비스(dongwoo-labs/crm `services/messenger`)가 보낼 시각에 동의·연락 그만을 다시 확인하고 솔라피로 보낸다(알림톡, 실패하면 문자). 자동 발송은 지난 날 것을 따라잡지 않는다. 예약 시각이 바뀌면 예전 알림은 취소하고 새로 잡는다.
- 문구 변수: `#{고객}` `#{날짜}`(11/6(금)) `#{시간}`(예약) `#{한의원}`(발송 서비스 설정). 건강정보(처방 내용 등)는 문구에 넣지 않는다.
- 판단은 `server/journey.mjs`의 `plan()`(테스트 `test/journey.test.mjs`).

## 진료기록(차팅)

원장이 업무 화면(crm console)의 **진료실**에서 진료기록을 쓰고 서명한다(Twenty `medicalRecord`). 법적 요건 대응 현황과 남은 확인 사항은 최종 보고서(프로젝트 파일 `charting-legal/`)에 있다. 아래는 운영 절차다.

### 설정 순서(처음 한 번, 여러 번 실행해도 된다)

```bash
cd crm
python3 setup_clinic_objects.py                                  # 진료기록 객체·칸
CRM_DIR=~/srv/crm ./install_chart_guard.sh                       # DB 보호(트리거·서명 증거·감사 역할)
CRM_DIR=~/srv/crm ./install_chart_guard.sh --signer 원장@이메일   # 서명할 수 있는 원장 등록
python3 setup_chart_roles.py --api-key-role 봉인=진료기록 봉인 --api-key-role 홈페이지=홈페이지 API
CRM_DIR=~/srv/crm ./install_chart_guard.sh --check               # 설치 상태·원장·서명 증거 수
```

API 키는 Twenty 설정 > API에서 '봉인'(→ `.env`의 `CHART_TWENTY_API_KEY`)과 '홈페이지'(→ `TWENTY_API_KEY`)로 따로 만든 뒤 위 명령으로 역할을 준다. 사람에게는 설정 > 멤버에서 역할을 준다.

### 역할

| 역할 | 누구 | 진료기록 | 환자 특이사항(업스트림) | 그 밖 |
| --- | --- | --- | --- | --- |
| 진료 | 원장 | 읽기·쓰기·서명(삭제 없음) | 읽음 | AI·도구·설정 없음 |
| Member | 직원 | 없음(메뉴도 안 보임) | 못 봄 | |
| 운영 관리 | 개발·운영 담당 | 없음 | 못 봄 | 설정 |
| 진료기록 봉인 | API 키 | 읽기·봉인 칸만 | | |
| 홈페이지 API | API 키 | ID만(파기 판단용) | 못 봄 | |
| Admin | **비상 계정 1개** | 읽음(Twenty 기본, 못 바꿈) | 읽음 | 비밀번호는 원장 보관, 쓸 때마다 접속기록 점검 |

렌탈ON 워크스페이스에는 진료기록 객체가 없고 키·토큰이 워크스페이스에 묶여 있어 비로소 기록을 읽지 못한다.

### 서명과 고치기

- 서명 전 필수 항목(시행규칙 제14조): 환자, 진료 일시, 주된 증상, 진단, 치료 내용. 빠지면 서명 버튼이 막고, DB도 거부한다. 환자 주소·주민번호는 받지 않는다(남은 확인 사항).
- 서명: 화면이 전체 내용을 보여 주고 비밀번호를 다시 받는다. DB 트리거가 서명자 = 로그인한 원장(`chart_audit.signer`에 등록), 내용 해시 = 서버가 다시 계산한 값인지 검사하고 서명 증거(`chart_audit.signature`)를 남긴다.
- 서명한 기록은 누구도(API 키·관리자 화면 포함) 고치거나 지울 수 없다. '새 판으로 고치기'가 수정 사유를 받아 같은 묶음(`chainId`)의 다음 판을 만든다. 모든 변경은 `chart_audit.change_log`에 남는다.
- 해시 규칙(`server/charts.mjs`의 `CHART_FIELDS`, `crm/chart_guard.sql`의 `content_hash`, console `clinic-chart.ts`)은 셋이 같아야 한다. 칸은 더하기만 한다.

### 봉인·검사·알림

- 10분마다 `GET /v1/charts/seal`이 서명한 기록을 암호화해 장부(`charts` 볼륨 `ledger.jsonl`, 해시 체인)에 더하고 봉인 번호를 채운다. 서명 뒤 내용이 바뀐 기록이나 장부에 없는 봉인 번호는 **봉인하지 않고** 증거(`kind: suspect`)로 남기고 알린다.
- 매일 05:30 `GET /v1/charts/verify`가 장부 체인·봉인한 기록·서명 1시간이 지나도 봉인 안 된 기록을 검사해 `checks.jsonl`에 남긴다. 이상이 있으면 알리고, 없으면 "이상 없음 + 장부 끝 해시 앞 16자"를 원장 휴대폰(`CHART_ANCHOR_SMS_TO`)으로 보낸다. 원장은 이 문자를 지우지 않는다. 관리자가 서버의 장부를 고쳐도 원장이 받은 기준값과 맞지 않아 드러난다.
- 알림은 솔라피 문자(`CHART_ALERT_*`)와 웹훅. 글에는 환자 이름·진료 내용을 넣지 않는다.
- `CHART_LEDGER_KEY`(`openssl rand -hex 32`)는 `.env`와 원장이 가진 비밀번호 관리자에 둔다. 잃으면 장부 사본을 열 수 없다.

### 이상 대응

1. 알림을 받으면 `docker compose exec api node scripts/chart-ledger.mjs check`로 장부 체인과 끝 해시를 보고, 원장이 받은 기준값과 대조한다.
2. 바뀐 기록: `chart-ledger.mjs show <기록 ID>`로 봉인 당시 내용을 확인한다. crm의 `pg-logs`(pgaudit)와 접속기록에서 누가 언제 바꿨는지 찾는다.
3. 원장 확인 후 `chart-ledger.mjs sql <기록 ID>`가 만든 SQL로 되돌린다(DB 관리자 실행, 그 실행도 pgaudit에 남는다). 다시 `GET /v1/charts/verify`가 통과해야 끝.
4. 날짜·기록 ID·원인·조치·확인한 사람을 사고 기록에 남긴다. 유출이 의심되면 개인정보 유출 신고 기준(72시간)을 따로 검토한다.

### 접속기록 정기 점검(매달)

```bash
cd ~/srv/crm
docker compose exec -T access-proxy cat /var/log/twenty-access/access.jsonl | node infra/access-review.mjs --host biroso. --since 2026-11-01 --until 2026-12-01
```

계정별 진료기록 조회·변경·출력·내보내기, 업무 시간 밖 접근, 실패(권한 없음·DB 거부), 설정·역할 변경이 나온다. 원장 외 계정의 진료기록 접근과 Admin(비상) 계정 사용을 특히 본다. 결과(이상 없음 또는 조치)를 날짜와 점검자 이름으로 기록한다. DB 직접 접속은 crm `pg-logs` 볼륨의 pgaudit 로그(`client=[local]` 줄)를 함께 본다.

### 보존·백업·파기

- 접속기록·pgaudit 로그는 지우지 않고 쌓는다. 매달 진료기록 보존 묶음(crm `infra/mac/backup.sh`, `chart-archive-*`)에 함께 들어가 2년 이상 남는다.
- 진료기록이 있는 환자는 파기 작업이 지우지 않는다. 진료기록부는 마지막 진료부터 10년(시행규칙 제15조) 보존한다. 지난 기록의 파기는 자동으로 하지 않는다. 해마다 1월에 10년이 지난 환자를 원장이 확인하고 파기한 뒤 파기 기록(대상 수, 일시, 방법, 확인자)을 남긴다. 보존 묶음 중 10년이 지난 것도 이때 지운다.
- 출력·사본: 진료실의 '기록 출력·내보내기'가 환자 한 명의 모든 판(서명자·해시·봉인·검증 결과 포함)을 인쇄·PDF·JSON으로 낸다. 읽을 때 접속기록에 '출력'·'내보내기'로 남는다. 폐업·이관 때도 이것과 보존 묶음을 쓴다.
- 테스트: `node --test test/charts.test.mjs`

## 개인정보

- 건강정보(문진)는 `문진` 객체에 따로 두고 별도 동의(개인정보보호법 제23조)를 받는다. Twenty 역할에서 문진 읽기를 진료 담당자로만 열어 두는 것을 권한다.
- 문진의 질병 경험·최근 복용 약은 선택지(메디스트림 기본 문진표와 같은 목록)로 받고, 임신·수유는 여성에게만 묻는다.
- 결제하지 않고 떠난 주문은 24시간 뒤, 문진은 1년 뒤, 빠른 상담은 90일 뒤 자동 파기(`/api/v1/purge`, 매일 04:00 KST). 결제된 주문 기록은 전자상거래법에 따라 5년 남긴다. 차트번호가 있는 환자와 예약·수납이 남은 사람은 주문을 파기해도 지우지 않는다.
- 직원 채팅(업무 화면 상단 말풍선, `staffMessages`)은 환자 이름이 오갈 수 있어 `CHAT_RETENTION_DAYS`(기본 365일)가 지나면 같은 파기 작업이 지운다. 0이면 지우지 않는다. 1:1 대화도 직원 채팅 객체를 읽을 수 있는 역할이면 Twenty에서 볼 수 있다.
- 동의문을 고치면 `src/data/notice.json`의 `version`과 서버 환경변수 `NOTICE_VERSIONS`를 함께 올린다.

## 한의원이 확인해야 할 것

- 통신판매업 신고번호: 기존 사이트에도 비어 있다. 신고 후 `src/data/clinic.json`의 `mailOrderNo`에 넣는다.
- 비급여 진료 비용: 기존 사이트의 수가표 PDF(2026-08-05 작성, 시행일 빈칸) 134개 항목을 `src/data/npay.json`에 옮겼다. 시행일과 최신 금액을 확인한다. 바뀌면 이 파일을 고친다(한약 상품 가격은 자동).
- 개인정보 보호책임자(`clinic.json`의 `privacyOfficer`. 이메일은 기존 사이트의 clinic.biroso@gmail.com을 넣었다), 위탁 업체 목록(`src/pages/privacy.astro`).

## 개발

```bash
npm ci
npm run dev        # http://localhost:4321 (API는 Vercel에서만 동작: vercel dev 사용)
npm test           # 주문·결제·예약·환불·파기 테스트
npm run build
```
