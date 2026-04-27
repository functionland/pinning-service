#!/usr/bin/env bash
# 03_migrate.sh — wrapper that opens an interactive psql session for the
# transactional migration. The operator pastes the contents of 03_migrate.sql
# block-by-block, reading verification results between phases, then types
# COMMIT; or ROLLBACK; manually at the end.
#
# Run AFTER 02_inspect.sh has shown all gates pass.
#
# Required env vars: PGUSER, PGDB

set -euo pipefail

: "${PGUSER:?set PGUSER}"
: "${PGDB:?set PGDB}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="${SCRIPT_DIR}/03_migrate.sql"

if [ ! -f "${SQL_FILE}" ]; then
  echo "ERROR: ${SQL_FILE} not found" >&2
  exit 1
fi

cat <<'EOF'
=========================================================================
  TRANSACTIONAL MIGRATION — interactive
=========================================================================
You are about to enter an interactive psql session.

  • All work runs inside ONE transaction (BEGIN ... COMMIT).
  • Each phase has a SAVEPOINT. ROLLBACK TO SAVEPOINT phase_N_xxx; rolls
    back just that phase.
  • Paste the SQL from 03_migrate.sql block-by-block (Phase 0, then 1, etc.)
  • Read every verification result before pasting the next block.
  • If anything looks wrong, type ROLLBACK; (or ROLLBACK TO SAVEPOINT ...;)
    and abort. The DB is unchanged.
  • If every check passes at the end, type COMMIT;

The SQL file is at: 03_migrate.sql

Press Enter to open psql, or Ctrl-C to abort.
EOF

read -r _

# -it requires a TTY. Use docker exec -it directly so the operator can paste.
exec docker exec -it postgres-pinning psql \
  -U "${PGUSER}" -d "${PGDB}" \
  -v ON_ERROR_STOP=1
