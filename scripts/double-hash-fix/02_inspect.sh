#!/usr/bin/env bash
# 02_inspect.sh — read-only pre-flight inspection. Builds the migration map
# and prints integrity gates the operator must verify before running 03.
#
# Run AFTER 01_backup.sh, BEFORE 03_migrate.sh.
#
# Required env vars: PGUSER, PGDB

set -euo pipefail

: "${PGUSER:?set PGUSER}"
: "${PGDB:?set PGDB}"

PSQL=(docker exec -i postgres-pinning psql -U "${PGUSER}" -d "${PGDB}" -v ON_ERROR_STOP=1)

# Precondition: pgcrypto must be installed.
if ! "${PSQL[@]}" -At -c "SELECT 1 FROM pg_extension WHERE extname='pgcrypto';" | grep -q 1; then
  echo "ERROR: pgcrypto not installed. Run as superuser:" >&2
  echo "  docker exec -i postgres-pinning psql -U postgres -d ${PGDB} -c 'CREATE EXTENSION pgcrypto;'" >&2
  exit 1
fi

# Build / rebuild the forward map in a regular (non-temp) table so it survives
# across script runs in the same migration window. Re-runnable.
#
# Enumeration sources are user_id-bearing tables we expect to hold
# single-hashed user_ids (sha256(lowercase_email)). After collecting candidates
# we apply a SELF-SHADOW FILTER: any candidate that is mathematically the
# sha256 of ANOTHER candidate is excluded. By SHA-256 collision-resistance
# this only happens when the value is a TRUE shadow (e.g., a manual operator
# top-up of a shadow user_credits row, or an auto-created shadow that later
# accidentally received a deposit).
"${PSQL[@]}" <<'SQL'
DROP TABLE IF EXISTS uid_migration_map;
CREATE TABLE uid_migration_map (
  real_id   VARCHAR(64) PRIMARY KEY,
  shadow_id VARCHAR(64) UNIQUE NOT NULL,
  source    TEXT NOT NULL
);

CREATE TEMP TABLE _candidates_raw AS
          SELECT user_id, 'sessions'           AS src FROM sessions           WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'users'              AS src FROM users              WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'webui_users'        AS src FROM webui_users        WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'user_wallets'       AS src FROM user_wallets       WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'user_credits'       AS src FROM user_credits       WHERE user_id IS NOT NULL AND user_id <> '' AND total_deposited_fula > 0
UNION ALL SELECT user_id, 'api_keys'           AS src FROM api_keys           WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'referral_codes'     AS src FROM referral_codes     WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'token_transactions' AS src FROM token_transactions WHERE user_id IS NOT NULL AND user_id <> ''
UNION ALL SELECT user_id, 'ai_generations'     AS src FROM ai_generations     WHERE user_id IS NOT NULL AND user_id <> '';

CREATE TEMP TABLE _candidates AS
SELECT user_id,
       string_agg(DISTINCT src, ',') AS source,
       encode(digest(user_id, 'sha256'), 'hex') AS shadow_id
FROM _candidates_raw
GROUP BY user_id;

-- Apply the self-shadow filter.
INSERT INTO uid_migration_map (real_id, shadow_id, source)
SELECT c.user_id, c.shadow_id, c.source
FROM _candidates c
WHERE NOT EXISTS (
  SELECT 1 FROM _candidates c2 WHERE c2.shadow_id = c.user_id
);

-- Diagnostic: show what was filtered out and why.
\echo
\echo '=== Candidates filtered out as detected self-shadows ==='
\echo '  Each row: a value that appeared as a candidate real_id but is the'
\echo '  sha256 of another candidate. Such values are TRUE shadows by'
\echo '  SHA-256 collision-resistance — they are excluded from the migration'
\echo '  map and will be MERGED into their real_id during 03_migrate.sh.'
SELECT c.user_id  AS filtered_id,
       c.source   AS filtered_source,
       c2.user_id AS real_id_it_is_shadow_of,
       c2.source  AS real_id_source
