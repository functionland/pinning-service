# Self-hosted OpenBao KMS for the Cloudflare-Workers MCP server

`scripts/openbao-setup.sh` installs and hardens [OpenBao](https://openbao.org)
(the open-source HashiCorp Vault fork) on a **brand-new Ubuntu/Debian server** and
turns it into the **encryption-as-a-service KMS** for an MCP server that runs on
Cloudflare Workers.

The Worker never holds the master key. It calls OpenBao's `transit/decrypt` to
unwrap per-user data keys; the **master key (the KEK) never leaves OpenBao.**

---

## Why this design — trust-domain separation

The system is split into two trust domains on purpose:

| Trust domain | Runs where | Holds | If compromised |
|---|---|---|---|
| **Compute** (MCP logic) | Cloudflare Workers (untrusted-ish edge) | An AppRole that can only `encrypt`/`decrypt` with **one** key, **rate-limited** | Attacker gets a *rate-limited Decrypt oracle* for as long as the credential lives — **never the KEK**, never bulk export, never other keys. |
| **Key custody** (the KEK) | This OpenBao box (small, dedicated, patched) | The KEK + all ciphertext-unwrapping power | Attacker on the *running, unsealed* box can reach the KEK. This box is the thing you protect. |

The whole point: a Worker compromise (leaked env, supply-chain, edge bug) degrades
to "an attacker can ask this box to decrypt, slowly, one blob at a time, until you
rotate the AppRole" — **not** "an attacker has your master key." Envelope encryption
means the Worker handles only short-lived per-user data keys it unwraps on demand;
the KEK that protects all of them stays in OpenBao.

```
 Cloudflare Worker (MCP)                 This OpenBao box
 ───────────────────────                 ────────────────────────────
  fetch() ──HTTPS──▶  Caddy :443 ──▶ OpenBao :8200 (loopback)
   AppRole login           (Let's Encrypt)     transit/decrypt/<KEK>
   transit/decrypt                              KEK never leaves here
```

---

## What the script sets up

1. **Pre-flight** — requires root; confirms Ubuntu/Debian; checks the domain resolves
   to this host's public IP (prints the exact `A` record to create if not); checks
   ports 80/443 are free. Halts loudly on anything it can't safely assume.
2. **Packages** — Docker + compose plugin (distro `docker.io`, falling back to the
   official Docker repo), `ufw`, `fail2ban`, `unattended-upgrades`, `curl`, `jq`.
3. **OS hardening** — UFW (default-deny incoming, **SSH allowed first + rate-limited**,
   80 for ACME, 443 later narrowed to Cloudflare), `fail2ban` sshd jail on the real
   SSH port, `unattended-upgrades`, Docker-safe `sysctl`, and SSH hardening
   (root login off; password auth off **only when a non-root key already exists**).
4. **OpenBao + Caddy** via Docker Compose. Caddy gets a Let's Encrypt certificate and
   reverse-proxies to OpenBao. OpenBao uses **integrated raft** storage, a **file
   audit device** (persisted), and is **not** run in `-dev` mode.
5. **Cloudflare IP allowlist** — 443 ingress restricted to Cloudflare's published
   ranges (`ips-v4` + `ips-v6`).
6. **Initialise + unseal** — `operator init` (5 shares / threshold 3); unseal keys +
   root token are shown **once** and **never written to disk** by the script.
7. **Transit** — enables `transit`, creates a **non-exportable KEK** with rotation, a
   **least-privilege policy** (encrypt + decrypt only), an **AppRole** for the Worker,
   and a **rate-limit quota** on the transit path.
8. **Output** — the HTTPS URL, the Worker's AppRole role-id/secret-id, the key name,
   the exact Worker wiring, and a security checklist.

---

## Interactive parameters

| Prompt | Env var (`--non-interactive`) | Default | Validation |
|---|---|---|---|
| OpenBao domain (FQDN) | `OPENBAO_DOMAIN` | — (required) | RFC-1123 hostname |
| Let's Encrypt / ACME email | `LETSENCRYPT_EMAIL` | — (required) | `user@host.tld` |
| SSH port to keep open | `SSH_PORT` | detected live port, else `22` | 1–65535 |
| Transit KEK name | `OPENBAO_KEY_NAME` | `fula-mcp-workspace-kek` | `[A-Za-z0-9_-]` |
| Transit rate-limit (req/s) | `OPENBAO_QUOTA_RATE` | `200` | integer |
| Destructive-change confirm | `ASSUME_YES=1` | prompt | type `yes` |
| Skip DNS check | `SKIP_DNS_CHECK=1` | off (still warns) | — |

Run modes:

```bash
sudo ./scripts/openbao-setup.sh                 # interactive
sudo ./scripts/openbao-setup.sh --dry-run       # print actions, change nothing
sudo OPENBAO_DOMAIN=bao.example.com \
     LETSENCRYPT_EMAIL=ops@example.com \
     SSH_PORT=22 ASSUME_YES=1 \
     ./scripts/openbao-setup.sh --non-interactive
```

The script is **idempotent** (re-runnable) and **halts, never guesses**: every step
checks its preconditions and fails with the specific problem rather than half-applying.

---

## Lockout safety (read before running)

The script will **not** lock you out of SSH:

- It **detects your live SSH port** from `$SSH_CONNECTION` (field 4), falling back to
  parsing `ss` for the listening sshd port. If your chosen `SSH_PORT` differs from the
  detected one, it **warns and makes you confirm** (a wrong port + firewall = lockout).
- UFW order is load-bearing: it **allows SSH first** (`ufw limit` = rate-limited) — and
  additionally pins an allow rule for **your current client IP** — **before** enabling
  default-deny. It never runs `ufw reset`.
- SSH password auth is disabled **only if** a **non-root** user already has a non-empty
  `~/.ssh/authorized_keys` with a valid key line. Otherwise it **warns and skips** that
  step so you can't strand yourself. Root login is always disabled.
- The sshd change is written as a **drop-in** and validated with `sshd -t`; on failure
  the drop-in is removed and SSH is left untouched. The service is **reloaded, not
  restarted**, so existing sessions survive.
- `fail2ban` watches the **real** SSH port (not a hard-coded 22).

**Always keep a second SSH session open** while running this, and confirm you can open
a *new* one before closing them — the script prints a "you can still SSH in" line, but
verify it yourself.

---

## DNS model: DNS-only (grey cloud), not proxied

The host must own a **DNS-only `A` record** pointing the domain straight at this box:

```
Type: A   Name: bao.example.com   Value: <this-host-public-IPv4>   Proxy: DNS only
```

Why not Cloudflare's orange-cloud proxy on this record?

- Let's Encrypt validates via **HTTP-01 on port 80 directly to this host**. The script
  pins Caddy to HTTP-01 (`disable_tlsalpn_challenge`) because 443 is Cloudflare-locked,
  and TLS-ALPN-01 on a CF-restricted 443 would fail.
- The pre-flight "domain resolves to this host" check expects the name to resolve to the
  box, not to Cloudflare's edge.

The Worker still reaches the box *through* Cloudflare's network (that's where its egress
originates); the **record** just needs to resolve to the origin.

