# 비로소한의원 홈페이지

기존 사이트(biroso.kmdclinic.co.kr, 메디스트림 KMD clinic)를 렌탈ON 랜딩과 같은 방식(Astro 정적 사이트 + Vercel 함수 + Twenty CRM)으로 옮긴 것이다.
렌탈ON과는 사업자·개인정보처리자가 다르므로 저장소, Vercel 프로젝트, Twenty 워크스페이스를 모두 따로 쓴다.

## 흐름 (기존 사이트와 같음)

- **원내 상품**: 장바구니 또는 바로 처방 신청 → 주문서(받는 방법, 문진, 동의, 복용 방법 확인) → 나이스페이 결제 → 원장님 전화 진료 → 처방 확정·조제 → 발송
  - Twenty 주문은 **주문 상태**(결제 대기 → 결제 완료·진료 대기 → 진료 완료 → 처방 확정·조제 → 주문 완료, 취소·부분 환불·환불)와 **배송 상태**(진료 대기 → 발송 준비 → 배송 중 → 수령 완료, 방문 수령 준비·완료, 배송 취소)를 따로 쓴다. 수령 방식(택배/퀵·직접/방문 수령), 택배사, 송장번호(여러 개면 쉼표), 발송 일시는 직원이 고친다.
  - 결제 금액은 주문 API가 Twenty 상품 가격으로 다시 계산한다. 화면 값은 쓰지 않는다.
  - 결제창 인증 결과는 서명(`sha256(authToken+clientId+amount+SecretKey)`)과 주문 금액을 확인한 뒤 승인한다. 승인 응답의 주문번호가 주문과 다르거나 Twenty 기록이 실패하면 자동 취소하고, 승인 응답을 읽지 못하면 망취소한다.
  - 처방 확정 전 취소는 `POST /api/v1/orders/refund`(Bearer `ADMIN_SECRET`, 본문 `{ "orderNo", "reason", "amount"? }`)로 환불한다. `amount`가 없으면 남은 금액 전부, 있으면 그만큼만 돌려주고 주문을 '부분 환불'로 둔다. 환불 금액은 '환불 금액(누적)'에 쌓이고, 남은 금액 안에서 다시 환불할 수 있다. 면세(한약)·과세(배송비)가 섞인 결제는 면세 금액부터 돌려준다. 처방 확정·주문 완료 주문은 `force`가 있어야 환불되고, 부분 환불해도 상태를 그대로 둬 다음 환불에도 `force`가 필요하다. 같은 주문을 동시에 두 번 환불하지 않게 한 번에 한 사람만 처리한다. Twenty 워크플로에서 주문 상태를 '환불'로 바꿀 때 부르게 연결하면 된다.
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
| `crm/` | Twenty 객체 만들기(`setup_clinic_objects.py`), 옮겨 온 콘텐츠 넣기(`seed_content.py`) |
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

## 개인정보

- 건강정보(문진)는 `문진` 객체에 따로 두고 별도 동의(개인정보보호법 제23조)를 받는다. Twenty 역할에서 문진 읽기를 진료 담당자로만 열어 두는 것을 권한다.
- 문진의 질병 경험·최근 복용 약은 선택지(메디스트림 기본 문진표와 같은 목록)로 받고, 임신·수유는 여성에게만 묻는다.
- 결제하지 않고 떠난 주문은 24시간 뒤, 문진은 1년 뒤, 빠른 상담은 90일 뒤 자동 파기(`/api/v1/purge`, 매일 04:00 KST). 결제된 주문 기록은 전자상거래법에 따라 5년 남긴다.
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
