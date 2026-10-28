# 비로소한의원 홈페이지

기존 사이트(biroso.kmdclinic.co.kr, 메디스트림 KMD clinic)를 렌탈ON 랜딩과 같은 방식(Astro 정적 사이트 + Vercel 함수 + Twenty CRM)으로 옮긴 것이다.
렌탈ON과는 사업자·개인정보처리자가 다르므로 저장소, Vercel 프로젝트, Twenty 워크스페이스를 모두 따로 쓴다.

## 흐름 (기존 사이트와 같음)

- **원내 상품**: 장바구니 또는 바로 처방 신청 → 주문서(받는 방법, 문진, 동의) → 나이스페이 결제 → 원장님 전화 진료 → 처방 확정·조제 → 발송
  - 결제 금액은 주문 API가 Twenty 상품 가격으로 다시 계산한다. 화면 값은 쓰지 않는다.
  - 결제창 인증 결과는 서명(`sha256(authToken+clientId+amount+SecretKey)`)과 주문 금액을 확인한 뒤 승인한다. 승인 뒤 Twenty 기록이 실패하면 자동 취소한다.
  - 처방 확정 전 취소는 `POST /api/v1/orders/refund`(Bearer `ADMIN_SECRET`, 본문 `{ "orderNo", "reason" }`)로 전액 환불한다. Twenty 워크플로에서 주문 상태를 '환불'로 바꿀 때 부르게 연결하면 된다.
- **진료 예약**: 진료 상품 → 전화/한의원 진료 → 날짜·시간(진료시간·휴진일·이미 찬 칸 제외) → 문진·동의 → Twenty '진료 예약'
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
2. `TWENTY_URL=… TWENTY_API_KEY=… python3 crm/setup_clinic_objects.py`
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
| `INTAKE_RETENTION_DAYS`(365), `PENDING_ORDER_HOURS`(24), `SLOT_CAPACITY`(1), `SLOT_MINUTES`(30), `SLOT_LEAD_HOURS`(2) | 보유기간·예약 칸 |

5. 나이스페이 가맹점 관리자에서 결제 도메인으로 배포 주소를 등록한다.

## 개인정보

- 건강정보(문진)는 `문진` 객체에 따로 두고 별도 동의(개인정보보호법 제23조)를 받는다. Twenty 역할에서 문진 읽기를 진료 담당자로만 열어 두는 것을 권한다.
- 결제하지 않고 떠난 주문은 24시간 뒤, 문진은 1년 뒤 자동 파기(`/api/v1/purge`, 매일 04:00 KST). 결제된 주문 기록은 전자상거래법에 따라 5년 남긴다.
- 동의문을 고치면 `src/data/notice.json`의 `version`과 서버 환경변수 `NOTICE_VERSIONS`를 함께 올린다.

## 한의원이 확인해야 할 것

- 통신판매업 신고번호: 기존 사이트에도 비어 있다. 신고 후 `src/data/clinic.json`의 `mailOrderNo`에 넣는다.
- 비급여 진료 비용: 기존 사이트 페이지가 비어 있다. 침·추나 등 시술 비용을 `src/data/npay.json`에 넣는다(한약 가격은 자동).
- 개인정보 보호책임자·이메일(`clinic.json`의 `privacyOfficer`, `email`), 위탁 업체 목록(`src/pages/privacy.astro`).
- 기존 사이트에 이름·가격이 같은 상품이 4쌍 있다(침향공진단 30환 단품·2박스, 녹용공진단 30환 2박스, 쌍화탕 1박스). 그대로 옮겼으니 Twenty에서 하나씩 '홈페이지 노출'을 끄면 된다.

## 개발

```bash
npm ci
npm run dev        # http://localhost:4321 (API는 Vercel에서만 동작: vercel dev 사용)
npm test           # 주문·결제·예약·환불·파기 테스트
npm run build
```
