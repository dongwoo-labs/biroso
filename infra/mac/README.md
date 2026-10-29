# 맥 셀프호스팅 운영

렌탈ON(`dongwoo-labs/rentalon`)과 비로소한의원(`dongwoo-labs/biroso`)을 맥북 한 대(mbp-desk)에서 돌린다. CRM은 공용 Twenty 스택(`crm`)의 워크스페이스를 하나씩 쓴다. 세 저장소에 같은 문서가 있다.

## 구성

```
방문자 ─▶ Cloudflare(TLS, Access) ─▶ cloudflared ─▶ caddy ─┬─▶ 정적 사이트 (builder가 만든 site 볼륨)
           (맥으로 들어오는 포트 없음)   (rentalon, biroso)      ├─▶ /api/* → API ──┐
                                                                └─▶ (렌탈ON) Matomo │ crm 네트워크
직원 ─▶ Cloudflare(TLS, Access) ─▶ cloudflared(crm) ─▶ 접속기록 프록시 ─▶ Twenty ◀──┘ (http://crm-twenty:3000)
           *.<CRM 도메인>                                              (멀티 워크스페이스)
cron ─▶ 03:00 재빌드, 비로소 04:00 파기, 렌탈ON 10:00 후기 링크 (한국 시간)
launchd ─▶ 로그인 때 Colima 시작, 매일 암호화 백업
```

- Docker는 Colima VM `selfhost`(CPU 4, 메모리 6GiB, 디스크 60GiB) 하나에서 돈다. docker 명령은 `DOCKER_CONTEXT=colima-selfhost`로 부른다.
- compose 프로젝트는 세 개다. `crm`은 Twenty(서버, 워커, PostgreSQL, Redis)와 접속기록 프록시, `rentalon`·`biroso`는 사이트와 API다. 앱은 외부 네트워크 `crm`으로 Twenty API에 붙는다. `crm`을 먼저 띄운다.
- Twenty는 멀티 워크스페이스로 돈다(`IS_MULTIWORKSPACE_ENABLED=true`). 워크스페이스는 `rentalon`, `biroso` 둘이고, 주소는 `https://<서브도메인>.<CRM 도메인>`, 로그인 입구는 `https://app.<CRM 도메인>`이다. 데이터는 워크스페이스마다 다른 PostgreSQL 스키마에 있고, 사용자·역할·API 키도 워크스페이스마다 따로다. 렌탈ON의 API 키로는 한의원 워크스페이스(문진)를 읽을 수 없다. DB 인스턴스와 백업 파일은 같이 쓴다.
- 새 워크스페이스는 서버 관리자만 만들 수 있다(`IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS=true`). 멀티 워크스페이스에서는 첫 가입자도 자동으로 서버 관리자가 되지 않으므로, 처음 한 번 DB에서 켠다(아래 "Twenty").
- 운영 폴더는 `~/srv/crm`, `~/srv/rentalon`, `~/srv/biroso`(각 저장소 clone), 백업은 `~/srv/backups/<프로젝트>`, 로그는 `~/srv/logs`.
- 같은 맥의 개인용 Twenty(Colima `twenty`, `~/.local/share/twenty-crm`)와는 관계없다.

## 처음 설치

```bash
colima start selfhost --cpu 4 --memory 6 --disk 60 --vm-type vz --mount-type virtiofs --activate=false
git clone https://github.com/dongwoo-labs/<프로젝트>.git ~/srv/<프로젝트>
cd ~/srv/<프로젝트>
cp .env.example .env && chmod 600 .env   # 도메인, 비밀값(openssl rand -hex 32), BACKUP_AGE_RECIPIENTS
DOCKER_CONTEXT=colima-selfhost docker compose up -d --build
infra/mac/install-launchd.sh             # 시각을 나눈다: crm 03:30(기본), 렌탈ON BACKUP_AT=03:45, 비로소 BACKUP_AT=03:50
```

`<프로젝트>`는 `crm`을 먼저, 그다음 `rentalon`, `biroso` 순서다.

로컬 확인: `curl -H 'Host: <사이트 호스트>' http://127.0.0.1:8090/`(렌탈ON), `:8091`(비로소). CRM은 이 맥의 Chrome에서 `http://app.crm.localhost:3030`(도메인 전, `CRM_SERVER_URL=http://crm.localhost:3030`). 이 포트는 127.0.0.1에만 열린다.

## 임시 주소 (샘플 단계, 도메인 없이)

