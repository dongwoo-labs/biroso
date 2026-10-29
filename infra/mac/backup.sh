#!/usr/bin/env bash
# 맥 셀프호스팅 암호화 백업. launchd가 매일 실행한다(infra/mac/README.md).
#   Twenty DB(pg_dump), Twenty 업로드 파일, 접속기록·파기기록, Matomo DB(있으면), .env
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

notify_fail() { osascript -e "display notification \"$project 백업 실패: $1\" with title \"셀프호스팅 백업\"" >/dev/null 2>&1 || true; echo "$(date -u +%FT%TZ) FAIL $1" >>"$dir/status.log"; }
trap 'notify_fail "줄 $LINENO"' ERR

mkdir -p "$dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
services=$(docker compose config --services)
has() { grep -qx "$1" <<<"$services"; }

docker compose exec -T twenty-db pg_dump -U twenty -Fc twenty >"$work/twenty.dump"
docker compose exec -T twenty-server tar -C /app/packages/twenty-server/.local-storage -cf - . >"$work/twenty-files.tar"
docker compose exec -T access-proxy tar -C /var/log/twenty-access -cf - . >"$work/access-logs.tar"
if has purge; then docker compose exec -T purge tar -C /var/log/purge -cf - . >"$work/purge-logs.tar"; fi
if has matomo-db; then docker compose exec -T matomo-db sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction matomo' >"$work/matomo.sql"; fi
cp .env "$work/env"

name="$project-$(date +%Y%m%d-%H%M%S).tar.age"
args=(); for r in $recipients; do args+=(-r "$r"); done
tar -C "$work" -cf - . | age "${args[@]}" >"$dir/$name.part"
mv "$dir/$name.part" "$dir/$name"
find "$dir" -name "$project-*.tar.age" -mtime +"$keep" -delete

IFS=: read -ra targets <<<"$copies"
for t in "${targets[@]}"; do
  [ -n "$t" ] || continue
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
echo "$(date -u +%FT%TZ) OK $name $(stat -f %z "$dir/$name")" >>"$dir/status.log"
