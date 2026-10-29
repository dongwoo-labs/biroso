# 맥 셀프호스팅 운영

렌탈ON(`dongwoo-labs/rentalon`)과 비로소한의원(`dongwoo-labs/biroso`)을 맥북 한 대(mbp-desk)에서 돌린다. 두 저장소에 같은 문서가 있다.

## 구성

```
방문자 ─▶ Cloudflare(TLS, Access) ─▶ cloudflared ─▶ caddy ─┬─▶ 정적 사이트 (builder가 만든 site 볼륨)
           (맥으로 들어오는 포트 없음)   (프로젝트마다 따로)      ├─▶ /api/* → API
                                                                ├─▶ CRM → 접속기록 프록시 → Twenty
                                                                └─▶ (렌탈ON) Matomo
cron ─▶ 03:00 재빌드, 비로소 04:00 파기, 렌탈ON 10:00 후기 링크 (한국 시간)
launchd ─▶ 로그인 때 Colima 시작, 매일 암호화 백업
```

- Docker는 Colima VM `selfhost`(CPU 4, 메모리 6GiB, 디스크 60GiB) 하나에서 돈다. docker 명령은 `DOCKER_CONTEXT=colima-selfhost`로 부른다.
- 두 서비스는 compose 프로젝트(`rentalon`, `biroso`)가 달라 네트워크, Twenty, PostgreSQL, 볼륨, 비밀값, Cloudflare 터널, 백업 키가 모두 따로다. 한의원 건강정보(문진)는 렌탈ON 쪽에서 닿을 길이 없다.
- 운영 폴더는 `~/srv/rentalon`, `~/srv/biroso`(각 저장소 clone), 백업은 `~/srv/backups/<프로젝트>`, 로그는 `~/srv/logs`.
- 같은 맥의 개인용 Twenty(Colima `twenty`, `~/.local/share/twenty-crm`)와는 관계없다.

## 처음 설치

```bash
colima start selfhost --cpu 4 --memory 6 --disk 60 --vm-type vz --mount-type virtiofs --activate=false
git clone https://github.com/dongwoo-labs/<프로젝트>.git ~/srv/<프로젝트>
cd ~/srv/<프로젝트>
cp .env.example .env && chmod 600 .env   # 도메인, 비밀값(openssl rand -hex 32), BACKUP_AGE_RECIPIENTS
DOCKER_CONTEXT=colima-selfhost docker compose up -d --build
infra/mac/install-launchd.sh             # 렌탈ON은 BACKUP_AT=03:45 를 앞에 붙여 시각을 나눈다
```

로컬 확인: `curl -H 'Host: <사이트 호스트>' http://127.0.0.1:8090/`(렌탈ON), `:8091`(비로소). 이 포트는 127.0.0.1에만 열린다.

## Cloudflare

1. 도메인의 네임서버를 Cloudflare로 옮긴다(기존 DNS 레코드, 특히 메일(MX)은 Cloudflare가 가져온 목록에서 빠진 게 없는지 확인).
2. Zero Trust > Networks > Tunnels에서 프로젝트마다 터널을 하나씩 만들고, 토큰을 `.env`의 `CLOUDFLARE_TUNNEL_TOKEN`에 넣은 뒤 `COMPOSE_PROFILES=public`(렌탈ON에서 AI를 켜면 `public,ai`) 줄의 주석을 풀고 `docker compose up -d`.
3. 터널의 Public hostname: 사이트·www·crm(·stats)을 모두 `http://caddy:80`으로 보낸다. Caddy가 호스트 이름으로 나눈다.
4. Zero Trust > Access > Applications에서 `crm.`·`stats.` 호스트에 직원 이메일 인증(One-time PIN) 정책을 건다. 사이트와 `/api/*`, Matomo 수집 경로(`/matomo.php`, `/matomo.js`)는 Access를 걸지 않는다.
5. SSL/TLS > Edge Certificates에서 Always Use HTTPS를 켠다.
6. `.env`의 호스트를 실제 도메인으로 바꾼다(`*_SITE`/`*_HOST`는 `http://도메인`, `SITE_URL`·`CRM_PUBLIC_URL`은 `https://도메인`). `docker compose up -d`가 바뀐 값으로 다시 띄우고, builder가 새 주소로 사이트를 다시 만든다.

