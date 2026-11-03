#!/usr/bin/env bash
# 맥 셀프호스팅 암호화 백업. launchd가 매일 실행한다(infra/mac/README.md).
#   그 프로젝트에 있는 것만: Twenty DB(pg_dump)·업로드 파일·접속기록·DB 감사 로그(crm), 파기기록·Matomo DB(rentalon), 진료기록 봉인 장부(biroso), .env
# 진료기록 장기 보존: 매달 첫 백업 때 진료기록과 접속기록·감사 로그만 따로 묶어(chart-archive) BACKUP_ARCHIVE_DIRS·BACKUP_ARCHIVE_RCLONE_REMOTE에
#   지우지 않고 쌓는다. 전체 백업(30일 순환)과 달리 파기한 개인정보가 들어가지 않는다(진료기록이 있는 환자는 파기하지 않는다).
#   진료기록 보존기간(10년)이 지난 묶음은 README '보존·파기' 절차로 사람이 확인하고 지운다.
# 묶은 파일을 .env의 BACKUP_AGE_RECIPIENTS(age 공개키)로만 암호화한다. 풀 수 있는 개인키는 이 맥에 두지 않는다.
# 결과: BACKUP_DIR/<프로젝트>-<시각>.tar.age, 같은 파일을 BACKUP_COPY_DIRS(외장 디스크 등)와 BACKUP_RCLONE_REMOTE(국내 클라우드)에 복사
# BACKUP_KEEP_DAYS(기본 30)일이 지난 백업은 지운다. 처리방침의 "파기 후 백업 보관 기간"과 맞춘다.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
envval() { sed -n "s/^$1=//p" .env | tail -1; }

