# Double-hash data fix

Operational scripts for the production data fix described in `C:\Users\ehsan\.claude\plans\in-the-pins-lively-sphinx.md`.

The bug: the pinning-service Go code re-hashed `username` (already a `sha256(email)` user_id from the session) when writing pins and looking up credits, producing a "shadow" id `sha256(sha256(email))` that was disconnected from the WebUI's deposit pipeline. Code is fixed in `pinning-service/openapi/go/postgres_service.go` (sites 195, 358, 488, 1211, 1234, 1353, 1415).

## Scripts (run in order)

| Step | Script           | Writes? | Purpose |
|-----:|------------------|:-------:|---------|
| 0    | `00_proof.sh`    |  no    | Read-only / dry-run. Prints `VERDICT: PASS` or `VERDICT: FAIL`. Run BEFORE deploying code. |
| 1    | `01_backup.sh`   |  yes (host fs) | Full pg_dump + per-table dump + fingerprint. |
| 2    | `02_inspect.sh`  |  yes (`uid_migration_map` table) | Builds the forward map; prints integrity gates. |
| 3    | `03_migrate.sh` + `03_migrate.sql` | yes (transactional) | Interactive psql session. Operator pastes the SQL block-by-block, types `COMMIT;` or `ROLLBACK;` manually. |
| 4    | `04_verify.sh`   |  no    | Read-only post-commit checks against the fingerprint. |

## Order of operations on production

1. **Run `00_proof.sh`**. Must print `VERDICT: PASS`. If FAIL, stop.
2. **Pause the deduction job** (stop the WebUI service).
3. **Deploy the new pinning-service binary** (with the 7 `hashToken(username) → username` edits).
4. **Run `01_backup.sh`** — capture post-pause state.
5. **Run `02_inspect.sh`** — verify all integrity gates.
6. **Run `03_migrate.sh`** — paste `03_migrate.sql` block-by-block; type `COMMIT;` only if every check passes.
7. **Run `04_verify.sh <backup_dir>`** — confirm conservation invariants and per-user state.
8. **Resume the deduction job** (restart the WebUI).
9. **Live FxFiles upload test** — confirm the 402 is gone and the new pin lands at the real user_id.

## Required environment

```bash
export PGUSER=pinning_user
export PGDB=pinning_service
```

(Defaults match the production `postgres-pinning` Docker container env.)

## Recovery

If anything goes wrong DURING the migration:
- Operator types `ROLLBACK;` (or `ROLLBACK TO SAVEPOINT phase_N_xxx;`) inside the psql session — DB is unchanged.

If anything goes wrong AFTER COMMIT:
- Restore the full dump:
  ```bash
  docker exec -i postgres-pinning pg_restore -U "$PGUSER" -d "$PGDB" \
    --clean --if-exists < <BACKUP_DIR>/full_<DB>.dump
  ```
- The `<BACKUP_DIR>/full_<DB>.dump.sha256` file fingerprints the dump for tamper-detection.