도메인을 정하기 전에는 Cloudflare 대신 Tailscale Funnel로 고정 주소를 쓴다. 무료이고 재시동해도 주소가 바뀌지 않는다(Cloudflare 무료 Quick Tunnel은 계정·도메인 없이 되지만 다시 뜰 때마다 주소가 바뀐다).

| 대상 | 주소 | 공개 범위 | 로컬 포트 |
| --- | --- | --- | --- |
| 렌탈ON 사이트·접수 API | `https://mbp-desk.tail73ebb6.ts.net:8443` | 인터넷 (Funnel) | 127.0.0.1:8090 |
| 비로소 사이트·API | `https://mbp-desk.tail73ebb6.ts.net:10000` | 인터넷 (Funnel) | 127.0.0.1:8091 |

```bash
tailscale funnel --bg --https=8443 http://127.0.0.1:8090
tailscale funnel --bg --https=10000 http://127.0.0.1:8091
```

CRM은 멀티 워크스페이스라 워크스페이스마다 서브도메인이 필요한데, Tailscale은 `*.ts.net` 아래 서브도메인을 만들 수 없다. 그래서 도메인 전에는 이 맥의 브라우저(`*.crm.localhost:3030`)에서만 CRM을 연다.

`.env`: 사이트 호스트에 `http://mbp-desk.tail73ebb6.ts.net`을 더하고, `SITE_URL`은 위 https 주소, 렌탈ON `LEAD_ALLOWED_ORIGINS`에 사이트 주소를 더한다. Matomo는 이 단계에서 공개하지 않는다(`PUBLIC_MATOMO_URL` 비움). 끌 때는 `tailscale funnel --https=8443 off`처럼 포트별로 끈다. `tailscale serve reset`은 이 맥의 다른 서비스 경로까지 지우므로 쓰지 않는다.

## Cloudflare (도메인을 정한 뒤)

1. 도메인의 네임서버를 Cloudflare로 옮긴다(기존 DNS 레코드, 특히 메일(MX)은 Cloudflare가 가져온 목록에서 빠진 게 없는지 확인).
2. Zero Trust > Networks > Tunnels에서 프로젝트(`crm`, `rentalon`, `biroso`)마다 터널을 하나씩 만들고, 토큰을 `.env`의 `CLOUDFLARE_TUNNEL_TOKEN`에 넣은 뒤 `COMPOSE_PROFILES=public`(렌탈ON에서 AI를 켜면 `public,ai`)으로 두고 `docker compose up -d`.
3. 사이트 터널의 Public hostname: 사이트·www(·stats)를 `http://caddy:80`으로 보낸다. Caddy가 호스트 이름으로 나눈다.
4. CRM 터널의 Public hostname: `*.<CRM 도메인>`(와일드카드)을 `http://access-proxy:3100`으로 보낸다. Cloudflare 무료 인증서는 한 단계 아래(`*.example.com`)만 덮으므로, CRM은 전용 도메인의 바로 아래 주소(`app.`, `rentalon.`, `biroso.`)를 쓴다. `rentalon.crm.example.com`처럼 두 단계 아래는 유료 인증서(Advanced Certificate Manager)가 있어야 한다.
5. Zero Trust > Access > Applications에서 `*.<CRM 도메인>`과 `stats.` 호스트에 직원 이메일 인증(One-time PIN) 정책을 건다. 사이트와 `/api/*`, Matomo 수집 경로(`/matomo.php`, `/matomo.js`)는 Access를 걸지 않는다.
6. SSL/TLS > Edge Certificates에서 Always Use HTTPS를 켠다.
7. `.env`의 호스트를 실제 도메인으로 바꾼다. 사이트는 `*_SITE`/`SITE_HOSTS`에 `http://도메인`, `SITE_URL`에 `https://도메인`, CRM은 `crm/.env`의 `CRM_SERVER_URL=https://<CRM 도메인>`(`app.`을 붙이지 않는다). `docker compose up -d`가 바뀐 값으로 다시 띄우고, builder가 새 주소로 사이트를 다시 만든다.

## Twenty

1. `https://app.<CRM 도메인>`(도메인 전에는 `http://app.crm.localhost:3030`)에서 가입하고 첫 워크스페이스 "렌탈ON"을 만든다.
2. 그 계정을 서버 관리자로 만든다(멀티 워크스페이스에서는 자동으로 되지 않는다).
   ```bash
   cd ~/srv/crm && DOCKER_CONTEXT=colima-selfhost docker compose exec -T twenty-db \
     psql -U twenty -d twenty -c "update core.\"user\" set \"canAccessFullAdminPanel\"=true, \"canImpersonate\"=true where email='<가입 이메일>'"
   ```
