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
- [ ] **New server**: fresh Ubuntu 22.04 or 24.04, public IP, SSH access as root, sudo. **No other prerequisites** — `recover.sh phase_apt` installs everything (Docker, nginx, certbot, Go 1.22, Node 20, pm2, postgres-client, redis, ufw, dnsutils, etc.). See Section 7a for the full list.
- [ ] **Disk space planning** — on the old server, run:
      ```
      du -sh /home/root/ipfs_data         # kubo blocks (the big one)
      du -sh /var/lib/fula-gateway        # gateway state
      ```
      Bundle size will be roughly `kubo_blocks_size + 200MB` if you include blocks, or `~500MB` if you skip them and rsync separately.
- [ ] **(Optional) External drive** — if pins exceed your main SSD, decide where to mount on the new server (typical: `/mnt/ipfs-data`). Format and mount BEFORE running recover.sh.
- [ ] **DNS plan** — same hostnames (DNS A-record swap, recommended) or new hostnames (requires re-issuing OAuth client redirect URIs and TLS certs).
- [ ] **(Optional) Server hardening** — if you plan to run a hardening script (custom `harden.sh`, ansible playbook, etc.) that locks down SSH to specific source networks (LAN-only, WireGuard-only, bastion-only) or writes restrictive sysctl files (e.g., `/etc/sysctl.d/99-hardening.conf`), run it **before** `recover.sh`. Two interactions to be aware of:
    1. **SSH source restriction is preserved.** `phase_apply_ufw` detects pre-existing `ufw` allow rules for port 22 and skips adding the broad `ufw allow 22/tcp` (which would otherwise widen SSH to the public internet). Application ports (80, 443, 4001, 9096) are still opened to anywhere because they're public services by design.
    2. **Sysctl files from the bundle get a `60-fula-bundle-` prefix on copy** so they apply alphabetically *before* any `99-*.conf` hardening file. This keeps the bundle's IPFS tuning (TCP buffers, fd limits) effective while letting hardening's security-sensitive knobs (IPv6 disable, BPF lockdown, anti-spoof, etc.) win the last-write contest.

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

### Recipe B — external storage for pins (kubo and/or cluster on a separate drive)

You want: kubo block data and/or cluster CRDT data on a different drive than the OS root. Both can be on the same external drive or different drives — your choice.

There are **two ways** to bring the pinned data along, depending on whether you want a single transfer or split transfers. Both produce an equally complete recovery; pick based on bandwidth and resume tolerance. **All commands shown below are run on the NEW server** (pulling data from old) so you stay in one shell session and don't need outbound SSH from old → new.

#### Step 1 (common to both options): mount external drive(s) on the new server

```bash
sudo mkdir -p /mnt/ipfs-data /mnt/cluster-data
echo "LABEL=ipfs-data    /mnt/ipfs-data    ext4 defaults,noatime,nodiratime,nofail 0 2" | sudo tee -a /etc/fstab
echo "LABEL=cluster-data /mnt/cluster-data ext4 defaults,noatime,nofail            0 2" | sudo tee -a /etc/fstab
sudo mount -a
df -h /mnt/ipfs-data /mnt/cluster-data    # confirm
```

#### Option 1 — single self-contained bundle (no rsync)

