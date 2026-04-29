# Server Migration / Recovery Guide

End-to-end procedure for migrating the Fula Cloud stack (pinning-service, fula-api gateway,
ipfs/ipfs-cluster, x402-gateway, fula-ai-service, mainnet-pool-server, mainnet-rewards-server,
libp2p-service) from one Ubuntu host to another with **identity preservation, zero data loss,
and certs that survive the cutover**.

Two scripts:

| Script | Runs on | Purpose |
|---|---|---|
| [`scripts/migrate-zip.sh`](scripts/migrate-zip.sh) | OLD server | Snapshots every config, identity, key, dump, and (optionally) the IPFS block dataset into a single tarball |
| [`scripts/recover.sh`](scripts/recover.sh) | NEW server | Ingests the tarball, places every artifact at the exact path it lived at on the old server, brings up all services, runs a 13-section health verification |

---

## Decision flow — which scenario fits you?

```
  Do you still have access to the old server?
    YES ──> Standard migration path (Sections 1-5 of this doc)
    NO  ──> Disaster recovery path (Section 6 of this doc — uses IPNS-stored backup only)

  If YES: Are pins growing past your main SSD?
    NO  ──> Default install (recover.sh with no extra storage flags)
    YES ──> Mount external drive first; use --kubo-data-host-path

  If YES: Do you want to validate the new server BEFORE switching DNS?
    NO  ──> Plain migration; DNS cutover happens during recover.sh phase 24
    YES ──> Use --defer-dns; test via /etc/hosts on a laptop; later run --phase=certs
```

---

## Pre-flight checklist (do this first)

Before touching either server, gather:

- [ ] **`BACKUP_ENCRYPTION_KEY`** — the 64-character hex string used by the daily `backup-db.sh` cron. If it's not in your password manager, on the old server check `cat /root/.fula-backup-key`.
- [ ] **DB IPNS name** — `k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9`
- [ ] **Registry IPNS name** — `k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q`
- [ ] **Old server**: SSH access as root, all services running healthily.
- [ ] **New server**: fresh Ubuntu 22.04 or 24.04, public IP, SSH access as root, sudo.
- [ ] **Disk space planning** — on the old server, run:
      ```
      du -sh /home/root/ipfs_data         # kubo blocks (the big one)
      du -sh /var/lib/fula-gateway        # gateway state
      ```
      Bundle size will be roughly `kubo_blocks_size + 200MB` if you include blocks, or `~500MB` if you skip them and rsync separately.
- [ ] **(Optional) External drive** — if pins exceed your main SSD, decide where to mount on the new server (typical: `/mnt/ipfs-data`). Format and mount BEFORE running recover.sh.
- [ ] **DNS plan** — same hostnames (DNS A-record swap, recommended) or new hostnames (requires re-issuing OAuth client redirect URIs and TLS certs).

---

## Section 1 — On the OLD server: produce the bundle

### 1.1 Sanity check

```bash
ssh root@<old-server>
docker ps                                              # confirm 4 containers up
docker exec ipfs_host ipfs id --format='<id>'          # capture peer ID for later cross-check
docker exec ipfs_host ipfs key list -l                 # confirm fula-db-backup + fula-registry exist
df -h /home/root/ipfs_data                             # plan tarball destination based on free space
```

### 1.2 Run migrate-zip.sh

The default destination is `/tmp2`. If `/tmp2` doesn't have enough free space for the bundle (kubo blocks + everything else), point `--out` at a path that does, e.g. an external mount point or `/var/tmp`.

```bash
# Standard run (includes kubo blocks; can take 30-90 min for >100GB datasets):
sudo bash scripts/migrate-zip.sh
```

Or, for very large datasets where you'll rsync the kubo blocks separately:

```bash
# Skip the multi-GB blocks tarball; rsync the kubo data dir over the network later
sudo bash scripts/migrate-zip.sh --no-blocks
```

Output:
```
/tmp2/fula-migration-<UTC-timestamp>.tgz       # the bundle
/tmp2/fula-migration-<UTC-timestamp>.tgz.sha256 # checksum for transfer verification
```

The script briefly pauses ipfs-cluster (~3 seconds) to take a consistent CRDT snapshot. Pinning-service traffic during this window is queued by the daemon and processed on resume — no data loss, but pin requests in that 3s window have +3s latency.

### 1.3 Transfer to the new server

```bash
scp /tmp2/fula-migration-*.tgz \
    /tmp2/fula-migration-*.tgz.sha256 \
    root@<new-server>:/tmp2/
```

**If you used `--no-blocks`**, also rsync the kubo data dir separately (this is incremental and resumable, much friendlier than tar over scp for huge datasets):

```bash
KUBO_SRC=$(docker inspect ipfs_host --format \
    '{{range .Mounts}}{{if eq .Destination "/data/ipfs"}}{{.Source}}{{end}}{{end}}')
rsync -aHP --info=progress2 \
    "${KUBO_SRC}/" \
    root@<new-server>:/home/root/ipfs_data/
```

