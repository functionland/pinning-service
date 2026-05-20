# Migration & Warm-Standby

Scripts for two distinct workflows:

1. **One-shot migration** (`migrate-zip.sh` + `recover.sh`) — bundle every artifact on an OLD server, ship it, and reconstruct the full stack on a NEW server. Old server is then decommissioned.
2. **Warm-standby replica** (`recover.sh --standby-bootstrap` + `standby/*`) — keep a passive second server continuously synced to the primary; promote it to primary with a single command on failover.

## Files in this directory

| File | Where it runs | Purpose |
|---|---|---|
| `migrate-zip.sh` | primary (old) | Snapshots configs, identities, env files, kubo blocks, cluster CRDT, postgres dump into a single `.tgz` bundle |
| `recover.sh` | new server | 27-phase restore from the bundle. Adds `--standby-bootstrap` for warm-standby setup |
| `setup-primary-for-replication.sh` | primary | One-time setup: enables WAL archiving + creates a `replicator` postgres role so a standby can pull WAL |
| `backup-db.sh` | primary (cron) | Daily encrypted DB dump to IPFS, published via IPNS |
| `restore-from-backup.sh` | any | Restore DB from the IPNS-published backup (disaster recovery path independent of the bundle) |
| `standby/` | standby | All warm-standby-specific scripts: sync orchestrator, per-category sync, preflight, failover, fence |

---

## Warm-standby setup (8 steps)

The warm-standby keeps a second server passively synced. Identity-bearing services (kubo, ipfs-cluster, fula-gateway, all fula-* systemd units) stay **stopped** on the standby until promotion; otherwise they'd collide with primary's peer IDs and corrupt the cluster CRDT.

1. **On primary** — one-time replication setup:
   ```bash
   sudo bash scripts/migration/setup-primary-for-replication.sh
   ```
   This enables WAL archiving, creates the `replicator` postgres role, and writes the role's password to `/root/.fula-replicator-password`. Restarts the postgres container once (~30s disruption).

2. **From primary → standby** — copy the replicator password:
   ```bash
   scp /root/.fula-replicator-password root@<standby>:/root/.fula-replicator-password
   ```

3. **On primary** — create a migration bundle (existing flow):
   ```bash
   sudo bash scripts/migration/migrate-zip.sh
   ```
   Produces `/tmp2/fula-migration-<UTC-timestamp>.tgz`.

4. **From primary → standby** — transfer the bundle:
   ```bash
   scp /tmp2/fula-migration-<UTC-timestamp>.tgz root@<standby>:/tmp2/
   ```

5. **On standby** — bootstrap as a warm replica:
   ```bash
   sudo bash scripts/migration/recover.sh \
     --standby-bootstrap \
     --primary-host <primary-hostname-or-ip> \
     --bundle /tmp2/fula-migration-<UTC-timestamp>.tgz \
     --backup-key <64-char hex> \
     --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
     --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q
   ```
   Restores every artifact but **never starts** kubo/cluster/fula-* services. Postgres comes up in hot-standby mode replaying WAL via the in-container `cp` restore command (host-side cron pulls WAL into a bind-mounted dir).

6. **On standby → primary** — the bootstrap prints the standby's SSH pubkey. Authorize it on primary:
   ```bash
   # On primary:
   echo "<paste pubkey from step 5 output>" >> ~root/.ssh/authorized_keys
   ```
   Verify SSH works from standby: `ssh -i /root/.ssh/standby_ed25519 root@<primary> hostname`

7. **On standby** — arm the sync cron:
   ```bash
   echo sync-enabled > /var/lib/fula-standby/MODE
   ```
   The hourly data sync and every-minute WAL puller now run automatically. Logs land in `/var/log/fula-standby-sync.log` and `/var/log/fula-standby-wal.log`.

8. **On standby** — failover, when primary is unavailable:
   ```bash
   sudo bash scripts/migration/standby/standby-failover.sh
   # or, to additionally try to stop primary's services first (best-effort, 15s timeout):
   sudo bash scripts/migration/standby/standby-failover.sh --with-fence
   ```
   Promotes postgres, starts kubo + cluster + fula-gateway (asserting peer-IDs match the bundle), rebuilds `node_modules`/binaries against synced sources, starts every systemd service, activates the deferred IPNS-publishing crons, and prints DNS-cutover instructions.

---

## One-shot migration (old workflow, unchanged)

If you're decommissioning the old server entirely (not running a warm standby):

1. **On old server**:
   ```bash
   sudo bash scripts/migration/migrate-zip.sh
   scp /tmp2/fula-migration-*.tgz root@<new-server>:/tmp2/
   ```

2. **On new server**:
   ```bash
   sudo bash scripts/migration/recover.sh \
     --bundle /tmp2/fula-migration-<UTC-timestamp>.tgz \
     --backup-key <64-char hex> \
     --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
     --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q \
     --ssl-email hi@fx.land
   ```

3. **Decommission old server** (after verifying new server serves traffic).

---

## File reference (where things live after bootstrap)

| Path | What |
|---|---|
| `/var/lib/fula-standby/MODE` | `bootstrap-complete` → `sync-enabled` → `promoted` |
| `/var/lib/fula-standby/deferred-cron/` | IPNS-publishing crons staged for failover |
| `/var/lib/fula-pg-wal-archive/` | Local WAL archive, bind-mounted into postgres as `/var/lib/pg-archive:ro` |
| `/etc/fula-standby/standby-config.sh` | Standby runtime config (PRIMARY_HOST, paths, SSH key) |
| `/etc/cron.d/fula-standby-sync` | Hourly data sync |
| `/etc/cron.d/fula-standby-wal-puller` | Every-minute WAL puller |
| `/etc/cron.d/fula-standby-wal-retention` | Daily WAL cleanup (>7 days) |
| `/root/.ssh/standby_ed25519` | SSH key for pulling from primary |
| `/var/log/fula-standby-sync.log` | Sync run log |
| `/var/log/fula-standby-wal.log` | WAL puller log |
| `/var/log/fula-standby-failover.log` | Failover run log |

---

## Troubleshooting

**Sync refuses with "peer-ID divergence"** — the standby's on-disk identity files don't match primary's. Either this standby was previously promoted (so identity files were rewritten when something repaired them), or the volumes weren't populated from the bundle correctly. Re-bootstrap from a fresh bundle.

**Postgres not replicating** — check `/var/log/fula-standby-wal.log` for SSH errors. The WAL puller runs every minute; if it's failing, postgres has no new segments to replay. `docker exec postgres-pinning psql -U postgres -c 'SELECT pg_is_in_recovery();'` should return `t`.

**Sync cron not firing** — check `/var/lib/fula-standby/MODE`. The preflight refuses unless it reads `sync-enabled`. After bootstrap, MODE starts at `bootstrap-complete` until you arm it.

**Cluster CRDT pause window too long** — check `/var/log/fula-standby-sync.log`. The pause is bounded to `tar` duration on primary (typically 1-5s). If you see >30s pauses, the cluster CRDT is unusually large; consider lowering the sync interval or contact upstream.

**Standby disk filling** — `/var/lib/fula-pg-wal-archive/` should plateau at ~7 days of WAL. If it grows linearly, the retention cron isn't running: `cat /etc/cron.d/fula-standby-wal-retention`.
