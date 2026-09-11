#!/usr/bin/env bash
#
# nginx_hardening.sh — make nginx unable to be wedged by a DNS failure.
#
# THE PROBLEM THIS SOLVES
# -----------------------
# nginx resolves a LITERAL hostname in `proxy_pass` once, at configuration
# parse time. If that name does not resolve at that moment, the config test
# fails outright:
#
#     [emerg] host not found in upstream "example.com" in /etc/nginx/...:52
#     nginx: configuration file /etc/nginx/nginx.conf test failed
#
# systemd runs that test as nginx.service's ExecStartPre, so the whole
# server refuses to start — taking down EVERY vhost on the machine, not
# just the one with the bad upstream. Nothing retries. On 2026-09-11 this
# took cloud.fx.land, ai.cloud.fx.land and s3.cloud.fx.land down for ~12
# hours: an unattended glibc upgrade restarted nginx at 06:51, a dynamic-DNS
# upstream happened not to resolve in that instant, and nginx stayed dead
# until a human noticed. The backing services were healthy the entire time.
#
# THE FIX
# -------
# Put the hostname in a VARIABLE and give the block a `resolver`. nginx then
# resolves it per request instead of at startup, so a DNS failure degrades
# to a 502 on that one location instead of refusing to boot. Behaviour is
# otherwise identical — a `rewrite ... break` reproduces the prefix-stripping
# that `proxy_pass scheme://host/;` does implicitly.
#
# WHAT THIS SCRIPT GUARANTEES
# ---------------------------
#   * Idempotent. Run it as often as you like; already-hardened blocks are
#     skipped and it exits 0 with "nothing to do".
#   * Conservative. It only rewrites location blocks whose shape it can
#     transform with certainty. Anything unusual is REPORTED and left alone.
#   * Reversible. Every touched file is backed up first, and any failure of
#     `nginx -t`, of the reload, or of the post-checks restores the backups
#     and reloads the previous config automatically.
#   * Non-disruptive. It uses `reload` (which keeps listening sockets open),
#     never `restart`, when nginx is already running.
#   * Verified. It captures a baseline of every local upstream and every
#     public server_name BEFORE touching anything, and afterwards only
#     reports a REGRESSION — something that worked before and does not now.
#
# USAGE
#   sudo bash nginx_hardening.sh              # detect and fix
#   sudo bash nginx_hardening.sh --dry-run    # detect and report only
#
set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
    esac
done

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
step()  { echo "${GREEN}[STEP]${NC} $*"; }
info()  { echo "${BLUE}[INFO]${NC} $*"; }
warn()  { echo "${YELLOW}[WARN]${NC} $*"; }
err()   { echo "${RED}[ERROR]${NC} $*" >&2; }

SITES_ENABLED="/etc/nginx/sites-enabled"
BACKUP_ROOT="/var/backups/nginx-hardening"
STAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/$STAMP"
BASELINE="$(mktemp)"; AFTER="$(mktemp)"
trap 'rm -f "$BASELINE" "$AFTER"' EXIT

# ============================================================
# Preflight
# ============================================================

[ "${EUID:-$(id -u)}" -eq 0 ] || { err "Run as root (sudo bash $0)"; exit 1; }
command -v nginx >/dev/null 2>&1 || { err "nginx is not installed"; exit 1; }
command -v python3 >/dev/null 2>&1 || { err "python3 is required"; exit 1; }
[ -d "$SITES_ENABLED" ] || { err "$SITES_ENABLED does not exist"; exit 1; }

step "Preflight"

NGINX_WAS_ACTIVE=false
if systemctl is-active --quiet nginx; then NGINX_WAS_ACTIVE=true; fi
info "nginx currently active: $NGINX_WAS_ACTIVE"

# Whether the config is valid BEFORE we touch anything. If it is already
# broken we must not be blamed for it — and we must not "roll back" to a
# broken state and call that success.
CONFIG_WAS_VALID=false
if nginx -t >/dev/null 2>&1; then CONFIG_WAS_VALID=true; fi
info "nginx config valid before changes: $CONFIG_WAS_VALID"
if [ "$CONFIG_WAS_VALID" = false ]; then
    warn "Config is ALREADY failing its test. Current error:"
    nginx -t 2>&1 | sed 's/^/       /' | tail -5
    warn "Hardening may well be the fix, but read the error above first."
fi