---

## Section 2 — On the NEW server: prepare the host

### 2.1 (Optional) Mount external drive for IPFS pins

Skip this if pins fit comfortably on your main drive. Recommended if your main drive is ≤500GB and pinned content will exceed half of it.

```bash
ssh root@<new-server>

# Identify the device
lsblk

# Format (one-time only — DESTRUCTIVE if drive has data)
mkfs.ext4 -L ipfs-data /dev/sdb1

# Mount permanently with safe options
mkdir -p /mnt/ipfs-data
echo "LABEL=ipfs-data /mnt/ipfs-data ext4 defaults,noatime,nodiratime,nofail 0 2" \
    >> /etc/fstab
mount -a

df -h /mnt/ipfs-data    # confirm
```

`noatime,nodiratime` is critical — kubo's flatfs creates millions of small block files, and atime updates devastate I/O performance on either SSD or HDD. `nofail` ensures a missing/failed external drive doesn't block boot.

### 2.2 Get the scripts onto the new server

Either clone the repo (recommended — gives you `verify-deploy.sh`, migration files, etc.):

```bash
mkdir -p /opt
cd /opt
git clone https://github.com/functionland/pinning-service.git
```

Or copy just the two scripts if you want to bootstrap before cloning:

```bash
scp <local>/scripts/{migrate-zip.sh,recover.sh} root@<new-server>:/root/
```

### 2.3 Verify the bundle made it intact

```bash
cd /tmp2
sha256sum -c fula-migration-*.tgz.sha256
# expected: fula-migration-<ts>.tgz: OK
```

---

## Section 3 — Run recover.sh

Pick the recipe that matches your scenario. All four use the same script with different flags.

### Recipe A — simplest case: same hostnames, default storage, DNS will cut over during recovery

You want: same DNS A records swapped to new server during the migration window. Some seconds of downtime acceptable.

```bash
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <64-char hex from /root/.fula-backup-key> \
    --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
    --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q \
    --ssl-email     hi@fx.land
```

The script runs through 29 phases and pauses at phase 24 with a `Type 'DNS-DONE' when DNS is propagated:` prompt. At that point:

