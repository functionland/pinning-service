# Runbook — Federated Master: Fenced Failover + Resync (Phase 1.5, Stage A)

Stage A topology: **two masters you operate** (box #1 = current prod, box #2 =
`join-as-master.sh` stack), **one shared HA Postgres** (primary + replica),
cluster plane active-active (CRDT writers), S3/API plane **active-passive**.
Auto-failover arrives with bucket-root CAS (Phase 2.5); until then every flip
is **fenced and operator-confirmed** — this runbook is the fence.

## Invariants that make this safe
- Cron family (deduction/scanner) is leader-leased (`CRON_LEADER_LEASE=true`):
  the shared Postgres is the arbiter, so a partitioned ex-leader cannot run
  crons at all. Lease moves automatically when the holder's session dies.
- Billing is idempotent (`BILLING_IDEMPOTENCY=true`): replays/races deduct
  once per `(user, hour)`; deposits credit once per `(tx_hash, chain)`.
- The cluster pinset converges by CRDT regardless of which master is up.
- Snapshots (`pinset-snapshot.sh`) + sweep (`replication-sweep.sh`) run on the
  surviving master either way.

## FAILOVER (master #1 down or being taken down)
1. **Fence #1 first — never serve S3 writes from two masters:**
   - reachable: `systemctl stop fula-gateway fula-pinning-service fula-pinning-webui`
     (or `docker compose -f docker/master/docker-compose.master.yml stop` on a
     compose master). Cluster writer MAY stay up (CRDT-safe).
   - unreachable: verify it is actually dead from a third vantage point
     (provider console / ping / nginx upstream health), and confirm Postgres
     shows its sessions gone: `SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE '%pinning%';`
     If you cannot verify, power it off at the provider. **No verification, no flip.**
2. **Postgres:** if the primary was on #1, promote the replica
   (`pg_ctl promote` / your HA tooling) and point `/opt/fula-master/.env`
   `POSTGRES_HOST` at it; `docker compose ... up -d` re-reads it.
3. **Flip ingress:** move DNS / nginx upstream (s3., api., cloud.) to #2.
   TTLs should already be ≤60s.
4. **Verify (the drill suite is the checklist):**
   - upload + download via #2 (FxFiles flow), billing tick on #2
     (`docker logs fula-pinning-webui | grep 'acquired cron lease'`),
   - `SELECT user_id, reference_id, COUNT(*) FROM credit_history WHERE tx_type='hourly_deduction' AND created_at > now()-interval '2 hours' GROUP BY 1,2 HAVING COUNT(*)>1;`
     → must return **zero rows**,
   - `replication-sweep.sh --strict` clean.

## RESYNC (master #1 returns)
1. Bring up #1 **with its service stack stopped** (cluster writer may start —
   CRDT reconverges on its own; watch `ipfs-cluster-ctl peers ls`).
2. Postgres: re-join #1's DB as a **replica** of the current primary (never
   two primaries; re-clone with pg_basebackup if uncertain).
3. Let #1's pin queue drain if it had pending pins (gateway log:
   `pin_queue` drain lines; queue is per-master redb and survives restarts).
4. Decide who leads: to fail back, repeat FAILOVER in the other direction
   (fence #2 → flip). Otherwise leave #1 as the standby.
5. Confirm: sweep clean, no duplicate `(user, hour)` rows, snapshot cron
   running on exactly the active master.

## Hard rules
- Never run S3 writes on two masters concurrently before FM-1 (CAS) ships.
- Never un-fence by memory — verify, then flip.
- Same-identity warm standby (Phase 0) is DR for box #1 only; it must never
  run while #1 runs. Federation (this runbook) is a different mechanism.
