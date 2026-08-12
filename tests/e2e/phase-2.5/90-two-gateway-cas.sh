#!/usr/bin/env bash
#
# Phase 2.5 live two-gateway drill (TEST SERVER ONLY) — FM-1 end-to-end.
#
# Two fula-gateway processes (separate registries) against the SAME Postgres +
# kubo + cluster. Deterministic lost-update test (no concurrency-timing flake):
# gateway B's registry is deliberately STALE (it never saw A's write), which is
# exactly the cross-master hazard.
#
#   CONTROL (CAS OFF): A writes X, B (stale) writes Y → the bucket SPLITS:
#     reading via A shows only X, via B only Y → A's or B's write is lost.
#   FM-1 (CAS ON): same sequence → B opens at the SHARED root first, so the
#     bucket ends with BOTH X and Y on both gateways → no lost update.
#
# Requires the Phase-1.5 master stack (postgres/kubo/cluster) + a
# CAS-capable gateway image fula-gateway:p25 (built from phase-2.5-multimaster).
#
set -uo pipefail
PASS=0; FAIL=0
ok(){ echo "ok   - $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL - $1"; FAIL=$((FAIL+1)); }
. /opt/fula-master/.env

GWIMG="${GWIMG:-fula-gateway:p25}"
A_PORT=9020; B_PORT=9021
mint_jwt() {
  python3 - "$JWT_SECRET" <<'PYEOF'
import sys, hmac, hashlib, base64, json, time
def b(x): return base64.urlsafe_b64encode(x).rstrip(b"=")
s=sys.argv[1].encode()
h=b(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
p=b(json.dumps({"sub":"p25-2gw@fxe2e.local","scope":"storage:*","iat":int(time.time()),"exp":int(time.time())+3600}).encode())
print((h+b"."+p+b"."+b(hmac.new(s,h+b"."+p,hashlib.sha256).digest())).decode())
PYEOF
}
JWT="$(mint_jwt)"
JH="$(printf '%s' "$JWT" | sha256sum | cut -d' ' -f1)"
psqlc(){ docker exec -i postgres-pinning psql -U "${POSTGRES_USER:-pinning_user}" -d "${POSTGRES_DB:-pinning_service}" -tA -c "$1"; }
psqlc "INSERT INTO users (username,password_hash) VALUES ('p25u','x') ON CONFLICT DO NOTHING" >/dev/null 2>&1 || true
psqlc "INSERT INTO sessions (username,session_token,token_hash,expires_at) VALUES ('p25u','$JH','$JH',NOW()+interval '2 hours') ON CONFLICT DO NOTHING" >/dev/null 2>&1 || true

start_gw() { # $1=name $2=port $3=cas(true|)  $4=datadir
  docker rm -f "$1" >/dev/null 2>&1
  docker volume create "$4" >/dev/null
  docker run -d --name "$1" --network host -v "$4":/var/lib/fula-gateway \
    -e FULA_HOST=127.0.0.1 -e FULA_PORT="$2" \
    -e JWT_SECRET="$JWT_SECRET" \
    -e IPFS_API_URL=http://127.0.0.1:5001 -e CLUSTER_API_URL=http://127.0.0.1:9094 \
    -e STORAGE_API_URL=http://127.0.0.1:3001 -e PINNING_SERVICE_ENDPOINT=http://127.0.0.1:6000 \
    ${3:+-e FULA_BUCKET_ROOT_CAS=true} \
    -e POSTGRES_HOST=127.0.0.1 -e POSTGRES_PORT=5432 \
    -e POSTGRES_DB="${POSTGRES_DB:-pinning_service}" -e POSTGRES_USER="${POSTGRES_USER:-pinning_user}" -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    "$GWIMG" >/dev/null
  for i in $(seq 1 30); do curl -s -m3 "http://127.0.0.1:$2/healthz" >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}
mkbkt(){ curl -s -m20 -o /dev/null -w "%{http_code}" -X PUT "http://127.0.0.1:$1/$2" -H "Authorization: Bearer $JWT"; }
putobj(){ curl -s -m30 -o /dev/null -w "%{http_code}" -X PUT "http://127.0.0.1:$1/$2/$3" -H "Authorization: Bearer $JWT" --data-binary "$4"; }
listkeys(){ curl -s -m20 "http://127.0.0.1:$1/$2" -H "Authorization: Bearer $JWT" | grep -oE '<Key>[^<]+</Key>' | sed 's/<[^>]*>//g' | sort | tr '\n' ',' ; }

run_case() { # $1=label  $2=cas(true|"")  $3=bucket
  local cas="$2" bkt="$3"
  start_gw gwA "$A_PORT" "$cas" p25-gwA-data || { bad "$1 gwA start"; return; }
  start_gw gwB "$B_PORT" "$cas" p25-gwB-data || { bad "$1 gwB start"; return; }
  # Both create the bucket (separate registries) so both know it locally.
  mkbkt "$A_PORT" "$bkt" >/dev/null; mkbkt "$B_PORT" "$bkt" >/dev/null
  # A writes X; B (its registry never saw X) writes Y.
  cA=$(putobj "$A_PORT" "$bkt" objX "x-from-A"); cB=$(putobj "$B_PORT" "$bkt" objY "y-from-B")
  sleep 2
  # Read the final bucket via BOTH gateways.
  local va vb; va="$(listkeys "$A_PORT" "$bkt")"; vb="$(listkeys "$B_PORT" "$bkt")"
  echo "    [$1] putX=$cA putY=$cB | A-sees={$va} B-sees={$vb}"
  docker rm -f gwA gwB >/dev/null 2>&1
  echo "$va|$vb"
}

echo "== CONTROL: CAS OFF — expect a lost update (split bucket) =="
res="$(run_case control "" race-off)"
both_off_a="$(echo "$res" | tail -1 | cut -d'|' -f1)"; both_off_b="$(echo "$res" | tail -1 | cut -d'|' -f2)"
# Lost update == at least one gateway does NOT see both objX and objY.
if echo "$both_off_a" | grep -q objX && echo "$both_off_a" | grep -q objY && echo "$both_off_b" | grep -q objX && echo "$both_off_b" | grep -q objY; then
  bad "CONTROL should have lost an update but both gateways saw both objects"
else
  ok "CONTROL (CAS off): lost update reproduced (a gateway is missing an object)"
fi

echo "== FM-1: CAS ON — expect NO lost update (both objects on both gateways) =="
res="$(run_case fm1 true race-on)"
on_a="$(echo "$res" | tail -1 | cut -d'|' -f1)"; on_b="$(echo "$res" | tail -1 | cut -d'|' -f2)"
if echo "$on_a" | grep -q objX && echo "$on_a" | grep -q objY && echo "$on_b" | grep -q objX && echo "$on_b" | grep -q objY; then
  ok "FM-1 (CAS on): no lost update — both gateways see objX AND objY"
else
  bad "FM-1 should preserve both writes (A-sees={$on_a} B-sees={$on_b})"
fi

docker volume rm p25-gwA-data p25-gwB-data >/dev/null 2>&1
echo
echo "RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ] || exit 1