1. Open another terminal (don't touch the prompt).
2. Update DNS A records at your registrar to point at the new server's public IP.
3. Verify with `dig +short api.cloud.fx.land` until you see the new IP.
4. Type `DNS-DONE` at the prompt.
5. Recovery continues with cert issuance and final health checks.

### Recipe B — external storage for pins

You want: kubo block data on `/mnt/ipfs-data` (mounted in step 2.1).

```bash
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
    --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q \
    --ssl-email     hi@fx.land \
    --kubo-data-host-path /mnt/ipfs-data
```

The kubo docker volume `ipfs_host_data` becomes a bind-mount to `/mnt/ipfs-data`. The bundle's kubo blocks extract directly to the external drive — no double-copy on the small SSD.

### Recipe C — defer DNS cutover, validate new server first (RECOMMENDED if you can afford the workflow)

You want: new server fully running, but DNS still pointing at the old server, so you can validate end-to-end before the cutover.

```bash
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
    --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q \
    --ssl-email     hi@fx.land \
    --defer-dns \
    --kubo-data-host-path /mnt/ipfs-data    # if applicable
```

`--defer-dns` skips the DNS-cutover pause and the certbot issuance phase. The new server comes up using the certs restored from `/etc/letsencrypt` in the bundle, valid until their original expiry.

**Validate via /etc/hosts on a laptop** — see Section 4 below.

When you're satisfied:

```bash
# Update DNS records at your registrar.
# Then on the new server:
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns ... --registry-ipns ... --ssl-email hi@fx.land \
    --phase=certs
    # NOTE: omit --defer-dns this time
```

This re-runs only `phase_certs`, which now finds DNS pointing here and either confirms existing certs (if they're still valid) or issues fresh ones.

### Recipe D — rsync'd blocks (very large datasets)

You ran migrate-zip.sh with `--no-blocks` and rsync'd `/home/root/ipfs_data` separately. Tell recover.sh where the rsynced data is and it'll skip the tarball-extraction step.

```bash
# Note: --blocks-rsync expects a path that already exists on the NEW server,
# not the old server. The rsync into this path should already be complete.
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns ... --registry-ipns ... --ssl-email hi@fx.land \
    --blocks-rsync /home/root/ipfs_data \
    --defer-dns                          # combine with any other flags
```

---

## Section 4 — Validate before DNS cutover (Recipe C only)

On your laptop or any machine with a browser, edit your hosts file to send the production hostnames to the new server's IP:

**Linux/macOS** — `/etc/hosts`:
```
<new-server-public-ip>   api.cloud.fx.land cloud.fx.land ipfs.cloud.fx.land api1.cloud.fx.land
<new-server-public-ip>   pools.fx.land rewards.1.pools.fula.network x402.api.cloud.fx.land
```

**Windows** — `C:\Windows\System32\drivers\etc\hosts` (open Notepad as Administrator).

Then:

1. `dig +short api.cloud.fx.land` from your laptop — should return the new-server IP (proves /etc/hosts override is working).
2. Open `https://cloud.fx.land/` in a browser. **The TLS cert from the old server is presented** because we restored `/etc/letsencrypt/`. The browser sees a valid cert and the app loads against the new server.
3. Log in via Google/Apple. If login succeeds, the migrated `ENCRYPTION_KEY` is correct and the encrypted_email column round-trips.
4. Pin a test CID:
   ```
   curl -X POST https://api.cloud.fx.land/pins \
       -H "Authorization: Bearer <one of your API keys>" \
       -d '{"cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"}'
   ```
   Then on the new server:
   ```
   docker exec ipfs_cluster ipfs-cluster-ctl pin ls | grep bafybei
   ```
   The CID should appear.
5. Hit the WebUI gallery, do an upload, etc. — exercise the surface you care about.
6. **Remove the /etc/hosts entries** when you're done validating.

If anything fails, fix it on the new server, re-run the affected `--phase=NAME`, re-test. The old server is still serving production users this entire time.

When everything checks out, cut DNS over (next section).

---

## Section 5 — Cut over DNS and finalize

### 5.1 Update DNS A records

At your DNS registrar / Cloudflare / Route53, update A records for every hostname in `/etc/nginx/sites-enabled/` on the new server:

```bash
ls /etc/nginx/sites-enabled/        # list of hostnames to update
```

Set them all to the new server's public IP. TTL is whatever it was — typically 5-15 minutes propagation.

Verify propagation from a fresh terminal (one not affected by /etc/hosts overrides you may have set):

```bash
for d in api.cloud.fx.land cloud.fx.land ipfs.cloud.fx.land api1.cloud.fx.land \
         pools.fx.land rewards.1.pools.fula.network x402.api.cloud.fx.land; do
    echo "$d -> $(dig +short $d)"
done
```

### 5.2 Run the certs phase

(Skip this step if you used Recipe A — DNS already cutover during the recover.sh run.)

```bash
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns ... --registry-ipns ... --ssl-email hi@fx.land \
    --phase=certs
```

This now runs without `--defer-dns`. For each domain, it:
1. Checks if a valid cert already exists in `/etc/letsencrypt/live/<domain>/` (yes, from the bundle).
2. If yes: leaves it alone.
3. If no, or the cert is near expiry, AND DNS now points at this server: runs `certbot --nginx -d <domain>` to issue/renew.
4. If DNS still doesn't point here for any domain: warns and skips that one.

The certbot daily-renew cron handles long-term renewal automatically from this point on.

### 5.3 Final verification

```bash
# Re-run the comprehensive health check
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns ... --registry-ipns ... \
    --phase=post_verify
```

Expected output ends with:

```
============================================================
 RECOVERY SUMMARY — ALL GREEN
============================================================
  total time:    ...
  PASS: NN   WARN: 0   FAIL: 0
```

If WARN > 0, the warnings are listed and worth reading — most are non-blocking but should be looked at. If FAIL > 0, do not decommission the old server until the failures are resolved.

### 5.4 Decommission the old server

After the new server has been processing live traffic for at least 24 hours and you've confirmed:
- Pin requests work end-to-end
- Login works
- Backup cron has fired (`tail /var/log/fula-db-backup.log`)
- Registry IPNS publish cron has fired (`tail /var/log/fula-registry-ipns.log`)

Then on the OLD server:

```bash
# Belt-and-suspenders: take one more letsencrypt snapshot before powering off
ssh root@<old-server>
tar -czf /tmp/letsencrypt-final-snapshot.tgz /etc/letsencrypt/

# Stop services
systemctl stop fula-pinning-service fula-pinning-webui fula-upload-server \
               fula-gateway fula-ai-service x402-gateway libp2p-service \
               mainnet-pool-server mainnet-rewards-server

# Stop containers
docker stop fula-gateway-1 ipfs_cluster ipfs_host postgres-pinning

# Optional: power off the host (or reclaim it)
shutdown -h now
```

If your provider charges for the old VM, you can release it now.

---

## Section 6 — Disaster recovery (no old-server access)

If the old server is unreachable, you can still recover *most* state from the IPNS-stored encrypted backup. You'll have:

- ✅ Postgres data up to the latest backup (within 25 hours of last cron run)
- ✅ The `fula-db-backup` IPNS key (auto-imported from the manifest)
- ❌ The `fula-registry` IPNS publishing key — unless you saved an export of it, this is gone, and the registry IPNS name will need to change. The Prolly-Tree data behind it is still recoverable because `/ipns/k51qzi5uqu5dle8...` will resolve to the last published CID.
- ❌ ipfs-cluster identity — you'll generate a new peer ID
- ❌ kubo peer ID — you'll generate a new one (existing swarm peers re-discover this node)
- ❌ kubo blocks — re-fetched lazily from the network as users access content
- ❌ Application secrets that aren't in the backup (NFT_RELAY_PRIVATE_KEY, S3_ADMIN_JWT, MASTER_PASSWORD, ENCRYPTED_PRIVATE_KEY, etc.) — you must have these saved separately or accept regenerating them and re-issuing API keys / sessions.

**This scenario is NOT what `recover.sh` is optimized for.** It's optimized for the bundle workflow. To do disaster recovery from IPNS alone, use the existing `scripts/restore-from-backup.sh` which handles the IPNS-only path. Then manually:
- Bring up the docker containers fresh
- Run `restore-from-backup.sh` to populate Postgres
- Hand-craft `.env` files from your password manager
- Generate new IPNS keys and accept that consumers need to be reconfigured to point at the new ones

---

## Section 7 — Flag reference

### `migrate-zip.sh`

| Flag | Default | Purpose |
|---|---|---|
| `--out PATH` | `/tmp2` | Output directory for the bundle. Must have free space `≥ kubo data size + 200MB`. |
| `--no-blocks` | off | Skip the kubo block data tarball. Required for very large datasets where you'll rsync the data dir separately. |
| `--no-cluster-data` | off | Skip the ipfs-cluster CRDT state tarball. Identity files (identity.json, service.json) and pin list are still saved. Cluster will rebuild its CRDT from scratch on the new server (lazy re-replication via pinning-service traffic). |
| `-h\|--help` | — | Print usage. |

### `recover.sh`

| Flag | Required | Purpose |
|---|---|---|
| `--bundle PATH` | Yes | Path to the bundle tarball produced by migrate-zip.sh. |
| `--backup-key HEX` | Yes | 64-char lowercase hex `BACKUP_ENCRYPTION_KEY`. Used during the IPNS-path verification (`phase_verify_ipns_path`) and persisted to `/root/.fula-backup-key` for the daily backup cron. |
| `--db-ipns NAME` | Yes | The k51-format IPNS name of the database backup. Cross-checked against the imported keystore. |
| `--registry-ipns NAME` | Yes | The k51-format IPNS name of the fula-api registry. Cross-checked against the imported keystore. |
| `--phase NAME` or `--phase=NAME` | No | Run a single phase instead of the full sequence. The phase's checkpoint file is cleared first so it actually re-runs (idempotent) — useful for `--phase=certs` post-DNS-cutover. |
| `--ssl-email EMAIL` | No (default `hi@fx.land`) | Used by certbot for cert registration / expiry notices. |
| `--mainnet-pool-repo URL` | No | Fallback if the bundle's `/opt/mainnet` snapshot is missing. Clones the URL into `/opt/mainnet`. |
| `--prewarm-cluster` | No | After services start, walk `pins` table in Postgres and POST every "pinned" CID to ipfs-cluster's `/pins/<cid>` API. Useful only if cluster CRDT state was NOT preserved (otherwise no-op). |
| `--skip-ipns-verify` | No | Skip `phase_verify_ipns_path` (the diagnostic that exercises the IPNS-only recovery path against a temp DB). Use if your test environment has no DHT connectivity. |
| `--blocks-rsync HOST_PATH` | No | If you rsync'd `/home/root/ipfs_data` to the new server separately (e.g. because you used `--no-blocks` on the bundle), point this at the rsync destination. The kubo volume becomes a bind-mount to that path; no extraction from tarball. |
| `--kubo-data-host-path PATH` | No | Bind the `ipfs_host_data` docker volume to a host path (typically an external drive mount like `/mnt/ipfs-data`). Path must exist and be writable BEFORE running. NFS/CIFS warnings (kubo locks don't work over them). |
| `--cluster-data-host-path PATH` | No | Same as above but for `ipfs_cluster_data`. CRDT state is small (tens of MB), rarely worth externalizing. |
| `--defer-dns` | No | Skip `phase_dns_cutover_pause` and `phase_certs`. Use when DNS still points at the old server and you want to test the new one first via /etc/hosts. After DNS cutover, re-run with `--phase=certs` (without this flag). |
| `-h\|--help` | — | Print usage. |

---

## Section 8 — Phase reference (recover.sh)

The 29 phases run in dependency order. Each writes a checkpoint to `/var/lib/fula-recovery/state/<phase>.done`; subsequent runs skip completed phases. `--phase=NAME` clears the named phase's checkpoint and runs only it.

| # | Phase | What it does | Network? | State written |
|---|---|---|---|---|
| 1 | `preflight` | Validates flags, extracts bundle to `/var/lib/fula-recovery/bundle/`, checks SHA256 if present | No | bundle dir |
| 2 | `apt` | Installs docker, nginx, certbot, jq, postgres-client, openssl, build-essential, Go 1.22, Node 20, npm, pm2, ufw, redis-server, rsync. Retries each apt op 3× with 30s backoff. | Yes | system |
| 3 | `clone` | git clones pinning-service, fula-api, mainnet-reward-server. Each clone retried 3× with 15s backoff. | Yes | `/opt/*` |
| 4 | `apply_system_state` | Restores `/etc/letsencrypt`, `/etc/sysctl.d/*`, `/etc/security/limits.d/*`, `/etc/redis/redis.conf`, `/etc/apple/*`, `/home/root/password.txt` | No | system |
| 5 | `apply_env_files` | Copies all 8 `.env` files from `bundle/env/` to their target paths. Validates pinning-webui.env has all required secrets (ENCRYPTION_KEY, JWT_SECRET, etc.). Persists `/root/.fula-backup-key`. | No | per-service .env |
| 6 | `docker_volumes` | Creates the 3 named volumes (`postgres-pinning-data`, `ipfs_host_data`, `ipfs_cluster_data`). If `--kubo-data-host-path` is provided, the kubo volume becomes a bind-mount. Extracts kubo + cluster data from bundle (or rsync source) BEFORE first daemon start, so identities are preserved. | No | docker volumes |
| 7 | `load_fula_image` | `docker load` of the bundled fula-gateway image. If absent, will rebuild from source in phase 16. | No | docker images |
| 8 | `docker_infra_start` | `docker run` for postgres-pinning, ipfs_host, ipfs_cluster. Cross-checks kubo peer ID against bundle, both IPNS keys in keystore, cluster peer ID against bundle. FAILs if any identity drift. | No | running containers |
| 9 | `pg_restore` | Drops + recreates `pinning_service` database, restores `bundle/postgres/pinning-fresh.dump`. Distinguishes pg_restore warnings (rc=1, continue) from errors (rc≥2, fatal). | No | postgres |
| 10 | `verify_ipns_path` | Diagnostic: resolves DB IPNS, fetches + decrypts manifest, restores into TEMP db `pinning_service_ipns_check`, schema-diffs against production restore. Skipped if `--skip-ipns-verify`. | Yes (DHT) | (temp DB, dropped at end) |
| 11 | `apply_kubo_keys` | Verifies both IPNS keys are in the running kubo's keystore. | No | — |
| 12 | `resolve_registry_cid` | Resolves the registry IPNS name and writes `/var/lib/fula-gateway/registry.cid`. Restores prior gateway state from bundle. Retries 4×20s if IPNS slow to converge. | Yes (DHT) | `/var/lib/fula-gateway/` |
| 13 | `ipfs_repo_verify` | `ipfs repo verify` — checks every locally-stored block hash. Bitswap will lazily refetch any corrupted blocks on demand. | No | — |
| 14 | `build_pinning_core` | `go build` of `main_postgres.go`, `npm ci && npm run build` for ipfs-server and pinning-webui. Each npm op retried 2×30s. | Yes (npm) | `/home/root/pinning-service/{ipfs-pinning, ipfs-server, pinning-webui}` |
| 15 | `build_subservices` | x402-skale and fula-ai-service: build inside cloned repo, deploy to runtime locations. | Yes (npm) | `/home/root/pinning-service/x402-skale`, `/opt/fula-ai-service` |
| 16 | `install_fula_api` | Build/use fula-gateway docker image, write `/etc/fula/.env`, run container, install `/etc/cron.d/fula-registry-ipns`. | Maybe | docker container, cron |
| 17 | `build_mainnet_rewards` | npm install for mainnet-reward-server. | Yes (npm) | `/opt/mainnet-rewards` |
| 18 | `build_mainnet_pool` | Extract `bundle/services/mainnet-pool-server/opt-mainnet.tgz` to `/opt/mainnet`, restore pm2 dump.pm2 + ecosystem.config.js, npm install. | No (or yes, fallback) | `/opt/mainnet` |
| 19 | `build_libp2p_service` | Use bundled binary if its arch matches host (`file <binary>`); else rebuild from source via `go build`. | No | `/opt/mainnet/libp2p-service/libp2p-service` |
| 20 | `apply_systemd_units` | Copies all `.service` files and `.service.d/` overrides from bundle to `/etc/systemd/system/`. `systemctl daemon-reload`. | No | systemd units |
| 21 | `apply_nginx` | Copies nginx configs from bundle. For each: `sed` strips `\$` literals (heredoc artifact). If `/etc/letsencrypt/live/<domain>/fullchain.pem` exists (yes, after phase 4): keep listen-443 block as-is. Otherwise: strip listen-443 server block (certbot recreates after DNS cutover). `nginx -t` then reload. | No | `/etc/nginx/sites-enabled/*` |
| 22 | `apply_cron` | Copies `/etc/cron.d/*` from bundle. Adds `/etc/cron.d/fula-db-backup` belt-and-suspenders. | No | `/etc/cron.d/*` |
| 23 | `apply_ufw` | Allow 22, 80, 443, 4001/tcp+udp, 9096/tcp+udp; deny 5432, 5001, 9094, 9095. | No | UFW state |
| 24 | `dns_cutover_pause` | **Blocking**: lists hostnames, prompts `Type 'DNS-DONE'`. Skipped entirely if `--defer-dns`. | No | — |
| 25 | `certs` | If `--defer-dns`: skipped. Otherwise: per-domain check if `dns_points_here` (vs this server's public IP from api.ipify.org). Skips with warn if DNS doesn't match yet. Issues new certs for domains where DNS is correct and cert is missing/expired. | Yes | `/etc/letsencrypt/*` |
| 26 | `start` | `systemctl enable --now` for every relevant unit, in dependency order. Per-service post-restart `is-active --quiet` check; warns if any service flapped instead of fataling. | No | running services |
| 27 | `post_verify` | 13-section health matrix (see Section 10). PASS/WARN/FAIL aggregated for the final summary. | Yes (mostly local) | — |
| 28 | `prewarm_cluster_pins` | If `--prewarm-cluster`: walk `pins` table, POST each CID to cluster API. No-op otherwise. | No | cluster pin set |
| 29 | `postinstall_checklist` | Prints next-steps text. If `--defer-dns` was used, includes the /etc/hosts test workflow + post-cutover command. | No | — |

---

## Section 9 — What the post_verify health matrix checks

`phase_post_verify` (phase 27) runs 13 sections of checks. Output uses `PASS:`, `WARN:`, `FAIL:` prefixes. The final summary aggregates counts. Exit code 2 if any FAIL; 0 with WARN; 0 if all green.

| Section | Key checks |
|---|---|
| systemd | every unit file present: active + enabled + zero recent error log lines |
| docker | every container running, restart count ≤ 5, healthcheck not unhealthy |
| listeners | public ports (22, 80, 443, 4001, 9096) listening; private ports (5001, 5432, 9094, 6000, 3001, 3300, etc.) bound to **127.0.0.1 only** — FAILs if any leak publicly |
| http | 8 internal HTTP endpoints respond with 2xx/3xx/4xx (any HTTP response counts as up); 5xx fails; connection refused warns |
| ipfs | kubo peer ID matches bundle; both IPNS keys (fula-db-backup, fula-registry) present and match expected k51 names; ≥10 DHT peers; registry IPNS resolves; repo stat OK |
| cluster | cluster peer ID matches bundle; cluster sees IPFS daemon; pin set count ≥ baseline |
| postgres | pg_isready, ≥15 public tables, 6 critical tables present with row counts, 5 migration columns verified, encrypted_email row count |
| redis | redis-cli ping returns PONG (with password fallback) |
| tls | every cert in `/etc/letsencrypt/live/`: not expired, ≥14 days remaining; nginx -t passes; near-expiry without DNS pointing here is flagged |
| cron | cron daemon active; both fula-* cron files present |
| backup readiness | `/root/.fula-backup-key` is 0600; BACKUP_ENCRYPTION_KEY is 64 hex chars; backup-db.sh exists |
| disk | every mount < 80% used (warn) / 90% (fail); kubo data path specifically; swap not heavily used |
| negative exposure | UFW active; tcp/5432, 5001, 9094, 9095 explicitly denied (defense in depth) |

---

## Section 10 — Troubleshooting

### Bundle SHA256 mismatch on the new server
Re-transfer. SCP can corrupt over flaky links. Verify each side independently:
```
sha256sum fula-migration-*.tgz       # on old server
sha256sum fula-migration-*.tgz       # on new server
```

### `apt-get update` fails repeatedly
Network or mirror issue. The script retries 3× with 30s backoff; if all fail, it warns and continues. If install also fails, fatal. Common causes: DNS resolution broken (`/etc/resolv.conf` empty), restrictive outbound firewall, mirror chosen by `/etc/apt/sources.list` is offline. Manually `apt-get install <package>` to see the underlying error.

### `phase_docker_infra_start` fails with "kubo peer ID mismatch"
Likely the kubo data volume wasn't populated correctly in phase 6. Verify:
```
docker volume inspect ipfs_host_data --format '{{.Mountpoint}}'
ls <mountpoint>             # should contain config, blocks/, datastore/, keystore/, etc.
```
If empty or missing files, re-run phase 6: `--phase=docker_volumes`. Confirm the bundle's `kubo/data.tgz` extracted (not zero bytes).

### `phase_resolve_registry_cid` warns "registry IPNS resolve failed"
DHT bootstrap is slow on a fresh node. Wait 5-10 minutes, then re-run: `--phase=resolve_registry_cid`. If it still fails after an hour, check `docker exec ipfs_host ipfs swarm peers | wc -l` — should be ≥ 10. If 0, kubo can't reach the public DHT (firewall on 4001? container running but `--network` wrong?).

### `phase_certs` says "DNS still points elsewhere"
Expected if you used `--defer-dns` or you're running with DNS not yet cutover. Update DNS, wait for propagation, re-run `--phase=certs`. To force certbot anyway (NOT RECOMMENDED, will fail at validation): you'd need to run certbot manually with `--manual` or DNS-01 challenge.

### A service crash-loops in phase 26 (`start`)
The script logs a WARN and continues. After full recovery, investigate:
```
systemctl status <service>
journalctl -u <service> --since "10 minutes ago" --no-pager | tail -50
```
Most common cause: env var missing from `.env` (the bundle didn't have it, or a key changed format). Cross-reference with `bundle/env/<service>.env`.

### `_verify_tls` reports a cert as expired
The bundled cert from the old server has gone past its expiry. Cut DNS over and run `--phase=certs` immediately — certbot will issue a new one. Until then, browsers see a TLS warning.

### `nginx -t` fails after `phase_apply_nginx`
The script keeps `.pre-strip` backups when it strips listen-443 blocks. Check `/etc/nginx/sites-available/*.pre-strip`. To restore one and hand-fix:
```
mv /etc/nginx/sites-available/<site>.pre-strip /etc/nginx/sites-available/<site>
# manually remove the listen-443 block, then:
nginx -t && systemctl reload nginx
```

### `phase_pg_restore` errors out
Errors (rc ≥ 2) from pg_restore are fatal. Re-create from a fresh dump on the old server (run `migrate-zip.sh` again — that's what produces `pinning-fresh.dump`). If the error mentions specific extensions like `pg_trgm` not being installed: install them in the postgres container (`docker exec postgres-pinning psql -U pinning_user -d pinning_service -c 'CREATE EXTENSION pg_trgm'`).

### Phase finished but the script still hung
The script uses blocking `read -rp` only at `dns_cutover_pause` (phase 24). If you're past that and it appears hung, check the latest log lines:
```
tail -f /var/log/fula-recovery.log
```
Long phases: `pg_restore` (proportional to DB size), `npm ci` (slow on flaky registry), `ipfs repo verify` (proportional to repo size).

---

## Section 11 — What the migration preserves vs regenerates

### Preserved exactly (bit-identical to old server)

- All 8 `.env` files including secrets (POSTGRES_PASSWORD, JWT_SECRET, ENCRYPTION_KEY, NFT_RELAY_PRIVATE_KEY, MASTER_PASSWORD, ENCRYPTED_PRIVATE_KEY, etc.)
- Apple Sign-In `.p8` private key file
- All systemd unit files
- All nginx site configs
- All cron files
- `/etc/letsencrypt/` (certs survive intact)
- `/etc/sysctl.d`, `/etc/security/limits.d` (kernel tuning)
- kubo peer ID (libp2p identity)
- Both IPNS publishing keys (`fula-db-backup`, `fula-registry`) — same k51... names continue
- ipfs-cluster peer ID and `cluster_secret`
- ipfs-cluster CRDT state (entire pin set)
- kubo block data (entire pinned content)
- Postgres data via fresh `pg_dump` (zero loss)
- Redis dump.rdb
- pm2 process state for mainnet-pool-server
- libp2p-service binary (or rebuilt from bundled source)
- fula-gateway docker image (loaded from saved tar)

### Regenerated on the new server

- `/var/lib/docker/` paths (volume mountpoints differ, but the volumes' contents are restored)
- `/var/log/fula-*` directories (logs start fresh)
- `/var/lib/fula-recovery/` (script's own state)
- libp2p-service peer ID (intentionally fresh per restart — no consumer cares)

### NOT recoverable (because they were never on the old server's filesystem)

- BACKUP_ENCRYPTION_KEY — supplied via `--backup-key` flag
- DNS A records — manual at registrar

---

## Section 12 — After-recovery operations

### Daily backup cron
Already installed at `/etc/cron.d/fula-db-backup`. Verify:
```
cat /etc/cron.d/fula-db-backup     # 0 3 * * * root . /root/.fula-backup-key && /opt/pinning-service/scripts/backup-db.sh
tail /var/log/fula-db-backup.log   # appears after the next 3 AM run
```

### Registry IPNS publish cron
Already at `/etc/cron.d/fula-registry-ipns` (every 10 min). Verify:
```
tail /var/log/fula-registry-ipns.log
```

### Certbot daily renew cron
Standard certbot package installs `/etc/cron.d/certbot` automatically. To verify:
```
cat /etc/cron.d/certbot
certbot certificates    # should list every domain with "VALID" status
```

### Migrating pins to a NEW external drive later
If you started without `--kubo-data-host-path` and later want to move the kubo data to an external drive, see the section "Migration on the existing production server" in the conversation history that produced this README — short version:

```
# 1. Mount external drive
# 2. Stop kubo
docker stop ipfs_host
SRC=$(docker volume inspect ipfs_host_data --format '{{.Mountpoint}}')
# 3. Rsync to new location
rsync -aHP "$SRC/" /mnt/ipfs-data/
# 4. Recreate the volume as a bind mount
docker rm -f ipfs_host
docker volume rm ipfs_host_data
docker volume create --driver local --opt type=none --opt o=bind --opt device=/mnt/ipfs-data ipfs_host_data
# 5. Start kubo with the same docker run command
```

### Running backups + recovery on a future migration
The recovery scripts on the new server are part of the same repo. To migrate to ANOTHER server later:
```
# On this (now-old) server:
sudo bash /opt/pinning-service/scripts/migrate-zip.sh --out /tmp2

# Transfer /tmp2/fula-migration-*.tgz to next-new-server, repeat the procedure.
```

The migration is fully cyclic.

---

## Section 13 — Files modified / created on the new server

After a successful recovery:

```
/opt/pinning-service/                        cloned repo (Go + Node sources)
/opt/fula-api/                               cloned repo (Rust gateway)
/opt/mainnet-reward-server/                  cloned repo
/opt/fula-ai-service/                        runtime install
/opt/mainnet/                                runtime install + pm2 home (.pm2/)
/opt/mainnet-rewards/                        runtime install
/etc/fula/.env                               fula-api gateway config
/home/root/pinning-service/                  runtime install (Go binary, ipfs-server/dist, pinning-webui/dist)
/home/root/pinning-service/.env              chmod 600
/home/root/pinning-service/ipfs-server/.env  chmod 600
/home/root/pinning-service/pinning-webui/.env chmod 600
/home/root/pinning-service/x402-skale/.env   chmod 600
/etc/apple/AuthKey_*.p8                      chmod 600
/etc/letsencrypt/                            restored from bundle
/etc/nginx/sites-available/<domains>         from bundle, with conditional listen-443 stripping
/etc/nginx/sites-enabled/<domains>           symlinks
/etc/cron.d/fula-db-backup
/etc/cron.d/fula-registry-ipns
/etc/cron.d/<other from bundle>
/etc/systemd/system/<all .service files from bundle>
/var/lib/fula-gateway/registry.cid           freshly resolved during recovery
/var/lib/fula-gateway/db-backup.cid          if present in bundle state.tgz
/var/lib/fula-gateway/backup-history.json    if present in bundle
/root/.fula-backup-key                       chmod 600 — sourced by backup cron
/var/lib/fula-recovery/bundle/               extracted bundle (kept for re-running individual phases)
/var/lib/fula-recovery/state/<phase>.done    checkpoint files
/var/log/fula-recovery.log                   complete recovery log
```

Docker:
```
postgres-pinning, ipfs_host, ipfs_cluster, fula-gateway-1   running containers
postgres-pinning-data, ipfs_host_data, ipfs_cluster_data    volumes (named OR bind-mounted to external storage)
```

---

## Section 14 — Quick command reference cheat sheet

| Action | Command |
|---|---|
| Bundle the old server | `sudo bash scripts/migrate-zip.sh` |
| Bundle without kubo blocks | `sudo bash scripts/migrate-zip.sh --no-blocks` |
| Standard recovery (DNS will cutover during run) | `sudo bash scripts/recover.sh --bundle ... --backup-key ... --db-ipns ... --registry-ipns ...` |
| Recovery with external pins drive | Add `--kubo-data-host-path /mnt/ipfs-data` |
| Recovery with deferred DNS | Add `--defer-dns` |
| Re-run a single phase | `--phase=<name>` (clears that phase's checkpoint) |
| Run only the post-DNS-cutover certs phase | `--phase=certs` (without `--defer-dns`) |
| Run only the comprehensive health check | `--phase=post_verify` |
| Force re-run of pg_restore | `--phase=pg_restore` |
| Test new server before DNS cutover | Add the new server's public IP to your laptop's `/etc/hosts` for every hostname; visit `https://cloud.fx.land/`; tear down /etc/hosts when done |
| List phases that ran | `ls /var/lib/fula-recovery/state/` |
| Tail recovery log | `tail -f /var/log/fula-recovery.log` |
| Verify both IPNS keys | `docker exec ipfs_host ipfs key list -l \| grep fula-` |
| Trigger a manual backup | `. /root/.fula-backup-key && /opt/pinning-service/scripts/backup-db.sh` |
| List all certs and expiry | `certbot certificates` |