---

## Honest limits (what this does and does not protect)

Be clear-eyed about the threat model:

- **A compromise of this running, unsealed box can reach the KEK.** Sealing protects
  data **at rest** (a stolen disk is useless without the unseal keys), but while OpenBao
  is unsealed and serving, anyone who roots this host can use the KEK. **Mitigation:**
  keep this box **minimal, dedicated, and patched** — don't co-host other services on it.
- **This is a software seal, not an HSM.** The unseal keys protect the master key in
  software. There is no hardware tamper boundary. For higher assurance, OpenBao supports
  auto-unseal via a cloud KMS/HSM — see the trade-off below.
- **The Cloudflare IP allowlist is NOT authentication.** Those published ranges are
  shared by **every** Cloudflare customer, and Cloudflare does **not** guarantee that
  Worker `fetch()` *egress* falls within the published *ingress*/CDN ranges. So the
  allowlist is a **coarse anti-scan / anti-DDoS filter only**. The **real auth boundary
  is the AppRole** the Worker presents (short-lived token, one key, rate-limited). If you
  need "only *my* Worker," use the **Cloudflare Tunnel + Access service-token** upgrade
  below — and verify egress reachability on a disposable VPS first (see next section).
- **Auto-unseal trade-off.** The script deliberately does **not** enable auto-unseal.
  Auto-unseal (e.g. via a cloud KMS transit seal) means the box unseals itself on reboot
  — convenient, but it moves the root of trust to that external KMS and removes the
  "needs human-held keys to come back" property. Manual unseal is the safer default for a
  dedicated KMS; adopt auto-unseal only with eyes open.