project=$(docker compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
recipients=$(envval BACKUP_AGE_RECIPIENTS)
dir=$(envval BACKUP_DIR); dir=${dir:-$HOME/srv/backups/$project}
keep=$(envval BACKUP_KEEP_DAYS); keep=${keep:-30}
copies=$(envval BACKUP_COPY_DIRS)
remote=$(envval BACKUP_RCLONE_REMOTE)
[ -n "$recipients" ] || { echo "BACKUP_AGE_RECIPIENTS가 비어 있습니다" >&2; exit 1; }

mkdir -p "$dir"
work=$(mktemp -d)
# 실패하면 알림을 띄우고 status.log에 남긴다. 평문 작업 폴더는 성공·실패와 관계없이 지운다.
finish() {
  local rc=$?
  rm -rf "$work"
  if [ "$rc" -ne 0 ]; then
    echo "$(date -u +%FT%TZ) FAIL exit $rc" >>"$dir/status.log"
    osascript -e "display notification \"$project 백업 실패 (exit $rc)\" with title \"셀프호스팅 백업\"" >/dev/null 2>&1 || true
  fi
}
trap finish EXIT
services=$(docker compose config --services)
has() { grep -qx "$1" <<<"$services"; }

if has twenty-db; then
  docker compose exec -T twenty-db pg_dump -U twenty -Fc twenty >"$work/twenty.dump"
  docker compose exec -T twenty-server tar -C /app/packages/twenty-server/.local-storage -cf - . >"$work/twenty-files.tar"
  docker compose exec -T access-proxy tar -C /var/log/twenty-access -cf - . >"$work/access-logs.tar"
  # DB 접속·감사 로그(pgaudit). 이미지가 crm/twenty-db:local이 아니면 없다
  docker compose exec -T twenty-db sh -c 'test -d /var/log/postgresql && tar -C /var/log/postgresql -cf - .' >"$work/pg-logs.tar" 2>/dev/null || rm -f "$work/pg-logs.tar"
fi
# 비로소: 진료기록 봉인 장부·검사 이력(내용은 이미 암호화돼 있고, 백업 전체를 한 번 더 age로 묶는다). 장부는 늘기만 해서 최신 백업 하나에 전부 있다.
if has api && docker compose exec -T api test -d /data/charts 2>/dev/null; then docker compose exec -T api tar -C /data/charts -cf - . >"$work/charts.tar"; fi
if has purge; then docker compose exec -T purge tar -C /var/log/purge -cf - . >"$work/purge-logs.tar"; fi
if has matomo-db; then docker compose exec -T matomo-db sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction matomo' >"$work/matomo.sql"; fi
cp .env "$work/env"

name="$project-$(date +%Y%m%d-%H%M%S).tar.age"
args=(); for r in $recipients; do args+=(-r "$r"); done
tar -C "$work" -cf - . | age "${args[@]}" >"$dir/$name.part"
mv "$dir/$name.part" "$dir/$name"
find "$dir" -name "$project-*.tar.age" -mtime +"$keep" -delete

for t in $(tr ':' ' ' <<<"$copies"); do
  if [ -d "$(dirname "$t")" ]; then
    mkdir -p "$t" && cp "$dir/$name" "$t/" && find "$t" -name "$project-*.tar.age" -mtime +"$keep" -delete
  else
    echo "$(date -u +%FT%TZ) SKIP $t (연결 안 됨)" >>"$dir/status.log"
  fi
done
if [ -n "$remote" ]; then
  rclone copy "$dir/$name" "$remote"
  rclone delete --min-age "${keep}d" --include "$project-*.tar.age" "$remote"
fi
# 진료기록 장기 보존 묶음(매달 한 번, 지우지 않음)
archive_dirs=$(envval BACKUP_ARCHIVE_DIRS)
archive_remote=$(envval BACKUP_ARCHIVE_RCLONE_REMOTE)
month=$(date +%Y%m)
if [ -n "$archive_dirs$archive_remote" ] && ! ls "$dir"/chart-archive-"$project-$month"*.tar.age >/dev/null 2>&1; then
  # 평문 CSV는 $work 아래에 둔다(성공·실패 모두 EXIT에서 지워짐)
  arch="$work/archive"; mkdir -p "$arch"
  # crm: 진료기록 테이블(모든 판)·서명 증거·변경 기록·진료기록이 있는 환자 인적사항
  if has twenty-db && ws=$(docker compose exec -T twenty-db psql -U twenty -d twenty -Atc "select table_schema from information_schema.tables where table_name='_medicalRecord' limit 1") && [ -n "$ws" ]; then
    q() { docker compose exec -T twenty-db psql -U twenty -d twenty -c "\\copy ($1) to stdout with csv header" >"$arch/$2.csv"; }
    q "select * from \"$ws\".\"_medicalRecord\" order by \"visitAt\", \"chainId\", version" medical-records
    q "select p.id, p.\"chartNo\", p.\"nameLastName\", p.\"nameFirstName\", p.\"birthDate\", p.\"phonesPrimaryPhoneNumber\" from \"$ws\".person p where exists (select 1 from \"$ws\".\"_medicalRecord\" m where m.\"customerId\" = p.id)" patients
    for t in signer signature change_log; do q "select * from chart_audit.$t order by 1" "chart-audit-$t"; done
  fi
  # 접속기록·DB 감사 로그(2년 이상 보관, 안전성 확보조치 기준 제8조)와 봉인 장부·점검 기록도 함께. 묶음마다 처음부터 지금까지 전체
  for f in access-logs.tar pg-logs.tar charts.tar; do if [ -f "$work/$f" ]; then cp "$work/$f" "$arch/"; fi; done
  if [ -n "$(ls -A "$arch")" ]; then
    aname="chart-archive-$project-$month-$(date +%d%H%M%S).tar.age"
    # 모든 보관 위치에 복사한 뒤에만 완성 이름으로 바꾼다. 중간에 실패하면 다음 실행이 이달 묶음을 다시 만든다
    part="$work/$aname"
    tar -C "$arch" -cf - . | age "${args[@]}" >"$part"
    for t in $(tr ':' ' ' <<<"$archive_dirs"); do mkdir -p "$t"; cp "$part" "$t/"; done
    if [ -n "$archive_remote" ]; then rclone copyto "$part" "$archive_remote/$aname"; fi
    mv "$part" "$dir/$aname"
    echo "$(date -u +%FT%TZ) ARCHIVE $aname" >>"$dir/status.log"
  fi
fi
echo "$(date -u +%FT%TZ) OK $name $(wc -c <"$dir/$name" | tr -d ' ')" >>"$dir/status.log"
