#!/usr/bin/env bash
set -uo pipefail
. /opt/fula-master/.env
docker run --rm --network host -v /root/pinning-service/pinning-webui:/app -w /app \
  -e POSTGRES_HOST=127.0.0.1 -e POSTGRES_PORT=5432 \
  -e POSTGRES_DB="${POSTGRES_DB:-pinning_service}" -e POSTGRES_USER="${POSTGRES_USER:-pinning_user}" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  node:22 bash -c "set -o pipefail; npx vitest run tests/fm2-billing-integration.test.ts 2>&1 | tail -30"
echo "runner rc=$?"