- **Single node.** Integrated raft on one node = no HA. For production resilience, run a
  raft cluster (out of scope here) and **back up** raft snapshots + your unseal keys.

---

## Test on a disposable VPS first

You cannot meaningfully run this anywhere but a throwaway Linux host — it mutates the
firewall, SSH, sysctl, and installs packages. Before any real deployment:

1. Spin up a **disposable** Ubuntu 22.04/24.04 VPS you can destroy.
2. Point a **test** subdomain's DNS-only `A` record at it.
3. `sudo ./scripts/openbao-setup.sh --dry-run` — read every action.
4. Run it for real; from a **second** machine confirm:
   - You can still SSH in (lockout check).
   - `ufw status` shows SSH limited, 80 open, and **443 only from Cloudflare CIDRs**
     (no global `443 ALLOW`).
   - `https://<domain>/v1/sys/health` answers (cert valid).
   - The audit log exists at `/opt/openbao/openbao/logs/openbao_audit.log`.
5. **Crucially**, deploy a throwaway Worker and confirm it can actually reach
   `transit/decrypt` **through** the Cloudflare allowlist. If the Worker's egress is
   *not* in the published ranges, the allowlist will block your own Worker — switch to
   the Cloudflare Tunnel approach below.
6. Re-run the script on the same box to confirm **idempotency** (everything reports
   "already …", nothing duplicates, `operator init` is skipped).

---

## Configuring the Cloudflare Worker

The script prints these at the end (the secret-id is shown **once**):

```
BAO_ADDR        = https://bao.example.com
BAO_TRANSIT_KEY = fula-mcp-workspace-kek
BAO_ROLE_ID     = <role-id>
BAO_SECRET_ID   = <secret-id>   # store as a Worker secret immediately
```

```bash
npx wrangler secret put BAO_SECRET_ID     # paste the value
npx wrangler secret put BAO_ROLE_ID
# BAO_ADDR / BAO_TRANSIT_KEY can live in wrangler.toml [vars]
```

Worker request flow:

```js
// 1) AppRole login -> short-lived token (TTL 20m). Cache + refresh on 403/expiry.
const login = await fetch(`${BAO_ADDR}/v1/auth/approle/login`, {
  method: "POST",
  body: JSON.stringify({ role_id: env.BAO_ROLE_ID, secret_id: env.BAO_SECRET_ID }),
});
const token = (await login.json()).auth.client_token;

// 2) Unwrap a per-user data key. The KEK never leaves OpenBao.
const dec = await fetch(`${BAO_ADDR}/v1/transit/decrypt/${BAO_TRANSIT_KEY}`, {
  method: "POST",
  headers: { "X-Vault-Token": token },
  body: JSON.stringify({ ciphertext: "vault:v1:..." }),
});
const dataKeyB64 = (await dec.json()).data.plaintext; // base64; use, never log
```

### The least-privilege policy (what the Worker can do — and nothing else)

```hcl
path "transit/encrypt/fula-mcp-workspace-kek" { capabilities = ["update"] }
path "transit/decrypt/fula-mcp-workspace-kek" { capabilities = ["update"] }
```

