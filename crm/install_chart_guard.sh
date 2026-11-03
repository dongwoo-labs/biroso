#!/usr/bin/env bash
# 진료기록 DB 보호(crm/chart_guard.sql)를 공용 Twenty DB의 비로소 워크스페이스에 건다. 여러 번 실행해도 된다.
#   CRM_DIR=~/srv/crm crm/install_chart_guard.sh                       # 트리거·감사 테이블 설치(갱신)
#   CRM_DIR=~/srv/crm crm/install_chart_guard.sh --signer 원장@이메일   # 서명할 수 있는 원장 등록(워크스페이스 멤버 이메일)
#   CRM_DIR=~/srv/crm crm/install_chart_guard.sh --check               # 설치 상태·원장 목록·서명 증거 수
# setup_clinic_objects.py로 진료기록 객체를 만든 뒤 실행한다. 객체 칸을 바꿔도(필드 추가) 트리거는 그대로 남는다.
set -euo pipefail
cd "$(dirname "$0")"
CRM_DIR="${CRM_DIR:-$HOME/srv/crm}"
WS_SUBDOMAIN="${WS_SUBDOMAIN:-biroso}"
psql_crm() { (cd "$CRM_DIR" && docker compose exec -T twenty-db psql -U twenty -d twenty -v ON_ERROR_STOP=1 -X -q  "$@"); }

# 워크스페이스 스키마: core.dataSource(서브도메인 → 스키마). 없으면 _medicalRecord가 있는 유일한 스키마
WS=$(psql_crm -At -c "select ds.schema from core.\"dataSource\" ds join core.workspace w on w.id = ds.\"workspaceId\" where w.subdomain = '$WS_SUBDOMAIN' limit 1" 2>/dev/null || true)
if [ -z "$WS" ]; then
  WS=$(psql_crm -At -c "select table_schema from information_schema.tables where table_name = '_medicalRecord'")
  [ "$(printf '%s\n' "$WS" | grep -c .)" = 1 ] || { echo "진료기록 테이블이 있는 워크스페이스를 하나로 정하지 못했습니다: $WS" >&2; exit 1; }
fi
psql_crm -At -c "select 1 from information_schema.tables where table_schema = '$WS' and table_name = '_medicalRecord'" | grep -q 1 \
  || { echo "$WS 에 진료기록(_medicalRecord) 테이블이 없습니다. setup_clinic_objects.py를 먼저 실행하세요." >&2; exit 1; }

case "${1:-}" in
  --signer)
    email="${2:?원장 이메일}"
    psql_crm -v ws="$WS" -v email="$email" <<'SQL'
insert into chart_audit.signer(member_id, label)
select id, coalesce(nullif(btrim(concat_ws(' ', "nameFirstName", "nameLastName")), ''), "userEmail") || ' <' || "userEmail" || '>'
from :"ws"."workspaceMember" where lower("userEmail") = lower(:'email') and "deletedAt" is null
on conflict (member_id) do update set label = excluded.label
returning '원장 등록: ' || label;
SQL
    ;;
  --check)
    psql_crm -v ws="$WS" <<'SQL'
select '스키마' as k, :'ws' as v
union all select '트리거', count(*)::text from pg_trigger where tgname = 'chart_guard' and tgrelid = (quote_ident(:'ws') || '."_medicalRecord"')::regclass
union all select '원장', string_agg(label, ', ') from chart_audit.signer
union all select '서명 증거', count(*)::text from chart_audit.signature
union all select '변경 기록', count(*)::text from chart_audit.change_log;
SQL
    ;;
  "")
    psql_crm -v ws="$WS" <chart_guard.sql
    echo "진료기록 DB 보호를 설치했습니다($WS). 원장 등록: $0 --signer <이메일>"
    ;;
  *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
esac