FROM _candidates c
JOIN _candidates c2 ON c2.shadow_id = c.user_id;

\echo
\echo '=== Map cardinality ==='
SELECT 'distinct_real_ids' AS metric, COUNT(*) AS v FROM uid_migration_map;

\echo
\echo '=== INTEGRITY CHECK 1: shadow_id collisions with REAL ids ==='
\echo '  Must be 0. Otherwise a shadow id equals another user real id and'
\echo '  the migration would move pins to the wrong owner.'
SELECT 'CHECK_collision_shadow_eq_real' AS check_name, COUNT(*) AS n
FROM uid_migration_map m
WHERE EXISTS (SELECT 1 FROM uid_migration_map m2 WHERE m2.real_id = m.shadow_id);

\echo
\echo '=== INTEGRITY CHECK 1b: legacy raw-email user_ids in pins ==='
\echo '  Must be 0. After the code change, reads use sha256(input) and never'
\echo '  match a raw email. Non-zero means those pins need separate cleanup.'
SELECT 'CHECK_legacy_raw_email_user_ids' AS check_name, COUNT(*) AS n
FROM pins WHERE user_id LIKE '%@%';

\echo
\echo '=== INTEGRITY CHECK 2: orphan shadow ids in pins NOT in our map ==='
\echo '  These are pins whose real id we could not enumerate from sessions/users/'
\echo '  webui_users/user_wallets/user_credits. They will NOT be touched by 03.'
\echo '  If unmapped_user_ids > 0, decide per-case before proceeding (see plan).'
SELECT 'CHECK_unmapped_pins_user_ids' AS check_name,
       COUNT(*)                       AS unmapped_user_ids,
       COALESCE(SUM(c.cnt), 0)        AS pins_affected,
       COALESCE(SUM(c.sz), 0)         AS bytes_affected
FROM (
  SELECT p.user_id, COUNT(*) AS cnt, SUM(p.size) AS sz
  FROM pins p
  WHERE p.user_id IS NOT NULL AND p.user_id <> ''
    AND p.user_id NOT IN (SELECT real_id   FROM uid_migration_map)
    AND p.user_id NOT IN (SELECT shadow_id FROM uid_migration_map)
  GROUP BY p.user_id
) c;

\echo
\echo '=== Sample mapping (top 100 by pins_at_shadow) ==='
\echo '  Verify the two reported suspended ids appear here as shadow_id:'
\echo '    bf1d001f668c11f95da6c9e78b6d241733a50f201d0deac0549161d2b1d1796c'
\echo '    3fd26ed0fa8c266e48cb11267d32cc19ef667444358998452b9ce8de43bcfe28'
SELECT m.real_id,
       m.shadow_id,
       m.source,
       (SELECT COUNT(*) FROM pins p WHERE p.user_id = m.shadow_id) AS pins_at_shadow,
       (SELECT COUNT(*) FROM pins p WHERE p.user_id = m.real_id)   AS pins_at_real,
       EXISTS (SELECT 1 FROM user_credits uc WHERE uc.user_id = m.shadow_id) AS has_shadow_credits,
       EXISTS (SELECT 1 FROM user_credits uc WHERE uc.user_id = m.real_id)   AS has_real_credits
FROM uid_migration_map m
ORDER BY pins_at_shadow DESC NULLS LAST
LIMIT 100;
SQL

cat <<'EOF'

=== OPERATOR — verify before running 03_migrate.sh ===
  • CHECK_collision_shadow_eq_real        must be 0
  • CHECK_legacy_raw_email_user_ids       must be 0
  • CHECK_unmapped_pins_user_ids:
      - unmapped_user_ids = 0 → perfect
      - else: decide per-case (add to map manually, or accept stuck-shadow data)
  • Both reported suspended ids appear as shadow_id in the sample listing

If all gates pass, proceed to 03_migrate.sh.
EOF