- `encrypt`/`decrypt` are POST endpoints, so the capability is **`update`**, not `read`.
- **No** `read` of `transit/keys/...` (that would expose key metadata).
- **No** `sys/*`, **no** `datakey`, **no** `rewrap`, **no** `export`, **no** wildcards.
- The **rate-limit quota** is created by the admin token at setup and is **not** part of
  the Worker's policy — a compromised Worker cannot remove it.

If the Worker ever needs to *generate* envelope data keys server-side, it would need
`transit/datakey/...` — deliberately **excluded** here. Add it consciously if required.

---

## Rotation

### Rotate the KEK
The KEK auto-rotates every 90 days (configured by the script). Transit is
version-aware: new data is encrypted with the latest version, old ciphertext (e.g.
`vault:v1:...`) still decrypts. To rotate on demand and (optionally) refuse old
versions for *new* operations:

```bash
docker exec -e BAO_TOKEN=<admin> openbao bao write -f transit/keys/fula-mcp-workspace-kek/rotate
# Optionally raise the minimum decrypt/encrypt version after re-wrapping old data:
docker exec -e BAO_TOKEN=<admin> openbao bao write transit/keys/fula-mcp-workspace-kek/config \
  min_decryption_version=2
```

Rotating does **not** require re-deploying the Worker — same key name, same policy.

### Rotate the AppRole secret-id (the Worker credential)
The role-id is stable; the **secret-id** is the secret and is short-TTL by design
(30 days). To rotate:

```bash
# Mint a new secret-id:
docker exec -e BAO_TOKEN=<admin> openbao bao write -f \
  auth/approle/role/fula-mcp-worker/secret-id
# Put the new secret-id on the Worker:
npx wrangler secret put BAO_SECRET_ID
# Then destroy the old secret-id (look up its accessor and):
docker exec -e BAO_TOKEN=<admin> openbao bao write \
  auth/approle/role/fula-mcp-worker/secret-id-accessor/destroy \
  secret_id_accessor=<old-accessor>
```

Worker tokens themselves are short-lived (20m/1h); the Worker re-authenticates on
expiry. That re-auth loop **is** the rotation story for tokens.

---

## Hardening upgrade: Cloudflare Tunnel + Access service-token

The IP allowlist is the baseline. The strictly-stronger setup removes the public 443
surface entirely and gives you *real* per-caller authentication:

1. Install `cloudflared` on this box and create a **named tunnel** to
   `http://127.0.0.1:8200` (OpenBao's loopback). No inbound port is opened — the tunnel
   dials **out** to Cloudflare.
2. Then you can **close 443 inbound entirely** in UFW (and even 80, if you switch Caddy
   to the DNS-01 ACME challenge or let Cloudflare terminate TLS). The KMS has **no
   public listener** at all.
3. Put a **Cloudflare Access** policy in front of the hostname requiring a **service
   token** (client-id/secret) that only your Worker holds. Now reachability is gated by
   *a credential you issued*, not by "any Cloudflare IP."
4. The Worker presents both the Access service-token (`CF-Access-Client-Id` /
   `CF-Access-Client-Secret` headers) **and** its OpenBao AppRole — defence in depth.

This converts the coarse network filter into genuine authentication and shrinks the
attack surface to zero public ports. Adopt it for any non-test deployment where the
allowlist's "shared CF ranges" caveat matters.

---

## Files this creates on the host

```
/opt/openbao/docker-compose.yml
/opt/openbao/Caddyfile
/opt/openbao/openbao/config/openbao.hcl
/opt/openbao/openbao/data/            # raft storage (uid 100)
/opt/openbao/openbao/logs/            # audit log (uid 100)
/opt/openbao/caddy/{data,config}/     # certs + Caddy state
/etc/ssh/sshd_config.d/99-openbao-hardening.conf
/etc/sysctl.d/99-openbao-hardening.conf
/etc/fail2ban/jail.d/openbao-sshd.local
/etc/apt/apt.conf.d/20auto-upgrades
```

The unseal keys and root token are **never** written anywhere by the script — store
them yourself, off this box, in a password manager.