## Twenty

각 저장소 README의 "처음 설치/설정" 순서(관리자 계정 → 구성 스크립트 → 역할 키)를 `https://crm.<도메인>`에서 그대로 따른다. 구성 스크립트는 맥에서 돌린다.

```bash
cd ~/srv/<프로젝트>/crm   # 비로소는 crm/setup_clinic_objects.py
TWENTY_URL=https://crm.<도메인> TWENTY_API_KEY=<관리자 키> python3 <스크립트>
```

- Vercel 배포 훅 대신: Twenty 워크플로의 HTTP 요청을 `POST http://builder:8080/rebuild`, 헤더 `Authorization: Bearer <CRON_SECRET>`로 둔다. 빠져도 매일 03:00에 다시 빌드한다.
- 비로소 환불 워크플로: `POST http://api:8788/v1/orders/refund`, `Authorization: Bearer <ADMIN_SECRET>`.
- 렌탈ON 후기 링크 즉시 채우기: `POST http://lead-api:8787/v1/review-links`, `Authorization: Bearer <CRON_SECRET>`.
- 키를 `.env`에 넣은 뒤 `docker compose up -d`로 다시 띄운다. 키가 비어 있으면 API(비로소 `api`, 렌탈ON `lead-api`)는 뜨지 않고 재시작을 되풀이한다.

## 코드 반영

```bash
cd ~/srv/<프로젝트> && git pull && DOCKER_CONTEXT=colima-selfhost docker compose up -d --build
```

콘텐츠(품목, 글, FAQ)만 바뀐 경우는 재빌드 요청이나 03:00 자동 재빌드로 충분하다. 빌드가 실패하면 직전 사이트가 그대로 남는다(`docker compose logs builder`).

## 백업과 복원

- `infra/mac/backup.sh`가 Twenty DB(pg_dump), Twenty 업로드 파일, 접속기록·파기기록, Matomo DB, `.env`를 묶어 age 공개키(`BACKUP_AGE_RECIPIENTS`)로 암호화한다. 결과는 `~/srv/backups/<프로젝트>/`, 상태는 같은 폴더의 `status.log`, 실패하면 맥 알림이 뜬다.
- 복호화 개인키는 이 맥에 두지 않는다. 맥을 잃어버려도 백업 파일만으로는 내용을 볼 수 없게 하려는 것이다. 키는 비밀번호 관리자와 USB 등 두 곳에 둔다.
- 외장 디스크: `BACKUP_COPY_DIRS=/Volumes/<디스크>/selfhost-backups`(여러 곳은 `:`로 구분). 연결되지 않은 날은 건너뛰고 `status.log`에 SKIP을 남긴다. 외장 디스크는 APFS(암호화)로 포맷한다.
- 국내 클라우드: `rclone config`로 네이버 클라우드 Object Storage(S3 호환, 엔드포인트 `https://kr.object.ncloudstorage.com`) 리모트를 만들고 `BACKUP_RCLONE_REMOTE=<리모트>:<버킷>/<프로젝트>`. 버킷은 비공개로 두고 그 버킷만 쓸 수 있는 키를 쓴다.
- `BACKUP_KEEP_DAYS`(기본 30)일이 지난 백업은 지운다. 파기한 개인정보가 백업에 이 기간만큼 남으므로 처리방침에 적는다.
- 복원 테스트(분기마다 한 번, 그리고 실제 데이터를 넣은 직후):

```bash
cd ~/srv/<프로젝트>
DOCKER_CONTEXT=colima-selfhost infra/mac/restore-test.sh ~/srv/backups/<프로젝트>/<파일>.tar.age <개인키 파일>
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
2. Cloudflare에서 두 터널을 삭제(또는 토큰 재발급)한다. 다른 기기에서 같은 토큰으로 사이트를 가로챌 수 없게 된다.
3. Twenty API 키, 나이스페이 키, `CRON_SECRET`·`ADMIN_SECRET`·`REVIEW_LINK_SECRET`을 새로 만든다.
4. 다른 맥에서 "처음 설치"를 하고 최근 백업을 복원한다.
5. 개인정보 유출 가능성이 있으면 72시간 안에 신고·통지 의무가 있는지 확인한다(개인정보보호법 제34조). 한의원 건강정보는 민감정보다.
