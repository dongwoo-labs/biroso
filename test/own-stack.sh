#!/usr/bin/env bash
# 독립 PostgreSQL과 자체 API로 비로소 HTTP 경로를 검증한다.
set -euo pipefail
if [[ $# -ne 1 || ! -f "$1/services/api/server.mjs" ]]; then
  printf 'Usage: bash test/own-stack.sh <CRM checkout>\n' >&2
  exit 2
fi
case "$(docker context inspect colima --format '{{.Endpoints.docker.Host}}')" in
  unix://*/.colima/default/docker.sock) ;;
  *) printf 'Expected the local Colima context\n' >&2; exit 2;;
esac
biroso=$(cd "$(dirname "$0")/.." && pwd)
crm=$(cd "$1" && pwd)
export CRM_API_DB_OWNER_PASSWORD=$(openssl rand -hex 24)
export CRM_API_DB_BIROSO_PASSWORD=$(openssl rand -hex 24)
export CRM_API_DB_RENTALON_PASSWORD=$(openssl rand -hex 24)
export CRM_API_ACCESS='' CRM_API_ORIGINS='' CRM_API_TRUST_PROXY=0 CRM_API_TRASH_DAYS=''
export TWENTY_DB_PASSWORD='' TWENTY_APP_SECRET='' CRM_SERVER_URL=''
project="biroso-own-e2e-$$"
stack=(docker --context colima compose --env-file /dev/null -p "$project" -f "$crm/docker-compose.yml" --profile own-api)
printf 'Isolated project: %s\nCRM revision: %s\n' "$project" "$(git -C "$crm" rev-parse HEAD)"
trap '"${stack[@]}" stop api api-db' EXIT
"${stack[@]}" up --build -d --wait --wait-timeout 60 api
"${stack[@]}" run --rm --no-deps -e BIROSO_OWN_E2E=1 \
  -v "$biroso/server:/biroso/server:ro" -v "$biroso/test:/biroso/test:ro" \
  -v "$biroso/src/data:/biroso/src/data:ro" -v "$biroso/node_modules:/biroso/node_modules:ro" \
  api-migrate node --test /biroso/test/own-stack.e2e.mjs