3. 워크스페이스 메뉴에서 "비로소한의원" 워크스페이스를 하나 더 만든다. 각 워크스페이스의 설정 > 도메인에서 서브도메인을 `rentalon`, `biroso`로 바꾼다.
4. 각 저장소 README의 "처음 설치/설정" 순서(관리자 키 → 구성 스크립트 → 역할 키)를 그 워크스페이스에서 따른다. 키는 워크스페이스마다 따로 만든다. 구성 스크립트는 맥에서 돌린다.

```bash
cd ~/srv/<프로젝트>/crm   # 비로소는 crm/setup_clinic_objects.py
TWENTY_URL=https://<워크스페이스>.<CRM 도메인> TWENTY_API_KEY=<관리자 키> python3 <스크립트>
```

- 앱 컨테이너는 `http://crm-twenty:3000`으로 부른다. API 키에 워크스페이스가 들어 있어 주소는 같아도 된다.

- Vercel 배포 훅 대신: Twenty 워크플로의 HTTP 요청을 `POST http://rentalon-builder:8080/rebuild`(비로소는 `biroso-builder`), 헤더 `Authorization: Bearer <CRON_SECRET>`로 둔다. 빠져도 매일 03:00에 다시 빌드한다.
- 비로소 환불 워크플로: `POST http://biroso-api:8788/v1/orders/refund`, `Authorization: Bearer <ADMIN_SECRET>`.
- 렌탈ON 후기 링크 즉시 채우기: `POST http://rentalon-lead-api:8787/v1/review-links`, `Authorization: Bearer <CRON_SECRET>`.
- 키를 `.env`에 넣은 뒤 `docker compose up -d`로 다시 띄운다. 키가 비어 있으면 API(비로소 `api`, 렌탈ON `lead-api`)는 뜨지 않고 재시작을 되풀이한다.

## AI (회사별 키)

Twenty는 AI 요청에 워크스페이스 정보를 넣지 않는다. 그래서 회사마다 CPA 키가 다른 제공자를 하나씩 두고(`cpa-rentalon`, `cpa-biroso`), 워크스페이스마다 자기 제공자 모델을 고정한다. 사용량은 CPA에서 키별로 본다.

- `~/srv/crm/.env`의 `CRM_AI_PROVIDERS`(작은따옴표로 감싼 JSON): `{"cpa-rentalon":{"npm":"@ai-sdk/openai-compatible","name":"cpa-rentalon","baseUrl":"http://host.docker.internal:8317/v1","apiKey":"<렌탈ON 키>","models":[...]},"cpa-biroso":{...}}`
- 워크스페이스 고정(자동 선택을 끄고 단계마다 모델을 고른다):
  ```bash
  cd ~/srv/crm && DOCKER_CONTEXT=colima-selfhost docker compose exec -T twenty-db psql -U twenty -d twenty -c "update core.workspace set \"isAutoModelSelectionEnabled\"=false, \"aiModelIdByTier\"='{\"extraFast\":\"cpa-biroso/gemini-3.8-flash\",\"fast\":\"cpa-biroso/claude-haiku-5-5\",\"balanced\":\"cpa-biroso/claude-sonnet-5-5\",\"smart\":\"cpa-biroso/gpt-6.1-sol\",\"extraSmart\":\"cpa-biroso/claude-opus-5-5\"}' where subdomain='biroso'"
  ```
- 한계: 모델 목록은 서버 전체에 하나라서, 직원이 AI 화면에서 모델을 직접 고르면 다른 회사 제공자(이름에 회사명이 붙어 있다)를 고를 수 있다. 워크스페이스 설정 > AI에서 자동 선택을 다시 켜면 고정이 풀린다.

## 코드 반영

```bash
cd ~/srv/<프로젝트> && git pull && DOCKER_CONTEXT=colima-selfhost docker compose up -d --build
```

콘텐츠(품목, 글, FAQ)만 바뀐 경우는 재빌드 요청이나 03:00 자동 재빌드로 충분하다. 빌드가 실패하면 직전 사이트가 그대로 남는다(`docker compose logs builder`).

## 백업과 복원