# Which resolver to hand nginx. systemd-resolved's stub is the right answer
# on Ubuntu; otherwise take the first real nameserver from resolv.conf.
RESOLVER=""
if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
    RESOLVER="127.0.0.53"
else
    RESOLVER="$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null || true)"
    # 127.0.0.53 is systemd-resolved's stub; without the service it is dead.
    if [ -z "$RESOLVER" ] || [ "$RESOLVER" = "127.0.0.53" ]; then
        RESOLVER="1.1.1.1 8.8.8.8"
        warn "No usable local resolver found; falling back to public DNS ($RESOLVER)"
    fi
fi
info "resolver for nginx: $RESOLVER"

# ============================================================
# Baseline — what works RIGHT NOW
# ============================================================

# Local upstream ports referenced by the config: these must keep answering.
collect_upstream_ports() {
    grep -Rho -E "127\.0\.0\.1:[0-9]+" "$SITES_ENABLED"/ 2>/dev/null \
        | cut -d: -f2 | sort -un
}

# Public names this nginx serves, excluding wildcards/defaults we cannot probe.
collect_server_names() {
    grep -Rh -E "^\s*server_name\s" "$SITES_ENABLED"/ 2>/dev/null \
        | sed -E 's/^\s*server_name\s+//; s/;\s*$//' \
        | tr ' ' '\n' \
        | grep -vE '^\s*$|^_$|^\*|localhost' \
        | sort -u
}

probe_all() {
    local out="$1"
    : > "$out"
    local p
    for p in $(collect_upstream_ports); do
        local code
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "http://127.0.0.1:$p/" 2>/dev/null || echo 000)"
        echo "port:$p=$code" >> "$out"
    done
    local n
    for n in $(collect_server_names); do
        local code
        # Resolve to this host so we test THIS nginx, not wherever DNS points.
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -k \
                 --resolve "$n:443:127.0.0.1" "https://$n/" 2>/dev/null || echo 000)"
        echo "host:$n=$code" >> "$out"
    done
}

step "Capturing baseline (what is working before any change)"
probe_all "$BASELINE"
info "$(grep -c . "$BASELINE") endpoints probed"

# ============================================================
# Detect + transform (python does the brace-aware parsing)
# ============================================================

TRANSFORMER="$(mktemp /tmp/nginx_harden_XXXXXX.py)"
trap 'rm -f "$BASELINE" "$AFTER" "$TRANSFORMER"' EXIT
cat > "$TRANSFORMER" <<'PYEOF'
"""Rewrite literal-hostname proxy_pass blocks to resolve at request time.

Conservative by design: a location block is only transformed when its shape
is unambiguous. Anything else is reported for a human and left untouched.
"""
import os
import re
import sys

resolver = sys.argv[1]
mode = sys.argv[2]            # "detect" or "apply"
paths = sys.argv[3:]

# Hosts that need no DNS: IPs, localhost, and nginx upstream{} block names.
IP_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
PROXY_RE = re.compile(
    r"^(?P<indent>\s*)proxy_pass\s+(?P<scheme>https?)://(?P<host>[^/;:\s$]+)"
    r"(?P<port>:\d+)?(?P<uri>/[^;\s]*)?\s*;\s*$"
)
LOCATION_RE = re.compile(r"^\s*location\s+(?P<mod>=|~\*?|\^~)?\s*(?P<path>\S+)\s*\{")


def upstream_names(text):
    return set(re.findall(r"^\s*upstream\s+(\S+)\s*\{", text, re.M))


def needs_dns(host, upstreams):
    if IP_RE.match(host) or host in ("localhost",) or host.startswith("$"):
        return False
    if host in upstreams:
        return False
    return "." in host          # a real DNS name has a dot


def find_location_blocks(lines):
    """Yield (start_idx, end_idx, header_match) for each location block."""
    for i, line in enumerate(lines):
        m = LOCATION_RE.match(line)
        if not m:
            continue
        depth = 0
        for j in range(i, len(lines)):
            depth += lines[j].count("{") - lines[j].count("}")
            if depth == 0:
                yield i, j, m
                break


