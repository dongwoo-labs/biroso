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
export CRM_API_BUILDER_TOKEN=$(node -p 'require("node:crypto").randomBytes(32).toString("base64url")')
export CRM_API_REBUILD_BIROSO_SECRET=$(openssl rand -hex 24)
export CRM_API_REBUILD_BIROSO_URL=http://biroso-builder:8080/rebuild
project="biroso-own-e2e-$(openssl rand -hex 6)"
stack=(docker --context colima compose --env-file /dev/null -p "$project" -f "$crm/docker-compose.yml" -f /dev/stdin --profile own-api)
# 로컬 캐시에서 의존성만 가져온다. 잠금 파일이 다르면 외부로 내려받지 않고 중단한다.
cache=${CRM_API_CACHE_IMAGE:-crm-t10038-final-api:latest}
cache_id=$(docker --context colima image inspect --format '{{.Id}}' "$cache")
site_cache=${BIROSO_SITE_CACHE_IMAGE:-biroso/site:own-e2e-deps}
site_cache_id=$(docker --context colima image inspect --format '{{.Id}}' "$site_cache")
docker --context colima image inspect postgres:16 node:24-bookworm-slim node:22-alpine >/dev/null
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

DOCKER_BUILDKIT=0 docker --context colima build --network none -t "$project-site" -f - "$biroso" <<DOCKERFILE
FROM $site_cache_id AS deps
FROM node:22-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package-lock.json /tmp/biroso-site-lock
COPY . .
RUN cmp /tmp/biroso-site-lock package-lock.json
DOCKERFILE

# Colima 기본 주소 풀이 가득 차도 독립 프로젝트를 만들 수 있도록 시험용 /28 두 개를 지정한다.
subnet="198.18.$((RANDOM % 256)).$((16 * (RANDOM % 16)))/28"
egress="198.19.$((RANDOM % 256)).$((16 * (RANDOM % 16)))/28"
compose() {
  "${stack[@]}" "$@" <<YAML
networks:
  own-api:
    ipam:
      config: [{subnet: $subnet}]
  own-api-egress:
    internal: true
    ipam:
      config: [{subnet: $egress}]
volumes:
  fixture-site: {}
services:
  api:
    build: !reset null
    image: $project-api
    environment:
      # 별도 시험용 API에서 직원의 콘텐츠 쓰기와 실제 커밋 훅을 실행한다.
      CRM_API_REBUILD_BIROSO_URL: ""
      CRM_API_REBUILD_BIROSO_SECRET: ""
    networks: !override
      own-api: {}
      own-api-egress:
        aliases: [crm-own-api]
  api-migrate:
    build: !reset null
    image: $project-api
    networks: !override [own-api, own-api-egress]
    volumes: [fixture-site:/site:ro]
  biroso-builder:
    image: $project-site
    networks: [own-api-egress]
    volumes: [fixture-site:/site]
    environment:
      ASTRO_TELEMETRY_DISABLED: "1"
      CRM_BACKEND: own
      CRM_API_URL: http://crm-own-api:3300
      CRM_API_BUILDER_TOKEN: \${CRM_API_BUILDER_TOKEN}
      CRON_SECRET: \${CRM_API_REBUILD_BIROSO_SECRET}
    command:
      - sh
      - -ec
      - |
        mkdir -p /site/releases/twenty
        printf 'Twenty 격리 표본' > /site/releases/twenty/index.html
        ln -s releases/twenty /site/current
        exec node infra/builder.mjs
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 1s
      retries: 10
YAML
}
trap 'compose stop biroso-builder api api-db' EXIT
compose up --no-build --pull never -d --wait --wait-timeout 60 api biroso-builder
compose run -T --rm --no-deps --pull never -e BIROSO_OWN_E2E=1 -e CRM_API_BUILDER_TOKEN \
  -e CRM_API_REBUILD_BIROSO_URL -e CRM_API_REBUILD_BIROSO_SECRET \
  -v "$biroso/server:/biroso/server:ro" -v "$biroso/test:/biroso/test:ro" \
  -v "$biroso/src/data:/biroso/src/data:ro" -v "$biroso/node_modules:/biroso/node_modules:ro" \
  api-migrate node --test /biroso/test/own-stack.e2e.mjs