The simplest path: `migrate-zip.sh` reads your kubo `datastore_spec`, follows every storage path it references (including custom paths like Fula Box's `/uniondrive/ipfs_datastore/{blocks,datastore}`), and tars each into a separate file inside the bundle. `recover.sh` extracts them into the right subdirectories of your external drive automatically.

```bash
# ----- on OLD server (one command) -----
sudo bash scripts/migrate-zip.sh                 # NO --no-blocks
# Bundle is now ~150-200 GB depending on dataset size; one file in /tmp2/

# ----- on NEW server: pull the bundle from the old (resumable via --partial) -----
rsync -aHP --partial --info=progress2 \
    root@<old-server>:/tmp2/fula-migration-<ts>.tgz \
    /tmp2/
rsync -aHP --partial \
    root@<old-server>:/tmp2/fula-migration-<ts>.tgz.sha256 \
    /tmp2/

# ----- on NEW server: run recovery -----
cd /tmp2 && sha256sum -c fula-migration-<ts>.tgz.sha256
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
    --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q \
    --ssl-email     hi@fx.land \
    --kubo-data-host-path    /mnt/ipfs-data \
    --cluster-data-host-path /mnt/cluster-data
```

Pros / cons:
- ✅ One transfer, no manual coordination, simplest mental model
- ✅ recover.sh handles every detail (datastore_spec translation, kubo subdir layout, cluster CRDT extraction)
- ⚠️ Single big file. Use `rsync --partial` to pull (shown above) so a dropped connection resumes from where it stopped; native `scp` does not resume.
- ⚠️ Tar+pigz of a multi-GB-to-TB dataset on the OLD server takes 30-60+ min. Kubo and cluster keep running; only some background CPU/IO load.

#### Option 2 — bundle without blocks + separate rsyncs (best for very large datasets)

Build a small bundle with only the metadata (cluster CRDT, identities, env files, postgres dump, etc.), then rsync the bulky kubo data dirs separately. Each transfer is independently resumable.

```bash
# ----- on OLD server: build small bundle -----
sudo bash scripts/migrate-zip.sh --no-blocks    # ~44 GB bundle (no kubo block data)

# Inspect the datastore_spec to know which paths to rsync next.
docker exec ipfs_host cat /internal/ipfs_data/datastore_spec | jq
# Example output for Fula Box:
#   {"mounts":[
#     {"path":"/uniondrive/ipfs_datastore/blocks", "type":"flatfs"},
#     {"path":"/uniondrive/ipfs_datastore/datastore", "type":"pebbleds"}
#   ]}

# ----- on NEW server: pull the bundle -----
rsync -aHP --partial --info=progress2 \
    root@<old-server>:/tmp2/fula-migration-<ts>.tgz \
    /tmp2/
rsync -aHP --partial \
    root@<old-server>:/tmp2/fula-migration-<ts>.tgz.sha256 \
    /tmp2/
cd /tmp2 && sha256sum -c fula-migration-<ts>.tgz.sha256

# ----- on NEW server: pull each kubo data path -----
# Rule: trailing-/-on-source means "copy contents". Destination subdirectory
# name MUST match the LAST component of the source path
# (e.g. .../blocks/ → /mnt/ipfs-data/blocks/).

sudo rsync -aHP --partial --info=progress2 --bwlimit=50M \
    root@<old-server>:/uniondrive/ipfs_datastore/blocks/ \
    /mnt/ipfs-data/blocks/

sudo rsync -aHP --partial --info=progress2 --bwlimit=50M \
    root@<old-server>:/uniondrive/ipfs_datastore/datastore/ \
    /mnt/ipfs-data/datastore/

# ----- on NEW server: cluster data — usually NOT needed -----
# By default the bundle has cluster CRDT (compressed inside it) and recover.sh
# extracts it to /mnt/cluster-data automatically. ONLY do this rsync if you
# additionally pass --no-cluster-data to migrate-zip.sh:
#
# sudo rsync -aHP --partial --info=progress2 --bwlimit=50M \
#     root@<old-server>:/uniondrive/ipfs-cluster/ \
#     /mnt/cluster-data/

# ----- on NEW server: run recovery -----
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
    --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q \
    --ssl-email     hi@fx.land \
    --kubo-data-host-path    /mnt/ipfs-data \
    --cluster-data-host-path /mnt/cluster-data
```

Pros / cons:
- ✅ Each transfer is independently resumable. A dropped connection mid-way means resuming that one rsync from where it stopped, not redoing 200 GB.
- ✅ Smaller "validate-then-commit" bundle: pull the 44 GB bundle first, sanity-check it (`sha256sum -c`), peek at contents, then commit to the long block transfer.
- ⚠️ Two extra rsync commands to remember (the kubo block dirs).
- ⚠️ Requires SSH from new → old (already needed for the bundle transfer anyway).

#### Which option for what situation

| Situation | Recommended |
|---|---|
| Wired LAN transfer, fast both sides, dataset under ~50 GB | Option 1 |
| Home upload speed (asymmetric DSL/cable), dataset > ~50 GB | Option 2 |
| Server-to-server in same datacenter, dataset < 200 GB | Option 1 |
| You want to validate the bundle works before committing to the long transfer | Option 2 |
| You don't want to think about it | Option 2 (rsync `--partial` is bulletproof; smaller test bundle) |

#### How recover.sh recognizes which option you used

It auto-detects from the bundle contents — **same recover.sh invocation works for both options**:

| Bundle contains | recover.sh action |
|---|---|
| `kubo/data-*.tgz` files (Option 1, current format) | Extracts each into matching subdir of `/mnt/ipfs-data` |
| `kubo/data.tgz` (legacy single-tar from older bundles) | Extracts with `--strip-components=1` (legacy compat) |
| Nothing (Option 2 — used `--no-blocks`) | Logs `assuming blocks/datastore were rsynced separately to /mnt/ipfs-data/{blocks,datastore}` and continues. If the rsync didn't happen, kubo starts with empty subdirectories and bitswap will try to backfill from the network. |

In all three cases, recover.sh writes the translated `datastore_spec` (with relative paths) plus restored `config` and `keystore/` into the volume root, so kubo finds everything regardless of how the bulk data arrived.

#### Push-style alternative (run on the OLD server)

If you'd rather initiate from the OLD server (e.g., the new server can't reach the old via SSH yet because firewall rules), invert source/destination:

```bash
# Run on the OLD server. Same data ends up in the same places.
sudo rsync -aHP --partial --info=progress2 --bwlimit=50M \
    /uniondrive/ipfs_datastore/blocks/ \
    root@<new-server>:/mnt/ipfs-data/blocks/

sudo rsync -aHP --partial --info=progress2 --bwlimit=50M \
    /uniondrive/ipfs_datastore/datastore/ \
    root@<new-server>:/mnt/ipfs-data/datastore/
```

Either direction works — the data lands in the same place either way. Pull-style (run on new) is what we recommend by default because it keeps you in one shell session during the recovery.

### Recipe C — defer DNS cutover, validate new server first (RECOMMENDED if you can afford the workflow)

You want: new server fully running, but DNS still pointing at the old server, so you can validate end-to-end before the cutover. The old server keeps serving production traffic the entire time.

> **Important: kubo peer-ID collision.** The new server uses the SAME kubo peer ID as the old server (we restored the identity from the bundle). With both running concurrently, libp2p sees two nodes claiming the same identity → DHT routing gets poisoned, bitswap fetches across the colliding identity become unreliable, and IPNS publishing from both nodes will produce conflicting records. The script auto-detects this and engages **parallel-run mode** to skip operations that depend on a clean network state. After you cut over and stop the old server's kubo+cluster, run `--finalize-cutover` to activate the deferred operations.

#### C.1 — initial recovery (old server still running)

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

What you'll see in `phase_docker_infra_start`:
```
[…]   checking DHT for peer-ID collision (parallel-run safety)...
[…]   WARN: another node is currently announcing the same kubo peer ID on the DHT:
        /dns4/1.pools.functionyard.fula.network/tcp/4001/p2p/12D3KooW...
[…]   Auto-enabling parallel-run mode. Phase 10 (IPNS verify) will be skipped, and
[…]   IPNS publish + DB backup crons will be staged in /var/lib/fula-recovery/deferred-cron/
[…]   rather than installed to /etc/cron.d/...
```

This is normal and expected. Recovery continues — postgres restore, container starts, fula-api builds, nginx, etc. all run; only the network-dependent steps (IPNS verify, IPNS publishing crons) are deferred.

If you want to be explicit instead of relying on auto-detection, add `--parallel-run` to the flags above.

`--defer-dns` skips the DNS-cutover pause and the certbot issuance phase. The new server comes up using the certs restored from `/etc/letsencrypt` in the bundle, valid until their original expiry.

#### C.2 — validate via /etc/hosts on a laptop

See Section 4 below.

#### C.3 — cut over and finalize

After validation, cut over DNS, then stop the old server's kubo+cluster (the rest of its services can stay up briefly for a clean handoff, but its kubo+cluster MUST be off so the peer-ID is truly only ours):

```bash
# On OLD server:
sudo docker stop ipfs_host ipfs_cluster
```

Then on the NEW server, re-run with `--phase=certs` to issue / confirm certs now that DNS points here:

```bash
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns ... --registry-ipns ... --ssl-email hi@fx.land \
    --phase=certs
    # NOTE: omit --defer-dns this time
```

Then activate the deferred network-dependent operations:

```bash
sudo bash /opt/pinning-service/scripts/recover.sh \
    --finalize-cutover \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns ... --registry-ipns ... --ssl-email hi@fx.land
```

`--finalize-cutover` will:
1. Re-check the DHT for the peer-ID collision. Refuses to proceed if the old node is still announcing (override with `FORCE_FINALIZE=true bash …` if you've confirmed the old kubo is genuinely off and DHT records are just lagging).
2. Move staged crons from `/var/lib/fula-recovery/deferred-cron/` → `/etc/cron.d/`. Cron picks up the files automatically; the registry IPNS publish runs on the next 10-minute boundary, the DB backup runs at 03:00 UTC.
3. Run `phase_verify_ipns_path` for real (now that bitswap can reliably fetch the manifest CID).
4. Re-run `phase_post_verify` for a fresh end-state report.

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

### Recipe E — Step-by-step for split SSD + HDD layout (Fula Box → standard server)

This recipe is a complete copy-paste walkthrough for one specific hardware + software combination:

- **OLD server**: Fula Box with the `/uniondrive` storage layout, custom kubo `datastore_spec` pointing at `/uniondrive/ipfs_datastore/{blocks,datastore}`, ipfs-cluster CRDT at `/uniondrive/ipfs-cluster`.
- **NEW server**: fresh Ubuntu 22.04 / 24.04 with two drives:
  - **SSD** (boot drive, e.g. 500 GB Samsung with DRAM) → holds OS, Docker, postgres, **ipfs-cluster pebble**
  - **HDD** (e.g. 4 TB) → holds **kubo blocks + pebbleds** (the bulky content data)

Every command below is annotated with which server to run it on. Substitute `<hex>` with your `BACKUP_ENCRYPTION_KEY`, `<old-server>` with your old server's hostname or IP, and adjust the bundle filename to your actual one.

#### Step 1 — On OLD server: produce the bundle (skip if already done)

```bash
ssh root@<old-server>
cd ~/pinning-service
git pull
sudo bash scripts/migrate-zip.sh --no-blocks
# Note the output filename, e.g. /tmp2/fula-migration-20260430-031742Z.tgz
```

The bundle is ~44 GB (cluster CRDT + identities + env + secrets + postgres dump + fula-gateway image). Kubo blocks are excluded — you'll rsync those in step 6.

#### Step 2 — On NEW server: identify, format, and mount the HDD

```bash
ssh root@<new-server>

# Identify the HDD device (look for ~4 TB unmounted block device)
lsblk -o NAME,SIZE,TYPE,MOUNTPOINT
# Example output:
#   NAME    SIZE TYPE MOUNTPOINT
#   sda     465G disk
#   |-sda1  ...      /
#   sdb     3.6T disk           ← this is your HDD
#   |-sdb1  3.6T part

# Format with ext4 + label (DESTRUCTIVE — confirms the HDD is empty)
sudo mkfs.ext4 -L ipfs-data /dev/sdb1

# Mount + persist via fstab
sudo mkdir -p /mnt/ipfs-data
echo "LABEL=ipfs-data /mnt/ipfs-data ext4 defaults,noatime,nodiratime,nofail 0 2" | sudo tee -a /etc/fstab
sudo mount -a

# Verify
df -h /mnt/ipfs-data
mount | grep ipfs-data
# Expect: /dev/sdb1 on /mnt/ipfs-data type ext4 (rw,noatime,nodiratime)
```

#### Step 3 — On NEW server: install the recovery script

```bash
# Get the pinning-service repo so you have recover.sh
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/functionland/pinning-service.git /opt/pinning-service
ls /opt/pinning-service/scripts/recover.sh
```

#### Step 4 — On NEW server: set up SSH key access to the old server

```bash
# Generate an ssh key on the new server (one-time)
[ -f /root/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519

# Copy the public key onto the OLD server's root authorized_keys.
# (Run this once, you'll be prompted for the OLD server's root password.)
ssh-copy-id -i /root/.ssh/id_ed25519.pub root@<old-server>

# Test
ssh root@<old-server> echo OK
# Expect: OK
```

This allows the upcoming rsyncs to run unattended without prompting for passwords. If you already have SSH keys set up, skip this step.

#### Step 5 — On NEW server: pull the bundle (~44 GB, resumable)

```bash
sudo mkdir -p /tmp2
sudo rsync -aHP --partial --info=progress2 \
    root@<old-server>:/tmp2/fula-migration-<ts>.tgz \
    /tmp2/
sudo rsync -aHP --partial \
    root@<old-server>:/tmp2/fula-migration-<ts>.tgz.sha256 \
    /tmp2/

# Verify integrity
cd /tmp2 && sha256sum -c fula-migration-<ts>.tgz.sha256
# Expect: fula-migration-<ts>.tgz: OK
```

If `rsync` is interrupted, just re-run the same command — `--partial` resumes from where it stopped.

#### Step 6 — On NEW server: pull kubo data to the HDD (~162 GB)

This is the big one. With `--bwlimit=50M` it takes ~55 min; without, much less depending on home upload speed. Each path is independently resumable.

```bash
# Blocks (the actual content — ~159 GB)
sudo rsync -aHP --partial --info=progress2 --bwlimit=50M \
    root@<old-server>:/uniondrive/ipfs_datastore/blocks/ \
    /mnt/ipfs-data/blocks/

# Pebbleds (kubo's local metadata — pin set, IPNS records — ~2.5 GB)
sudo rsync -aHP --partial --info=progress2 --bwlimit=50M \
    root@<old-server>:/uniondrive/ipfs_datastore/datastore/ \
    /mnt/ipfs-data/datastore/

# Verify both subdirectories are populated
sudo du -sh /mnt/ipfs-data/blocks /mnt/ipfs-data/datastore
# Expect sizes roughly matching what was on the old server (~159 GB and ~2.5 GB)
```

**No need to rsync `/uniondrive/ipfs-cluster/`** — it's already inside the bundle as `cluster/data.tgz` and recover.sh extracts it to the SSD-resident docker volume automatically.

#### Step 7 — On NEW server: run recover.sh

```bash
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
    --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q \
    --ssl-email     hi@fx.land \
    --kubo-data-host-path /mnt/ipfs-data \
    --defer-dns
```

What this does:
- **System packages**: docker, nginx, certbot, postgres-client, Go 1.22, Node 20, pm2, pigz, redis, etc. (auto-installed)
- **Volumes**: `ipfs_host_data` bind-mounts to `/mnt/ipfs-data` (HDD); `ipfs_cluster_data` uses Docker's default `/var/lib/docker/volumes/...` location on the SSD
- **Restores all identities**: kubo peer ID, both IPNS keys, ipfs-cluster identity + service.json
- **Database**: drops + restores from bundled `pinning-fresh.dump`; runs any new migrations idempotently
- **Builds**: pinning-service Go binary (main_postgres.go), ipfs-server, pinning-webui, x402-skale, fula-ai-service, mainnet-rewards-server, mainnet-pool-server (from `/opt/mainnet` snapshot in bundle), libp2p-service
- **Kubo data**: extracts `kubo/data-*.tgz` from bundle into `/mnt/ipfs-data/{blocks,datastore}/` if you used Option 1 (no `--no-blocks`); detects your already-rsynced data if you used Option 2
- **`datastore_spec` + `config` translation**: rewrites absolute paths (`/uniondrive/ipfs_datastore/blocks` → `blocks`) in BOTH the datastore_spec file AND the config's `Datastore.Spec` subtree so kubo finds data at `/data/ipfs/blocks` inside the container = `/mnt/ipfs-data/blocks` on host. Also rewrites `Addresses.API` from `127.0.0.1` to `0.0.0.0` inside the container so ipfs-cluster (running on host network) can reach kubo's API through the Docker port mapping.
- **Ownership normalization**: forces all kubo + cluster volume contents to UID 1000 (the in-container `ipfs` user) regardless of which restore path populated them.
- **Parallel-run mode auto-detection**: kubo asks the DHT for its own peer ID after starting; if any non-local addresses come back, it concludes the OLD server is still announcing the same identity, sets `PARALLEL_RUN_MODE=true`, skips `phase_verify_ipns_path`, and stages IPNS-publish + DB-backup crons in `/var/lib/fula-recovery/deferred-cron/` instead of installing them to `/etc/cron.d/`. After cutover you'll run `--finalize-cutover` to activate them — see step 11 below. Add `--parallel-run` to the flags above to force this mode without waiting for detection.
- **`--defer-dns`**: skips the DNS-cutover pause and certbot phase. The new server comes up using the certs restored from `/etc/letsencrypt` in the bundle (still valid for weeks). You'll switch DNS in step 9.

Watch the output for any FAIL lines. WARNs are usually fine; investigate FAILs. The parallel-run auto-detection log line is normal:
```
[…]   WARN: another node is currently announcing the same kubo peer ID on the DHT:
        /dns4/1.pools.functionyard.fula.network/tcp/4001/p2p/12D3KooW...
[…]   Auto-enabling parallel-run mode...
```

#### Step 8 — On NEW server: validate before DNS cutover

The new server is fully operational now but DNS still points at the old server. To validate the new one without affecting users, edit your laptop's hosts file:

**On your laptop** (Linux/macOS — `/etc/hosts`; Windows — `C:\Windows\System32\drivers\etc\hosts`):
```
<new-server-public-ip>  api.cloud.fx.land cloud.fx.land ipfs.cloud.fx.land api1.cloud.fx.land
<new-server-public-ip>  pools.fx.land rewards.1.pools.fula.network x402.api.cloud.fx.land
```

Then on your laptop:
```bash
# Confirm /etc/hosts override is working (should return new server IP)
dig +short api.cloud.fx.land

# Browse the WebUI — TLS cert from old server still serves correctly
open https://cloud.fx.land/

# Login with your existing Google account → if it works, ENCRYPTION_KEY decrypts encrypted_email correctly
# Pin a test CID via the API:
curl -X POST https://api.cloud.fx.land/pins \
    -H "Authorization: Bearer <your test API key>" \
    -d '{"cid":"bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"}'
```

**On the new server**, confirm the test pin propagated to ipfs-cluster:
```bash
docker exec ipfs_cluster ipfs-cluster-ctl pin ls | grep bafybei
```

When you're satisfied everything works, **remove the `/etc/hosts` entries from your laptop**.

#### Step 9 — Cut DNS over

At your DNS registrar (Cloudflare, Route53, etc.), update the A records for these hostnames to point at the new server's public IP:

```
api.cloud.fx.land
api1.cloud.fx.land
cloud.fx.land
ipfs.cloud.fx.land
x402.api.cloud.fx.land
pools.fx.land
rewards.1.pools.fula.network
cluster.1.pools.functionyard.fula.network
hub.dev.fx.land   (if applicable)
```

Verify propagation from a fresh terminal (one without /etc/hosts overrides):
```bash
for d in api.cloud.fx.land cloud.fx.land ipfs.cloud.fx.land api1.cloud.fx.land \
         pools.fx.land rewards.1.pools.fula.network x402.api.cloud.fx.land; do
    echo "$d → $(dig +short $d | tr '\n' ' ')"
done
```

#### Step 10 — On NEW server: finalize certs after DNS cutover

```bash
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
    --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q \
    --ssl-email     hi@fx.land \
    --kubo-data-host-path /mnt/ipfs-data \
    --phase=certs
    # NOTE: omit --defer-dns this time
```

This re-runs only `phase_certs`. For each domain whose DNS now points at the new server, certbot either confirms the existing cert (still valid from the bundle) or issues a new one. Domains where DNS hasn't propagated yet warn-skip — re-run after they propagate.

After this, certbot's daily renew cron handles long-term renewal automatically.

#### Step 10.5 — On OLD server: stop kubo+cluster, then on NEW server: finalize cutover

The new server has been running with parallel-run mode (auto-detected in step 7). Two things are deferred until the OLD server's kubo peer ID stops announcing on the DHT:
- IPNS publishing crons (registry republish + nightly DB backup) — staged in `/var/lib/fula-recovery/deferred-cron/`
- `phase_verify_ipns_path` (the IPNS-only DR validation) — skipped

Now that DNS is cut over, retire the OLD server's kubo identity:

```bash
# On OLD server:
sudo docker stop ipfs_host ipfs_cluster
# Other services (fula-api, nginx, etc.) on the OLD server can stay up briefly for a
# clean handoff, but kubo+cluster MUST be off so the peer ID is exclusively ours.

# On NEW server:
sudo bash /opt/pinning-service/scripts/recover.sh \
    --finalize-cutover \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
    --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q \
    --ssl-email     hi@fx.land
```

This will:
1. Re-check the DHT for the peer-ID collision. **If still active**, refuses to proceed (DHT records may still be propagating from the old node — wait 5-10 min and retry, or override with `FORCE_FINALIZE=true bash …` if you've confirmed the old kubo is truly off).
2. Move staged crons from `/var/lib/fula-recovery/deferred-cron/` → `/etc/cron.d/`. Cron picks them up automatically.
3. Run `phase_verify_ipns_path` for real (with a 5-minute fetch timeout, configurable via `IPNS_FETCH_TIMEOUT`). This validates the disaster-recovery path: fetches the encrypted manifest CID from IPNS, decrypts it, fetches the dump CID, decrypts and restores into a temporary database, schema-diffs vs. the fresh dump from phase 9, and reports row-count deltas.
4. Re-run `phase_post_verify` for a fresh end-state report.

#### Step 11 — On NEW server: full health verification

```bash
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns ... --registry-ipns ... \
    --kubo-data-host-path /mnt/ipfs-data \
    --phase=post_verify
```

Expected output ends with:
```
============================================================
 RECOVERY SUMMARY — ALL GREEN
============================================================
  PASS: NN   WARN: 0   FAIL: 0
```

If FAIL > 0, do not decommission the old server until resolved.

#### Step 12 — On NEW server: optional — apply LAN isolation if server is on home network

If your new server is on your home network (not a colocated VPS), apply network-level hardening so a compromised server can't pivot to home devices:

```bash
sudo bash /opt/pinning-service/scripts/recover.sh \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns ... --registry-ipns ... \
    --kubo-data-host-path /mnt/ipfs-data \
    --phase=apply_ufw
```

This re-runs the firewall phase, which auto-detects the home LAN and adds outbound deny rules. Skip if you're on a cloud VPS (the script auto-detects and skips on its own).

#### Step 13 — Decommission the old server (after 24+ hours of new server serving live traffic)

On the OLD server:
```bash
ssh root@<old-server>

# Final belt-and-suspenders snapshot of /etc/letsencrypt before powering off
sudo tar -czf /tmp/letsencrypt-final.tgz /etc/letsencrypt/

# Stop services
sudo systemctl stop fula-pinning-service fula-pinning-webui fula-upload-server \
                     fula-gateway fula-ai-service x402-gateway libp2p-service \
                     mainnet-pool-server mainnet-rewards-server

# Stop containers
sudo docker stop fula-gateway-1 ipfs_cluster ipfs_host postgres-pinning

# (Optional) Power off / reclaim VM
sudo shutdown -h now
```

#### Verification of the final disk layout (on NEW server)

```bash
df -h /
df -h /mnt/ipfs-data

du -sh /var/lib/docker/volumes/postgres-pinning-data/_data         # postgres on SSD
du -sh /var/lib/docker/volumes/ipfs_cluster_data/_data             # cluster pebble on SSD (~44 GB after extract)
du -sh /mnt/ipfs-data/blocks /mnt/ipfs-data/datastore              # kubo on HDD (~162 GB)
```

Expected:
- SSD usage: ~150-180 GB (OS + docker + postgres + cluster pebble)
- HDD usage: ~165 GB (kubo content) + lots of headroom for growth

That's the complete recipe. Each step has a single, atomic command (or a small group of related commands) — work through them in order.

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

### 5.2.5 Stop the OLD server's kubo+cluster, then finalize the cutover (Recipe C only)

If you used Recipe C (parallel-run validation), the new server has been running with deferred IPNS publishing crons and a skipped IPNS-verify phase to avoid fighting the old server over the shared kubo peer ID. Now is the time to retire the old kubo and activate those.

```bash
# On OLD server:
sudo docker stop ipfs_host ipfs_cluster
# (other services on the old server can stay up if you want a brief overlap, but kubo+cluster MUST stop)

# On NEW server:
sudo bash /opt/pinning-service/scripts/recover.sh \
    --finalize-cutover \
    --bundle /tmp2/fula-migration-<ts>.tgz \
    --backup-key <hex> \
    --db-ipns ... --registry-ipns ... --ssl-email hi@fx.land
```

This re-checks the DHT for the peer-ID collision (will refuse to proceed if still active — override with `FORCE_FINALIZE=true bash …` only if you've confirmed the old kubo is genuinely off and DHT records are still propagating), moves the staged crons into `/etc/cron.d/`, runs `phase_verify_ipns_path` for real, and produces a final post-verify report.

After successful `--finalize-cutover`:
- `tail /var/log/fula-registry-ipns.log` — should grow on every 10-minute boundary
- `tail /var/log/fula-db-backup.log` — should grow at next 03:00 UTC

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

## Section 7a — What `phase_apt` installs

The recovery script bootstraps a fresh Ubuntu host into a fully-equipped target with no manual prerequisites. Phase 2 (`apt`) runs as root and installs:

**Via apt** (with 3× retry + 30s backoff per op):

| Package(s) | Purpose |
|---|---|
| `docker.io`, `docker-compose-plugin` | Container runtime for postgres-pinning, ipfs_host, ipfs_cluster, fula-gateway-1. Daemon explicitly enabled + started. |
| `nginx` | Reverse proxy / TLS terminator for all domain endpoints |
| `certbot`, `python3-certbot-nginx` | Let's Encrypt cert issuance via the nginx plugin (HTTP-01 challenge) |
| `postgresql-client` | host-side `psql`, `pg_dump`, `pg_restore` (postgres SERVER runs in Docker) |
| `redis-server`, `redis-tools` | Used by mainnet-pool-server and mainnet-rewards-server for rate limiting + caching |
| `dnsutils` | provides `dig` for the per-domain DNS-points-here check in `phase_certs` and `_verify_tls` |
| `iproute2` | provides `ss` for the network listener verification |
| `python3` | used by the heredoc parser in `phase_apply_nginx` to strip listen-443 server blocks |
| `file` | used by `phase_build_libp2p_service` to detect binary architecture compatibility |
| `cron` | daemon for scheduled backup + IPNS publish jobs (also enabled at the end of the apt phase) |
| `ufw`, `fail2ban` | firewall + brute-force protection |
| `jq`, `openssl`, `git`, `build-essential`, `curl`, `ca-certificates`, `rsync` | general utilities used throughout |

**Out-of-band downloads** (with 3× retry):

| Tool | Source | Why not apt |
|---|---|---|
| Go 1.22.7 | `https://go.dev/dl/go1.22.7.linux-amd64.tar.gz` extracted to `/usr/local/go` | Ubuntu 22.04 only ships Go 1.18; main_postgres.go needs ≥1.20 |
| Node 20 | NodeSource setup script `https://deb.nodesource.com/setup_20.x` then `apt-get install nodejs` | Ubuntu's default Node varies; Node 20 LTS is consistent across distros |
| pm2 | `npm install -g pm2` | not in apt repos |

**What is NOT installed** (by design):

- **postgres SERVER** — runs inside the `postgres-pinning` Docker container (image `postgres:15`)
- **kubo / IPFS** — runs inside the `ipfs_host` Docker container (image `ipfs/kubo:release`)
- **ipfs-cluster** — runs inside the `ipfs_cluster` Docker container (image `ipfs/ipfs-cluster:stable`)
- **fula-gateway** — Rust binary runs inside the `fula-gateway-1` Docker container (image loaded from bundle or rebuilt from source)

This keeps the host minimal: only daemons that systemd manages directly (nginx, redis, application services) are installed via apt; data substrates live in containerized form for clean upgrade paths.

**Verification**: at the end of phase 2, the script verifies each tool is on PATH and the docker daemon responds to `docker info`. If any check fails, the phase exits fatal with a clear message. The check is performed even on re-runs so an interrupted apt install doesn't get silently skipped on the next attempt.

---

## Section 7 — Flag reference

### `migrate-zip.sh`

| Flag | Default | Purpose |
|---|---|---|
| `--out PATH` | `/tmp2` | Output directory for the bundle. Must have free space `≥ kubo data size + 200MB`. |
| `--no-blocks` | off | Skip the kubo block data tarball. Required for very large datasets where you'll rsync the data dir separately. |
| `--no-cluster-data` | off | Skip the ipfs-cluster CRDT state tarball. Identity files (identity.json, service.json) and pin list are still saved. Cluster will rebuild its CRDT from scratch on the new server (lazy re-replication via pinning-service traffic). |
| `-h\|--help` | — | Print usage. |

**Resource pressure during bundle creation**: the kubo block data tar+compress is the heaviest step — it streams every block file through gzip while the production stack is still serving traffic. The script applies four mitigations automatically so it doesn't hang the host:

1. **`pigz` if available** — multi-threaded gzip; same format as `gzip` but uses all CPU cores. The script auto-installs `pigz` via apt on the first run if missing. ~N× faster on N-core hosts.
2. **`nice -n 19` + `ionice -c 3`** wrapping every heavy tar/save invocation — gives production CPU + I/O priority over the migration.
3. **Compression level 1** instead of the default 6 — for kubo blocks (mostly already-compressed media) the size penalty is <1% but speed gain is 3-5×.
4. **No double-compression on the outer bundle** — inner tarballs are already gzipped, so the outer `tar -cz` ran level-6 gzip over already-gzipped bytes. The new code uses level 1 there for what is effectively a tar concatenation pass.

Visibility around the kubo blocks step shows expected duration, monitoring commands (`du`, `iotop`, `pidstat`), and confirms `Ctrl-C` is safe (the EXIT trap unpauses the cluster cleanly):

```
==[ KUBO BLOCKS — heaviest step ]======================================
  source:      /home/root/ipfs_data
  size:        87G  (1432901 files)
  compressor:  pigz -1 -p8  (multi-threaded, fast)
  priority:    nice=19 + ionice=idle  (production keeps its CPU + I/O share)
  expected:    roughly 470 sec at 200 MB/s (pigz)
               roughly 1872 sec at 50  MB/s (gzip)
  monitor:     in another terminal, watch progress with one of:
                 du -h /tmp2/fula-migration-.../kubo/data.tgz
                 iotop -ao
                 pidstat 5
  abort:       Ctrl-C is safe — the EXIT trap unpauses cluster + cleans up
=======================================================================
```

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
| `--parallel-run` | No | Use when the OLD server is still running (Recipe C-style validation). The script normally auto-detects this in `phase_docker_infra_start` by checking the DHT for the bundled kubo peer ID; pass this flag to force the mode without waiting for detection. In parallel-run mode: (1) `phase_verify_ipns_path` is skipped (bitswap fetches across the colliding peer ID are unreliable), (2) the registry-IPNS and DB-backup crons are **staged** in `/var/lib/fula-recovery/deferred-cron/` instead of installed to `/etc/cron.d/`, so the new server doesn't fight the old server for IPNS publishing rights. All other phases run normally so you can validate the full deployment. After cutover, run `--finalize-cutover` to activate the staged items. |
| `--finalize-cutover` | No | Run AFTER you've stopped kubo+cluster on the old server. Re-checks the DHT for collision (refuses to proceed if still active — override with `FORCE_FINALIZE=true`), moves staged crons from `/var/lib/fula-recovery/deferred-cron/` to `/etc/cron.d/`, and runs `phase_verify_ipns_path` for real. Use this with the same `--bundle`, `--backup-key`, `--db-ipns`, `--registry-ipns`, `--ssl-email` flags as the original recovery (no `--defer-dns` needed at this point). |
| `--blocks-rsync HOST_PATH` | No | If you rsync'd `/home/root/ipfs_data` to the new server separately (e.g. because you used `--no-blocks` on the bundle), point this at the rsync destination. The kubo volume becomes a bind-mount to that path; no extraction from tarball. |
| `--kubo-data-host-path PATH` | No | Bind the `ipfs_host_data` docker volume to a host path (typically an external drive mount like `/mnt/ipfs-data`). Path must exist and be writable BEFORE running. NFS/CIFS warnings (kubo locks don't work over them). |
| `--cluster-data-host-path PATH` | No | Same as above but for `ipfs_cluster_data`. CRDT state is small (tens of MB), rarely worth externalizing. |
| `--defer-dns` | No | Skip `phase_dns_cutover_pause` and `phase_certs`. Use when DNS still points at the old server and you want to test the new one first via /etc/hosts. After DNS cutover, re-run with `--phase=certs` (without this flag). |
| `--force-wipe` | No | Required for `--phase=pg_restore` re-runs against a database that already has data. Without this, the phase refuses to DROP+restore so accidental re-runs don't wipe data accumulated since the bundle was made. Use only when you accept losing data added since the bundle was created. |
| `--no-lan-isolation` | No | Skip the outbound LAN-isolation rules in `phase_apply_ufw`. By default the script auto-detects when the server is on a private home LAN and adds outbound deny rules so a compromised server cannot pivot to other home devices (laptops, NAS, IoT, router admin UI). Internet egress and inbound public services are unaffected. Use this flag only if the server legitimately needs to reach other LAN devices outbound (e.g., a NAS for backups, a LAN-only IPFS peer). The check is auto-skipped on cloud servers where the gateway is a public IP. |
| `-h\|--help` | — | Print usage. |

---

## Section 8 — Phase reference (recover.sh)

The 29 phases run in dependency order. Each writes a checkpoint to `/var/lib/fula-recovery/state/<phase>.done`; subsequent runs skip completed phases. `--phase=NAME` clears the named phase's checkpoint and runs only it.

| # | Phase | What it does | Network? | State written |
|---|---|---|---|---|
| 1 | `preflight` | Validates flags, extracts bundle to `/var/lib/fula-recovery/bundle/`, checks SHA256 if present | No | bundle dir |
| 2 | `apt` | Installs docker.io, nginx, certbot, jq, postgres-client, openssl, build-essential, Go 1.22, Node 20, npm, pm2, ufw, fail2ban, redis-server + redis-tools, rsync, dnsutils (dig), python3, file, cron, iproute2 (ss). Enables docker.service + cron. Retries each apt op 3× with 30s backoff. Verifies each tool is on PATH after install. | Yes | system |
| 3 | `clone` | git clones pinning-service, fula-api, mainnet-reward-server. Each clone retried 3× with 15s backoff. | Yes | `/opt/*` |
| 4 | `apply_system_state` | Restores `/etc/letsencrypt`, `/etc/sysctl.d/*`, `/etc/security/limits.d/*`, `/etc/redis/redis.conf`, `/etc/apple/*`, `/home/root/password.txt` | No | system |
| 5 | `apply_env_files` | Copies all 8 `.env` files from `bundle/env/` to their target paths. Validates pinning-webui.env has all required secrets (ENCRYPTION_KEY, JWT_SECRET, etc.). Persists `/root/.fula-backup-key`. | No | per-service .env |
| 6 | `docker_volumes` | Creates the 3 named volumes (`postgres-pinning-data`, `ipfs_host_data`, `ipfs_cluster_data`). If `--kubo-data-host-path` is provided, the kubo volume becomes a bind-mount. Extracts kubo + cluster data from bundle (or rsync source) BEFORE first daemon start, so identities are preserved. | No | docker volumes |
| 7 | `load_fula_image` | `docker load` of the bundled fula-gateway image. If absent, will rebuild from source in phase 16. | No | docker images |
| 8 | `docker_infra_start` | `docker run` for postgres-pinning, ipfs_host, ipfs_cluster. Cross-checks kubo peer ID against bundle, both IPNS keys in keystore, cluster peer ID against bundle. FAILs if any identity drift. | No | running containers |
| 9 | `pg_restore` | Live-data guard: refuses to DROP if pinning_service DB already has rows unless `--force-wipe` is set. Drops + recreates database, restores `bundle/postgres/pinning-fresh.dump`. Distinguishes pg_restore warnings (rc=1, continue) from errors (rc≥2, fatal). After restore, applies every file in `migrations/postgres/*.sql` idempotently to catch any new migrations added since the bundle was created. | No | postgres |
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
| 23 | `apply_ufw` | **Inbound**: allow 22, 80, 443, 4001/tcp+udp, 9096/tcp+udp; deny 5432, 5001, 9094, 9095 (defense-in-depth on top of 127.0.0.1 binding). **Outbound LAN isolation**: auto-detects gateway + LAN CIDR + LAN DNS via `ip route` and `/etc/resolv.conf`. If gateway is a private (RFC1918) IP — i.e., this is a home/office LAN — adds `allow out to <gateway>`, `allow out to <each LAN DNS>`, then `deny out to <LAN CIDR>`. Result: server can reach the internet via the gateway and resolve DNS, but cannot initiate outbound connections to other home devices (lateral-pivot block). Skipped automatically on public-IP / cloud-VPS setups where there's no LAN to isolate. Skipped explicitly via `--no-lan-isolation`. Inbound replies on existing connections are unaffected (UFW conntrack handles ESTABLISHED,RELATED). | No | UFW state |
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
| negative exposure | UFW active; tcp/5432, 5001, 9094, 9095 explicitly denied (defense in depth); when on a private LAN: outbound LAN-isolation rule active (server can't pivot to other home devices) |

---

## Section 9a — LAN isolation (when running on a home network)

If the server is on a home / office LAN (default gateway is a private RFC1918 IP), `phase_apply_ufw` auto-detects this and adds three categories of OUTBOUND rules so a compromised server cannot pivot to other devices on the same network — laptops, NAS, IoT devices, IP cameras, printers, the router admin UI, etc.

**What gets added** (auto-detected at recovery time, not hard-coded):

| Rule | Purpose | Why this exact rule |
|---|---|---|
| `ALLOW OUT TO <gateway>` | Permit traffic to the home router | Internet egress goes through the router; without this, the server has no outbound at all |
| `ALLOW OUT TO <LAN DNS server>` (per detected DNS) | Permit DNS to a Pi-hole / router-resident resolver | If you use a LAN-side DNS resolver, blocking it would break name resolution. Public DNS (1.1.1.1, 8.8.8.8) doesn't need an explicit allow. |
| `DENY OUT TO <LAN CIDR>` | Block server-initiated traffic to other home devices | The actual isolation rule. The earlier ALLOWs are more specific and match first; everything else in the LAN gets blocked. |

**What still works after these rules apply:**
- Server reaches the internet (apt, npm, git clone, IPFS DHT, cert renewal — all via gateway → public IPs)
- Public services on the server (22, 80, 443, 4001, 9096) remain reachable from internet AND from your home laptop
- Your home laptop can SSH into the server, browse the WebUI, push pins via the IPFS Pinning Service API, etc.
- Inbound replies on existing connections (UFW conntrack: ESTABLISHED,RELATED traffic always allowed)

**What stops working (intentionally):**
- Server initiating outbound to other home devices on internal ports — the lateral-pivot path is closed
- Example blocked: server tries to scan a NAS at `192.168.1.50:445` for SMB shares → DENY
- Example blocked: server tries to log into the router admin UI at `192.168.1.1:80` (other than for default gateway routing) → wait, the router IS the gateway, so this is allowed; the rule allows traffic TO the gateway IP

**No collision with the inbound rules** in the same phase: UFW maintains separate `INPUT` (inbound) and `OUTPUT` (outbound) iptables chains. The inbound `allow 22/tcp` etc. govern packets coming TO the server; the outbound `deny out to <LAN>` governs packets going FROM the server. They cannot conflict because they apply to different traffic directions. Replies to legitimate inbound traffic are exempt via stateful conntrack.

**When the auto-detection skips itself** (with a clear log message):
- Gateway is a public IP (cloud VPS / direct-public setup): no home LAN to isolate, skipped
- LAN config detection failed (multiple interfaces, weird routing, no `ip` command output): skipped with WARN
- `--no-lan-isolation` flag passed: skipped with INFO

**Opting out** — `--no-lan-isolation`:
Use this only if your server legitimately needs to reach other home devices outbound. Examples:
- Backups to a LAN NAS at `192.168.1.50`
- IPFS peering with a second IPFS node on the same LAN
- Pulling docker images from a LAN-resident registry mirror

If you opt out, document which specific LAN destinations the server actually needs and consider adding explicit `ufw allow out to <ip>` rules manually rather than blanket-allowing the whole LAN.

**Verification** — `phase_post_verify` includes a check that confirms the LAN-isolation rule is in place when applicable. If the rule is missing on a private-LAN setup, `_verify_negative_exposure` emits a WARN.

**Manual override after recovery** — if you decide later that the server needs LAN access:
```bash
sudo ufw allow out to 192.168.1.50 comment 'NAS for backups'
# or to revert all LAN-isolation rules added by recover.sh:
for n in $(ufw status numbered | awk -F'[][]' '/recover.sh: lan-iso/{print $2}' | sort -rn); do
    yes | sudo ufw delete "$n"
done
```

---

## Section 10 — Troubleshooting

### `--backup-key must be exactly 64 hex chars` even though my key looks 64 chars long
The script trims whitespace + carriage returns and lowercases A-F before validating, but the error still fires if there's a non-hex character somewhere. Common causes:

| Cause | Symptom | Fix |
|---|---|---|
| Trailing CR from a Windows-edited file | `got 65 chars` (one extra) | `tr -d '\r' < keyfile` to strip; or paste in a Linux terminal |
| Quotes around the value | `got 66 chars, starting with '"abc****'` | drop the quotes around the flag value: `--backup-key abc...` not `--backup-key "abc..."` |
| Wrong characters (typo, base64) | `got 64 chars, starting with 'abc/****'` | non-hex char like `/`, `+`, `=` — verify the original on the old server: `cat /root/.fula-backup-key` |
| Embedded spaces | `got 70 chars` | clipboard paste split with formatting; re-copy the value cleanly |

Pull the canonical value off the old server:
```bash
ssh root@<old-server> "grep BACKUP_ENCRYPTION_KEY /root/.fula-backup-key | cut -d= -f2-"
```
Then pass it directly:
```bash
sudo bash recover.sh --backup-key 0123abc... ...
```

### `migrate-zip.sh` makes my server unresponsive
The kubo blocks tar+compress is the heaviest step. On hosts with large pinned datasets and limited CPU, single-threaded gzip + millions of small file reads CAN saturate one core and the disk simultaneously, making the host appear hung even though it's making progress.

Mitigations are applied automatically by the current script (`pigz`, `nice`, `ionice`, level-1 compression, no outer double-compress) but if your host still struggles:

1. **Install `pigz` first** if the script didn't auto-install it: `sudo apt install pigz` then re-run.
2. **Skip the kubo blocks tar entirely** — pass `--no-blocks` to migrate-zip.sh. The bundle becomes lightweight (configs + identities only) and you rsync `/home/root/ipfs_data` separately:
   ```bash
   sudo bash scripts/migrate-zip.sh --no-blocks
   # then in another terminal, with rsync's own bandwidth limit:
   rsync -aHP --bwlimit=50M /home/root/ipfs_data/ root@<new-server>:/home/root/ipfs_data/
   ```
   Then on the new server, `recover.sh --blocks-rsync /home/root/ipfs_data` reuses the rsync'd data without re-extracting from the bundle.
3. **Monitor**:
   ```bash
   du -h /tmp2/fula-migration-*/kubo/data.tgz   # bundle size grows over time
   iotop -aoP                                    # I/O usage of every process
   uptime                                        # load average
   ```
   If load average is climbing past `nproc * 2` and pinning-service traffic is timing out, hit Ctrl-C — the EXIT trap unpauses the cluster cleanly. Then re-run with `--no-blocks` and rsync separately.
4. **For severely-constrained hosts**, you can manually throttle the bundle even further by editing `_compress` in `scripts/migrate-zip.sh` to use `pigz -p 1` (single thread) — slower but won't compete with production for cores at all.

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

### `phase_verify_ipns_path` hangs at "manifest CID: …" forever
You're almost certainly running with the OLD server still up. The new server has the same kubo peer ID as the old one (we restored the identity from the bundle), and libp2p can't tell them apart on the DHT — bitswap fetches across the colliding peer ID get routed to the wrong node and stall.

The script (since the parallel-run fix) auto-detects this in `phase_docker_infra_start` and skips phase 10 with a clear log message. If you're seeing the hang, you're either (a) running an older version of `recover.sh` (pull latest), (b) the DHT findpeer probe didn't see the old node yet at the time of check (race), or (c) you're explicitly requesting verify with the old server up. To unstick:

```bash
# Ctrl-C the script, then:
sudo touch /var/lib/fula-recovery/state/verify_ipns_path.done   # mark phase 10 done so re-run skips it
# Re-run with --skip-ipns-verify (or --parallel-run, which auto-defers other things too):
sudo bash recover.sh --bundle ... --backup-key ... --db-ipns ... --registry-ipns ... --ssl-email ... --defer-dns --parallel-run
```

After cutover (old kubo+cluster stopped), run `--finalize-cutover` to validate the IPNS path properly. The script also has a 5-minute hard timeout on the `ipfs cat` calls in phase 10 (configurable via `IPNS_FETCH_TIMEOUT`), so it can't hang indefinitely on newer versions.

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
