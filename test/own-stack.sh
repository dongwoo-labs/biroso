#!/usr/bin/env bash
# 독립 PostgreSQL과 자체 API로 비로소 HTTP 경로를 검증한다.
set -euo pipefail
if [[ $# -ne 1 || ! -f "$1/services/api/server.mjs" ]]; then
  printf 'Usage: bash test/own-stack.sh <CRM checkout>\n' >&2
  exit 2
fi
case "$(docker --context colima context inspect colima --format '{{.Endpoints.docker.Host}}')" in
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
project="biroso-own-e2e-$(openssl rand -hex 6)"
stack=(docker --context colima compose --env-file /dev/null -p "$project" -f "$crm/docker-compose.yml" -f /dev/stdin --profile own-api)
# 로컬 캐시에서 의존성만 가져온다. 잠금 파일이 다르면 외부로 내려받지 않고 중단한다.
cache=${CRM_API_CACHE_IMAGE:-crm-t10038-final-api:latest}
cache_id=$(docker --context colima image inspect --format '{{.Id}}' "$cache")
docker --context colima image inspect postgres:16 node:24-bookworm-slim >/dev/null
printf 'Isolated project: %s\nCRM revision: %s\n' "$project" "$(git -C "$crm" rev-parse HEAD)"
DOCKER_BUILDKIT=0 docker --context colima build --network none -t "$project-api" -f - "$crm/services/api" <<DOCKERFILE
FROM $cache_id AS deps
FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package-lock.json /tmp/crm-api-lock
COPY . .
RUN cmp /tmp/crm-api-lock package-lock.json
USER node
CMD ["node", "server.mjs"]
DOCKERFILE

# Colima 기본 주소 풀이 가득 차도 독립 프로젝트를 만들 수 있도록 시험용 /28을 지정한다.
subnet="198.$((18 + RANDOM % 2)).$((RANDOM % 256)).$((16 * (RANDOM % 16)))/28"
compose() {
  "${stack[@]}" "$@" <<YAML
networks:
  own-api:
    ipam:
      config: [{subnet: $subnet}]
services:
  api:
    build: !reset null
    image: $project-api
    networks: !override [own-api]
  api-migrate:
    build: !reset null
    image: $project-api
YAML
}
trap 'compose stop api api-db' EXIT
compose up --no-build --pull never -d --wait --wait-timeout 60 api
compose run -T --rm --no-deps --pull never -e BIROSO_OWN_E2E=1 \
  -v "$biroso/server:/biroso/server:ro" -v "$biroso/test:/biroso/test:ro" \
  -v "$biroso/src/data:/biroso/src/data:ro" -v "$biroso/node_modules:/biroso/node_modules:ro" \
  api-migrate node --test /biroso/test/own-stack.e2e.mjs