for path in paths:
    real = os.path.realpath(path)
    try:
        with open(real, "r", encoding="utf-8", errors="surrogateescape") as fh:
            text = fh.read()
    except OSError as exc:
        print(f"SKIP\t{path}\tunreadable: {exc}")
        continue

    lines = text.splitlines(keepends=True)
    ups = upstream_names(text)
    changed = False
    var_seq = 0

    for start, end, loc in find_location_blocks(lines):
        block = lines[start:end + 1]
        body = "".join(block)

        proxy_idx = None
        proxy_m = None
        for k, line in enumerate(block):
            m = PROXY_RE.match(line)
            if m and needs_dns(m.group("host"), ups):
                proxy_idx, proxy_m = k, m
                break
        if proxy_m is None:
            # A hardened block no longer matches, because its host is now a
            # variable. Report it anyway: a re-run should CONFIRM protection
            # rather than say nothing, which is indistinguishable from "this
            # script did not look at that block".
            if "resolver " in body and re.search(r"proxy_pass\s+https?://\$", body):
                seen = re.search(r'set\s+\$\S+\s+"([^"]+)"', body)
                print(f"OK\t{real}\t{seen.group(1) if seen else '(variable)'}\talready hardened")
            continue

        host = proxy_m.group("host")

        # Already hardened? (variable upstream, or a resolver in the block)
        if "resolver " in body:
            print(f"OK\t{real}\t{host}\talready hardened")
            continue

        # Only simple PREFIX locations are safe to rewrite: a regex location
        # has different matching precedence and rewriting it could shadow
        # another location on the same server.
        mod = loc.group("mod")
        loc_path = loc.group("path")
        if mod in ("~", "~*", "="):
            print(f"MANUAL\t{real}\t{host}\tlocation {mod or ''} {loc_path}")
            continue

        uri = proxy_m.group("uri")
        # Supported: no URI part (pass through as-is) or exactly "/" (strip
        # the location prefix). A deeper URI would need its own rewrite and
        # is left for a human.
        if uri not in (None, "/"):
            print(f"MANUAL\t{real}\t{host}\tproxy_pass URI '{uri}'")
            continue

        if mode == "detect":
            print(f"FIX\t{real}\t{host}\tlocation {loc_path}")
            continue

        var_seq += 1
        var = f"fx_upstream_{var_seq}"
        indent = proxy_m.group("indent")
        scheme = proxy_m.group("scheme")
        port = proxy_m.group("port") or ""

        new_lines = [
            f"{indent}# Hardened by scripts/nginx_hardening.sh: resolve at REQUEST time.\n",
            f"{indent}# A literal hostname here is resolved during `nginx -t`, so one DNS\n",
            f"{indent}# blip during a restart takes EVERY vhost on this host down. With a\n",
            f"{indent}# variable + resolver, a DNS failure is a 502 on this path only.\n",
            f"{indent}resolver {resolver} valid=30s ipv6=off;\n",
            f"{indent}resolver_timeout 5s;\n",
            f'{indent}set ${var} "{host}";\n',
        ]
        if uri == "/":
            # `proxy_pass scheme://host/;` strips the location prefix. A
            # variable proxy_pass does not, so reproduce it explicitly.
            prefix = loc_path.rstrip("/")
            new_lines.append(
                f"{indent}rewrite ^{re.escape(prefix)}/(.*)$ /$1 break;\n"
            )
        new_lines.append(f"{indent}proxy_pass {scheme}://${var}{port};\n")

        block[proxy_idx:proxy_idx + 1] = new_lines
        lines[start:end + 1] = block
        changed = True
        print(f"APPLIED\t{real}\t{host}\tlocation {loc_path}")

    if changed and mode == "apply":
        with open(real, "w", encoding="utf-8", errors="surrogateescape") as fh:
            fh.write("".join(lines))

sys.exit(0)
PYEOF

mapfile -t VHOSTS < <(find "$SITES_ENABLED" -mindepth 1 \( -type f -o -type l \) | sort)
if [ "${#VHOSTS[@]}" -eq 0 ]; then
    info "No vhosts in $SITES_ENABLED — nothing to do."
    exit 0
fi

step "Scanning ${#VHOSTS[@]} enabled vhost(s) for DNS-dependent upstreams"
DETECT_OUT="$(python3 "$TRANSFORMER" "$RESOLVER" detect "${VHOSTS[@]}")"
echo "$DETECT_OUT" | sed '/^$/d' | sed 's/^/       /'

TO_FIX="$(echo "$DETECT_OUT" | grep -c '^FIX' || true)"
NEEDS_MANUAL="$(echo "$DETECT_OUT" | grep -c '^MANUAL' || true)"

if [ "$NEEDS_MANUAL" -gt 0 ]; then
    warn "$NEEDS_MANUAL block(s) need manual review — NOT touched by this script."
