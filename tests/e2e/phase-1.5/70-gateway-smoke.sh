#!/usr/bin/env bash
# Gateway image smoke (fula-api PR #30 evidence): the freshly built
# fula-gateway:latest serves the S3 API against the adopted kubo + cluster.
set -uo pipefail
docker stop fula-gateway-smoke >/dev/null 2>&1
docker rm fula-gateway-smoke >/dev/null 2>&1
mkdir -p /opt/fula-master/gateway-data
docker run -d --name fula-gateway-smoke --network host \
  -e FULA_HOST=127.0.0.1 -e FULA_PORT=9000 \
  -e IPFS_API_URL=http://127.0.0.1:5001 \
  -e CLUSTER_API_URL=http://127.0.0.1:9094 \
  -e JWT_SECRET=smoke-test-secret-0123456789 \
  -v /opt/fula-master/gateway-data:/data \
  fula-gateway:latest >/dev/null
sleep 6
echo "== state ==";  docker inspect fula-gateway-smoke --format '{{.State.Status}}'
echo "== logs ==";   docker logs fula-gateway-smoke 2>&1 | head -8
echo "== S3 probe =="; curl -s -m 5 http://127.0.0.1:9000/ | head -3; echo
code="$(curl -s -m 5 -o /tmp/gwprobe.out -w '%{http_code}' http://127.0.0.1:9000/some-bucket/some-key)"
echo "bucket probe HTTP $code"
