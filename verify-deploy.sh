#!/bin/bash
#
# Post-deployment verification for security audit changes
# Run this after deployment to confirm everything is working
#

DB_USER="${DB_USER:-pinning_user}"
DB_NAME="${DB_NAME:-pinning_service}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

check_pass() { echo -e "${GREEN}  PASS${NC} $1"; ((PASS++)); }
check_fail() { echo -e "${RED}  FAIL${NC} $1"; ((FAIL++)); }
check_warn() { echo -e "${YELLOW}  WARN${NC} $1"; ((WARN++)); }

echo ""
echo -e "${BOLD}Pinning Service — Deployment Verification${NC}"
echo ""

# ============================================
# 1. Service Status
# ============================================
echo -e "${BOLD}Services:${NC}"

SERVICES=("x402-gateway" "fula-pinning-webui" "fula-upload-server" "fula-ai-service" "fula-pinning-service")
for svc in "${SERVICES[@]}"; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        check_pass "$svc running"
    elif systemctl is-enabled --quiet "$svc" 2>/dev/null; then
        check_fail "$svc not running (enabled but stopped)"
    else
        check_warn "$svc not installed"
    fi
done

# ============================================
# 2. Database Migrations
# ============================================
echo ""
echo -e "${BOLD}Database Migrations:${NC}"

# Migration 006: encrypted_key column
if psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT column_name FROM information_schema.columns WHERE table_name='api_keys' AND column_name='encrypted_key'" 2>/dev/null | grep -q "encrypted_key"; then
    check_pass "Migration 006: api_keys.encrypted_key column exists"
else
    check_fail "Migration 006: api_keys.encrypted_key column MISSING"
fi

# Migration 007: delete_attempts column
if psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT column_name FROM information_schema.columns WHERE table_name='x402_ephemeral_objects' AND column_name='delete_attempts'" 2>/dev/null | grep -q "delete_attempts"; then
    check_pass "Migration 007: x402_ephemeral_objects.delete_attempts column exists"
else
    check_fail "Migration 007: x402_ephemeral_objects.delete_attempts column MISSING"
fi

# Migration 008: admin_audit_log table
if psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT tablename FROM pg_tables WHERE tablename='admin_audit_log'" 2>/dev/null | grep -q "admin_audit_log"; then
    check_pass "Migration 008: admin_audit_log table exists"
else
    check_fail "Migration 008: admin_audit_log table MISSING"
fi

# ============================================
# 3. Recent Errors (last 5 minutes)
# ============================================
echo ""
echo -e "${BOLD}Recent Errors (last 5 min):${NC}"

for svc in "${SERVICES[@]}"; do
    if ! systemctl is-enabled --quiet "$svc" 2>/dev/null; then
        continue
    fi
    ERR_COUNT=$(journalctl -u "$svc" --since "5 min ago" -p err --no-pager 2>/dev/null | grep -c "" || echo "0")
    if [ "$ERR_COUNT" -gt 0 ]; then
        check_warn "$svc has $ERR_COUNT error(s) — run: journalctl -u $svc --since '5 min ago' -p err"
    else
        check_pass "$svc no errors"
    fi
done

# ============================================
# Summary
# ============================================
echo ""
echo -e "${BOLD}────────────────────────────${NC}"
TOTAL=$((PASS + FAIL + WARN))
echo -e "  ${GREEN}$PASS passed${NC}  ${RED}$FAIL failed${NC}  ${YELLOW}$WARN warnings${NC}  ($TOTAL checks)"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo -e "${RED}${BOLD}Action required:${NC} Fix the failed checks above."
    echo "  To apply missing migrations:"
    echo "    psql -U $DB_USER -d $DB_NAME -f migrations/postgres/006_encrypted_api_keys.sql"
    echo "    psql -U $DB_USER -d $DB_NAME -f migrations/postgres/007_cleanup_retry.sql"
    echo "    psql -U $DB_USER -d $DB_NAME -f migrations/postgres/008_admin_audit_log.sql"
    exit 1
fi

echo ""
exit 0