- `infra/mac/backup.sh`가 그 프로젝트에 있는 것만 묶는다. `crm`은 Twenty DB(pg_dump, 두 워크스페이스 모두), 업로드 파일, 접속기록, `rentalon`은 파기기록과 Matomo DB, 모두 `.env`. 이것을 age 공개키(`BACKUP_AGE_RECIPIENTS`)로 암호화한다. 결과는 `~/srv/backups/<프로젝트>/`, 상태는 같은 폴더의 `status.log`, 실패하면 맥 알림이 뜬다.
- 복호화 개인키는 이 맥에 두지 않는다. 맥을 잃어버려도 백업 파일만으로는 내용을 볼 수 없게 하려는 것이다. 키는 비밀번호 관리자와 USB 등 두 곳에 둔다.
- 외장 디스크: `BACKUP_COPY_DIRS=/Volumes/<디스크>/selfhost-backups`(여러 곳은 `:`로 구분). 연결되지 않은 날은 건너뛰고 `status.log`에 SKIP을 남긴다. 외장 디스크는 APFS(암호화)로 포맷한다.
- 국내 클라우드: `rclone config`로 네이버 클라우드 Object Storage(S3 호환, 엔드포인트 `https://kr.object.ncloudstorage.com`) 리모트를 만들고 `BACKUP_RCLONE_REMOTE=<리모트>:<버킷>/<프로젝트>`. 버킷은 비공개로 두고 그 버킷만 쓸 수 있는 키를 쓴다.
- `BACKUP_KEEP_DAYS`(기본 30)일이 지난 백업은 지운다. 파기한 개인정보가 백업에 이 기간만큼 남으므로 처리방침에 적는다.
- 복원 테스트(분기마다 한 번, 그리고 실제 데이터를 넣은 직후):

```bash
cd ~/srv/crm
DOCKER_CONTEXT=colima-selfhost infra/mac/restore-test.sh ~/srv/backups/crm/<파일>.tar.age <개인키 파일>
```

임시 PostgreSQL(네트워크 없음)에 복원하고 워크스페이스별 고객 수를 운영 DB와 나란히 보여 준 뒤, 임시 컨테이너와 파일을 지운다. 실제 복구는 같은 방식으로 풀어 `pg_restore`로 새 `twenty-db`에 넣고, 업로드 파일 tar를 `twenty-files` 볼륨에 푼다.

## 맥 보호 조치

| 항목 | 상태 확인 | 설정 |
| --- | --- | --- |
| FileVault | `fdesetup status` | 켜져 있어야 한다 |
| 전원 연결 시 잠자기 끔 | `pmset -g custom` | `sudo pmset -c sleep 0 disksleep 0 standby 0 powernap 0` |
| 덮개를 닫아도 계속 | | `sudo pmset -a disablesleep 1` (열고 쓸 거면 생략) |
| 정전 뒤 자동 켜짐 | | `sudo pmset -a autorestart 1` |
| 방화벽 | `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` | `sudo .../socketfilterfw --setglobalstate on --setstealthmode on` |
| 화면 잠금 즉시 | `sysadminctl -screenLock status` | 켜져 있어야 한다 |
| 나의 Mac 찾기 | 시스템 설정 > Apple 계정 > iCloud | 켠다(분실 시 원격 잠금·지우기) |
| macOS 자동 업데이트 | 시스템 설정 > 일반 > 소프트웨어 업데이트 | 보안 응답만 자동, OS 업데이트는 직접(재시동 시 아래 참고) |

- FileVault 때문에 재시동 뒤에는 누군가 로그인해야 디스크가 풀리고 Colima와 서비스가 뜬다. 계획된 재시동은 `sudo fdesetup authrestart`로 하면 한 번은 로그인 없이 올라온다. 정전 뒤에는 직접 로그인해야 하므로 그동안 사이트가 멈춘다.
- 맥으로 들어오는 포트는 없다. compose가 여는 포트는 127.0.0.1뿐이고, 밖에서는 Cloudflare 터널로만 들어온다.

## 분실·도난 때

1. 나의 Mac 찾기로 잠그고, 찾을 수 없으면 지운다.
2. Cloudflare에서 세 터널을 삭제(또는 토큰 재발급)한다. 다른 기기에서 같은 토큰으로 사이트를 가로챌 수 없게 된다.
3. Twenty API 키, 나이스페이 키, `CRON_SECRET`·`ADMIN_SECRET`·`REVIEW_LINK_SECRET`을 새로 만든다.
4. 다른 맥에서 "처음 설치"를 하고 최근 백업을 복원한다.
5. 개인정보 유출 가능성이 있으면 72시간 안에 신고·통지 의무가 있는지 확인한다(개인정보보호법 제34조). 한의원 건강정보는 민감정보다.