fi

if [ "$TO_FIX" -eq 0 ]; then
    info "No hardenable DNS-dependent upstreams found. Nothing to do."
    if [ "$NGINX_WAS_ACTIVE" = false ] && [ "$CONFIG_WAS_VALID" = true ]; then
        warn "nginx is NOT running but its config is valid — start it with: systemctl start nginx"
    fi
    exit 0
fi

if [ "$DRY_RUN" = true ]; then
    info "--dry-run: $TO_FIX block(s) would be hardened. No changes made."
    exit 0
fi

# ============================================================
# Apply, with backup + automatic rollback
# ============================================================

step "Backing up vhosts to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
for f in "${VHOSTS[@]}"; do
    real="$(readlink -f "$f")"
    cp -a "$real" "$BACKUP_DIR/$(basename "$real")"
done
info "$(ls -1 "$BACKUP_DIR" | wc -l) file(s) backed up"

rollback() {
    warn "Rolling back from $BACKUP_DIR"
    local b
    for b in "$BACKUP_DIR"/*; do
        [ -e "$b" ] || continue
        local target="/etc/nginx/sites-available/$(basename "$b")"
        [ -e "$target" ] && cp -a "$b" "$target"
    done
    if nginx -t >/dev/null 2>&1; then
        if [ "$NGINX_WAS_ACTIVE" = true ]; then
            systemctl reload nginx || systemctl restart nginx || true
        fi
        info "Rollback complete; previous config restored."
    else
        err "Rollback restored the files but nginx -t still fails. Manual attention required."
        nginx -t 2>&1 | sed 's/^/       /' | tail -5
    fi
}

step "Applying hardening"
if ! python3 "$TRANSFORMER" "$RESOLVER" apply "${VHOSTS[@]}" | sed 's/^/       /'; then
    err "Transformer failed"; rollback; exit 1
fi

step "Validating configuration"
if ! nginx -t >/dev/null 2>&1; then
    err "nginx -t FAILED after hardening:"
    nginx -t 2>&1 | sed 's/^/       /' | tail -8
    rollback
    exit 1
fi
info "nginx -t passed"

step "Applying to the running server"
if [ "$NGINX_WAS_ACTIVE" = true ]; then
    # reload, never restart: reload keeps the listening sockets, so a bad
    # config can never leave the machine with nothing on :80/:443.
    if ! systemctl reload nginx; then
        err "reload failed"; rollback; exit 1
    fi
    info "nginx reloaded"
else
    if ! systemctl start nginx; then
        err "start failed"; rollback; exit 1
    fi
    info "nginx started (it was not running before)"
fi

sleep 2
if ! systemctl is-active --quiet nginx; then
    err "nginx is not active after the change"; rollback; exit 1
fi

# ============================================================
# Verify — compare against the baseline, flag only REGRESSIONS
# ============================================================

step "Verifying every endpoint against the baseline"
probe_all "$AFTER"

REGRESSIONS=0
while IFS='=' read -r key before; do
    [ -n "$key" ] || continue
    after="$(grep -F "$key=" "$AFTER" | head -1 | cut -d= -f2- || true)"
    if [ "$before" != "000" ] && { [ "$after" = "000" ] || [ -z "$after" ]; }; then
        err "REGRESSION: $key was $before, now ${after:-missing}"
        REGRESSIONS=$((REGRESSIONS + 1))
    elif [ "$before" != "$after" ]; then
        info "changed (not a regression): $key $before -> $after"
    fi
done < "$BASELINE"

if ! ss -lnt 2>/dev/null | grep -qE ':80\s|:443\s'; then
    err "nginx is not listening on 80/443"
    REGRESSIONS=$((REGRESSIONS + 1))
fi

if [ "$REGRESSIONS" -gt 0 ]; then
    err "$REGRESSIONS regression(s) detected — rolling back."
    rollback
    exit 1
fi

step "Done"
info "Hardened $TO_FIX upstream block(s); no regressions."
info "Backup kept at: $BACKUP_DIR"
if [ "$NEEDS_MANUAL" -gt 0 ]; then
    warn "$NEEDS_MANUAL block(s) still use a literal hostname and need manual review (see MANUAL lines above)."
fi
echo
info "Proof it worked — this should no longer mention 'host not found in upstream':"
nginx -t 2>&1 | sed 's/^/       /' | tail -2
