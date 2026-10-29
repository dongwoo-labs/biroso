#!/usr/bin/env bash
# 백업 복원 테스트. 백업 파일을 풀어 임시 PostgreSQL(네트워크 없음)에 복원하고,
# 워크스페이스별 사람(person) 수를 지금 운영 DB와 나란히 보여 준 뒤 임시 컨테이너와 파일을 지운다.
# 사용: infra/mac/restore-test.sh <백업.tar.age> <age 개인키 파일>
#   개인키는 USB나 비밀번호 관리자에서 잠깐 꺼내 쓰고, 끝나면 이 맥에서 지운다.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
backup=$1 identity=$2
work=$(mktemp -d)
name="restore-test-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

age -d -i "$identity" "$backup" | tar -C "$work" -xf -
ls -l "$work"
docker run -d --name "$name" --network none -e POSTGRES_PASSWORD=restore -e POSTGRES_USER=twenty -e POSTGRES_DB=twenty postgres:16 >/dev/null
for _ in $(seq 60); do docker exec "$name" pg_isready -U twenty >/dev/null 2>&1 && break; sleep 1; done
sleep 2
docker exec -i "$name" pg_restore -U twenty -d twenty --no-owner <"$work/twenty.dump"

count_sql="select string_agg(format('select %L as ws, count(*) from %I.person', schema_name, schema_name), ' union all ') from information_schema.schemata where schema_name like 'workspace\_%'"
counts() {
  local q
  echo "core 테이블 $("$@" psql -U twenty -d twenty -Atc "select count(*) from information_schema.tables where table_schema='core'")개"
  q=$("$@" psql -U twenty -d twenty -Atc "$count_sql")
  if [ -n "$q" ]; then "$@" psql -U twenty -d twenty -Atc "$q order by 1"; else echo "(워크스페이스 없음)"; fi
}
echo "== 복원본 (워크스페이스|person 수)"; counts docker exec "$name"
echo "== 운영 DB (지금)"; counts docker compose exec -T twenty-db
for f in twenty-files.tar access-logs.tar; do [ -f "$work/$f" ] && echo "$f: $(tar -tf "$work/$f" | wc -l | tr -d ' ')개 항목"; done
echo "복원 테스트 끝: $(basename "$backup")"
