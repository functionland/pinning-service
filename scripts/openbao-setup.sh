#!/usr/bin/env bash
#
# openbao-setup.sh — Interactive install + hardening of OpenBao (the open-source
# HashiCorp Vault fork) as a self-hosted KMS for a Cloudflare-Workers MCP server.
#
# WHAT THIS DOES (high level — see scripts/README-openbao.md for the full story):
#   - Hardens a brand-new Ubuntu/Debian host (UFW, fail2ban, unattended-upgrades,
#     sysctl, SSH) WITHOUT ever locking the operator out.
#   - Runs OpenBao + Caddy (automatic HTTPS via Let's Encrypt) under Docker Compose.
#     The master key (KEK) lives ONLY in OpenBao on this box; the Cloudflare Worker
#     calls transit/decrypt to unwrap per-user data keys and never sees the KEK.
#   - Restricts inbound 443 to Cloudflare's published IP ranges (a coarse baseline;
#     the real auth boundary is the AppRole the Worker presents — see README).
#   - Initialises + unseals OpenBao, enables the transit engine, creates a
#     non-exportable KEK, a least-privilege encrypt/decrypt-only policy, an AppRole
#     for the Worker, and a rate-limit quota on the transit path.
#
# DESIGN PRINCIPLES (non-negotiable):
#   - HALTS, NEVER GUESSES. Every step checks its preconditions and fails LOUDLY
#     with the specific problem rather than half-applying.
#   - IDEMPOTENT. Re-runnable; already-done steps are detected and skipped.
#   - LOCKOUT-SAFE. SSH is allowed (rate-limited) BEFORE default-deny is enabled;
#     password auth is only disabled when a non-root key is already present.
#   - SECRETS NEVER TOUCH DISK. Unseal keys + root token are shown once, in memory.
#
# YOU CANNOT meaningfully run this on anything but a disposable Linux VPS. It mutates
# firewall, SSH and packages. TEST ON A THROWAWAY VPS FIRST. See the README.
#
# Usage:
#   sudo ./scripts/openbao-setup.sh                 # interactive
#   sudo ./scripts/openbao-setup.sh --dry-run       # print actions, change nothing
#   sudo OPENBAO_DOMAIN=bao.example.com \
#        LETSENCRYPT_EMAIL=ops@example.com \
#        SSH_PORT=22 ASSUME_YES=1 \
#        ./scripts/openbao-setup.sh --non-interactive   # CI / repeatable
#
# Exit codes: 0 ok · 1 usage/precondition · 2 halted on a guard · 3 runtime failure
#
set -euo pipefail

# ----------------------------------------------------------------------------
# Constants (pinned — see README for how these were chosen / how to update them)
# ----------------------------------------------------------------------------
readonly SCRIPT_NAME="openbao-setup.sh"
readonly OPENBAO_IMAGE="ghcr.io/openbao/openbao:2.5.5"   # stable; GHCR tag has no 'v' prefix
readonly CADDY_IMAGE="caddy:2-alpine"
readonly STACK_DIR="/opt/openbao"                        # compose + config + Caddyfile live here
readonly OPENBAO_KEY_NAME_DEFAULT="fula-mcp-workspace-kek"
readonly OPENBAO_POLICY_NAME="fula-mcp-worker"
readonly OPENBAO_APPROLE_NAME="fula-mcp-worker"
readonly OPENBAO_QUOTA_NAME="fula-mcp-transit-rl"
readonly OPENBAO_QUOTA_RATE_DEFAULT="200"                # requests/sec on the transit path
readonly CF_IPV4_URL="https://www.cloudflare.com/ips-v4"
readonly CF_IPV6_URL="https://www.cloudflare.com/ips-v6"
readonly UFW_CF_COMMENT="openbao-cf-allow"               # tag so we can reconcile idempotently
readonly SSHD_DROPIN="/etc/ssh/sshd_config.d/99-openbao-hardening.conf"
readonly SYSCTL_DROPIN="/etc/sysctl.d/99-openbao-hardening.conf"
readonly UNATTENDED_CFG="/etc/apt/apt.conf.d/20auto-upgrades"

# ----------------------------------------------------------------------------
# Logging helpers
# ----------------------------------------------------------------------------
# Colour only when stdout is a TTY (keeps CI logs clean).
if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YLW=$'\033[0;33m'
  C_BLU=$'\033[0;34m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_BLD=""; C_RST=""
fi

log()   { printf '%s[*]%s %s\n' "$C_BLU" "$C_RST" "$*"; }
ok()    { printf '%s[+]%s %s\n' "$C_GRN" "$C_RST" "$*"; }
warn()  { printf '%s[!]%s %s\n' "$C_YLW" "$C_RST" "$*" >&2; }
step()  { printf '\n%s==== %s ====%s\n' "$C_BLD" "$*" "$C_RST"; }
# die: loud, specific failure. This is the "halts, never guesses" primitive.
die()   { printf '%s[FATAL]%s %s\n' "$C_RED" "$C_RST" "$*" >&2; exit "${2:-2}"; }

# ----------------------------------------------------------------------------
# Global flags / parameters (filled by arg parsing + prompts)
# ----------------------------------------------------------------------------
DRY_RUN=0
NON_INTERACTIVE=0
ASSUME_YES="${ASSUME_YES:-0}"
OPENBAO_DOMAIN="${OPENBAO_DOMAIN:-}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
SSH_PORT="${SSH_PORT:-}"
OPENBAO_KEY_NAME="${OPENBAO_KEY_NAME:-$OPENBAO_KEY_NAME_DEFAULT}"
OPENBAO_QUOTA_RATE="${OPENBAO_QUOTA_RATE:-$OPENBAO_QUOTA_RATE_DEFAULT}"
SKIP_DNS_CHECK="${SKIP_DNS_CHECK:-0}"   # escape hatch for grey-cloud edge cases (still warns)
OS_ID=""                                # set by preflight from /etc/os-release
OS_CODENAME=""                          # set by preflight from /etc/os-release

# run: execute (or, in dry-run, just print) a command. Use for every state change.
# NOTE: never pass secrets through here — secret-handling code runs commands
# directly and captures their output into shell variables (see init/unseal).
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s[dry-run]%s %s\n' "$C_YLW" "$C_RST" "$*"
    return 0
  fi
  "$@"
}

usage() {
  cat <<EOF
${SCRIPT_NAME} — install + harden OpenBao as a KMS for a Cloudflare-Workers MCP.

USAGE:
  sudo ./scripts/${SCRIPT_NAME} [--dry-run] [--non-interactive] [--yes] [-h|--help]

OPTIONS:
  --dry-run           Print every action without changing anything. Safe anywhere.
  --non-interactive   Do not prompt; read all params from env vars (CI / repeat runs).
  --yes               Auto-confirm the destructive gate (implied by --non-interactive
                      only when ASSUME_YES=1). Use with care.
  -h, --help          Show this help.

ENV VARS (required in --non-interactive; optional defaults in interactive mode):
  OPENBAO_DOMAIN      FQDN that resolves (A/AAAA) to THIS host, e.g. bao.example.com
  LETSENCRYPT_EMAIL   Email for Let's Encrypt / ACME registration + expiry notices
  SSH_PORT            SSH port to keep open + rate-limit (default: detected, else 22)
  OPENBAO_KEY_NAME    Transit KEK name (default: ${OPENBAO_KEY_NAME_DEFAULT})
  OPENBAO_QUOTA_RATE  Requests/sec rate-limit on the transit path (default: ${OPENBAO_QUOTA_RATE_DEFAULT})
  ASSUME_YES=1        Skip the interactive destructive-change confirmation
  SKIP_DNS_CHECK=1    Skip the "domain resolves to this host" check (still warns)

This script is LOCKOUT-SAFE and IDEMPOTENT but it mutates firewall/SSH/packages.
TEST ON A DISPOSABLE VPS FIRST. Read scripts/README-openbao.md.
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run)          DRY_RUN=1; shift ;;
      --non-interactive)  NON_INTERACTIVE=1; shift ;;
      --yes|-y)           ASSUME_YES=1; shift ;;
      -h|--help)          usage; exit 0 ;;
      *)                  usage; die "Unknown option: $1" 1 ;;
    esac
  done
}

# ----------------------------------------------------------------------------
# Validation helpers (used by both the prompts and the non-interactive path)
# ----------------------------------------------------------------------------
is_valid_domain() {
  # RFC-1123-ish hostname: labels of [a-z0-9-], dots between, TLD >= 2 alpha.
  printf '%s' "$1" | grep -Eq '^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'
}

is_valid_email() {
  printf '%s' "$1" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
}

is_valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) [ "$1" -ge 1 ] && [ "$1" -le 65535 ] ;;
  esac
}

# prompt_value <prompt> <default> <validator-fn> -> echoes the accepted value.
# Re-prompts until valid. In --non-interactive mode it never prompts: it accepts
# the (pre-set) default if valid, else HALTS (a missing required param is a guard,
# not something to guess).
prompt_value() {
  local label="$1" default="$2" validator="$3" value=""
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    value="$default"
    if [ -z "$value" ] || ! "$validator" "$value"; then
      die "Non-interactive mode: '$label' is missing or invalid (got: '${value:-<empty>}'). Set the matching env var." 1
    fi
    printf '%s' "$value"
    return 0
  fi
  while true; do
    if [ -n "$default" ]; then
      read -rp "$label [$default]: " value || die "Input aborted." 1
      value="${value:-$default}"
    else
      read -rp "$label: " value || die "Input aborted." 1
    fi
    if "$validator" "$value"; then
      printf '%s' "$value"
      return 0
    fi
    warn "Invalid value: '$value'. Try again."
  done
}

# confirm <question> -> 0 if yes. Honours ASSUME_YES / --non-interactive.
confirm() {
  local q="$1" ans=""
  if [ "$ASSUME_YES" -eq 1 ]; then
    log "Auto-confirming (ASSUME_YES=1): $q"
    return 0
  fi
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    die "Non-interactive mode requires ASSUME_YES=1 to confirm: $q" 1
  fi
  read -rp "$q [type 'yes' to proceed]: " ans || return 1
  [ "$ans" = "yes" ]
}

# ----------------------------------------------------------------------------
# Small utilities
# ----------------------------------------------------------------------------
need_cmd() { command -v "$1" >/dev/null 2>&1; }

# write_file <path> <content> [mode]
# Idempotent + atomic: only writes if content differs (so re-runs are quiet and
# don't churn mtimes), writes via a temp file + mv, and honours --dry-run.
# NEVER use this for secrets — it lands on disk by definition.
write_file() {
  local path="$1" content="$2" mode="${3:-0644}"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s[dry-run]%s would write %s (mode %s, %d bytes)\n' \
      "$C_YLW" "$C_RST" "$path" "$mode" "${#content}"
    return 0
  fi
  if [ -f "$path" ] && printf '%s' "$content" | cmp -s - "$path"; then
    log "Unchanged: $path"
    return 0
  fi
  local dir tmp
  dir="$(dirname "$path")"
  mkdir -p "$dir" || die "Cannot create directory $dir" 3
  tmp="$(mktemp "${path}.XXXXXX")" || die "Cannot create temp file near $path" 3
  printf '%s' "$content" > "$tmp" || { rm -f "$tmp"; die "Write to $tmp failed" 3; }
  chmod "$mode" "$tmp" || { rm -f "$tmp"; die "chmod $mode $tmp failed" 3; }
  mv -f "$tmp" "$path" || { rm -f "$tmp"; die "Atomic move into $path failed" 3; }
  ok "Wrote: $path"
}

# This host's public IPv4, best-effort (used only to compare against DNS — we never
# rely on it for security). Tries a couple of resolvers; empty if all fail.
detect_public_ipv4() {
  local ip=""
  if need_cmd curl; then
    ip="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
    [ -z "$ip" ] && ip="$(curl -fsS --max-time 8 https://ifconfig.me/ip 2>/dev/null || true)"
  fi
  printf '%s' "$ip"
}

# Resolve a hostname's A records to a newline list (getent first, then host/dig).
resolve_a_records() {
  local host="$1" out=""
  if need_cmd getent; then
    out="$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  fi
  if [ -z "$out" ] && need_cmd dig; then
    out="$(dig +short A "$host" 2>/dev/null | grep -E '^[0-9.]+$' | sort -u || true)"
  fi
  if [ -z "$out" ] && need_cmd host; then
    out="$(host -t A "$host" 2>/dev/null | awk '/has address/{print $NF}' | sort -u || true)"
  fi
  printf '%s' "$out"
}

# ----------------------------------------------------------------------------
# LOCKOUT-SAFETY PRIMITIVES
# ----------------------------------------------------------------------------
# These run before sudo re-exec is assumed-clean: $SSH_CONNECTION is only present
# in the original SSH session's environment. sudo strips it unless invoked with -E,
# so we read it as early as possible and stash the result.
#
# $SSH_CONNECTION = "<client-ip> <client-port> <server-ip> <server-port>"
SSH_DETECTED_PORT=""
SSH_CLIENT_IP=""

detect_ssh_session() {
  if [ -n "${SSH_CONNECTION:-}" ]; then
    # shellcheck disable=SC2086  # deliberate word-split of the 4-field string
    set -- $SSH_CONNECTION
    SSH_CLIENT_IP="${1:-}"
    SSH_DETECTED_PORT="${4:-}"
  fi
  # Fallback: ask the kernel which port sshd is actually listening on.
  if [ -z "$SSH_DETECTED_PORT" ] && need_cmd ss; then
    SSH_DETECTED_PORT="$(ss -tnlpH 2>/dev/null \
      | awk '/sshd/{n=split($4,a,":"); print a[n]}' \
      | grep -E '^[0-9]+$' | sort -u | head -n1 || true)"
  fi
  if [ -n "$SSH_DETECTED_PORT" ]; then
    log "Detected active SSH on port ${SSH_DETECTED_PORT}${SSH_CLIENT_IP:+ from ${SSH_CLIENT_IP}}."
  else
    warn "Could not detect the active SSH port (not in an SSH session?). Will use the configured SSH_PORT."
  fi
}

# Returns 0 if a NON-root user has a non-empty authorized_keys with at least one
# plausible key line. This gates disabling SSH password auth (the lockout rule).
has_nonroot_authorized_key() {
  local base d akf
  for base in /home/*; do
    [ -d "$base" ] || continue
    d="$base/.ssh"
    akf="$d/authorized_keys"
    [ -f "$akf" ] || continue
    if grep -Eq '^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-(ssh|ecdsa))' "$akf" 2>/dev/null; then
      printf '%s' "$akf"
      return 0
    fi
  done
  return 1
}

# ============================================================================
# STEP 0 — Parameter gathering + the destructive-change gate
# ============================================================================
gather_params() {
  step "Parameters"
  detect_ssh_session

  OPENBAO_DOMAIN="$(prompt_value "OpenBao domain (FQDN, resolves to this host)" "$OPENBAO_DOMAIN" is_valid_domain)"
  LETSENCRYPT_EMAIL="$(prompt_value "Let's Encrypt / ACME email" "$LETSENCRYPT_EMAIL" is_valid_email)"

  # SSH port default precedence: explicit env/arg > detected live port > 22.
  local ssh_default="${SSH_PORT:-${SSH_DETECTED_PORT:-22}}"
  SSH_PORT="$(prompt_value "SSH port to keep open (rate-limited)" "$ssh_default" is_valid_port)"

  # HALT-not-guess: if we KNOW the live SSH port and the operator chose a different
  # one, that is almost certainly a mistake that would lock them out. Make them say so.
  if [ -n "$SSH_DETECTED_PORT" ] && [ "$SSH_PORT" != "$SSH_DETECTED_PORT" ]; then
    warn "You chose SSH port ${SSH_PORT}, but this live session is on ${SSH_DETECTED_PORT}."
    warn "If sshd is not actually listening on ${SSH_PORT}, enabling the firewall will LOCK YOU OUT."
    if ! confirm "Proceed with SSH port ${SSH_PORT} anyway?"; then
      die "Aborted on SSH-port mismatch. Re-run with the correct port." 2
    fi
  fi

  OPENBAO_KEY_NAME="$(prompt_value "Transit KEK name" "$OPENBAO_KEY_NAME" is_valid_domain_label)"

  cat <<EOF

${C_BLD}Review:${C_RST}
  OpenBao domain    : ${OPENBAO_DOMAIN}
  ACME email        : ${LETSENCRYPT_EMAIL}
  SSH port (keep)   : ${SSH_PORT}${SSH_DETECTED_PORT:+  (live: ${SSH_DETECTED_PORT})}
  Transit KEK name  : ${OPENBAO_KEY_NAME}
  Transit rate-limit: ${OPENBAO_QUOTA_RATE} req/s
  Stack dir         : ${STACK_DIR}
  OpenBao image     : ${OPENBAO_IMAGE}
  Mode              : $( [ "$DRY_RUN" -eq 1 ] && echo 'DRY-RUN (no changes)' || echo 'APPLY (mutates this host)' )

EOF

  if [ "$DRY_RUN" -eq 0 ]; then
    warn "This will modify the firewall, SSH config, sysctl, and install packages on THIS host."
    if ! confirm "Proceed with these destructive changes?"; then
      die "Aborted by operator." 0
    fi
  fi
}

# Transit key names are path segments; keep them to a safe charset.
is_valid_domain_label() {
  printf '%s' "$1" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$'
}

# ============================================================================
# STEP 1 — Pre-flight checks (require root, confirm OS, DNS, ports free)
# ============================================================================
preflight() {
  step "Pre-flight checks"

  # --- root / sudo ---
  if [ "$(id -u)" -ne 0 ]; then
    die "Must run as root (use: sudo ./scripts/${SCRIPT_NAME}). Refusing to continue." 1
  fi
  ok "Running as root."

  # --- OS is Ubuntu/Debian --- (capture facts into globals for later reuse)
  if [ ! -r /etc/os-release ]; then
    die "/etc/os-release not found — cannot confirm this is Ubuntu/Debian. Halting." 1
  fi
  # shellcheck disable=SC1091  # runtime file, not statically analysable
  . /etc/os-release
  OS_ID="${ID:-}"
  OS_CODENAME="${VERSION_CODENAME:-}"
  case "${ID:-}:${ID_LIKE:-}" in
    ubuntu:*|debian:*|*:*debian*|*:*ubuntu*) ok "OS: ${PRETTY_NAME:-${ID:-unknown}}." ;;
    *) die "Unsupported OS '${PRETTY_NAME:-${ID:-unknown}}'. This script targets Ubuntu/Debian only." 1 ;;
  esac

  # --- DNS: domain must resolve to this host's public IP (warn + guidance if not) ---
  if [ "$SKIP_DNS_CHECK" -eq 1 ]; then
    warn "SKIP_DNS_CHECK=1 — skipping the DNS-resolves-to-this-host check."
  else
    local pub_ip records
    pub_ip="$(detect_public_ipv4)"
    records="$(resolve_a_records "$OPENBAO_DOMAIN")"
    if [ -z "$pub_ip" ]; then
      warn "Could not determine this host's public IPv4 (outbound blocked?). Skipping strict DNS match."
    elif [ -z "$records" ]; then
      warn "Domain ${OPENBAO_DOMAIN} does not resolve to any A record yet."
      print_dns_guidance "$pub_ip"
      if ! confirm "Continue without DNS resolving (Let's Encrypt issuance WILL fail until it does)?"; then
        die "Aborted: fix DNS first, then re-run. (See the A-record guidance above.)" 2
      fi
    elif printf '%s\n' "$records" | grep -qx "$pub_ip"; then
      ok "DNS OK: ${OPENBAO_DOMAIN} -> ${pub_ip}."
    else
      warn "DNS MISMATCH: ${OPENBAO_DOMAIN} resolves to [$(printf '%s' "$records" | tr '\n' ' ')] but this host is ${pub_ip}."
      warn "If the record points at Cloudflare (orange-cloud proxy), Let's Encrypt HTTP-01 from this box will fail."
      print_dns_guidance "$pub_ip"
      if ! confirm "Continue despite the DNS mismatch?"; then
        die "Aborted on DNS mismatch. Point the A record at this host (DNS-only / grey cloud) and re-run." 2
      fi
    fi
  fi

  # --- ports 80/443 must be free (so Caddy can bind them) ---
  preflight_port_free 80
  preflight_port_free 443

  ok "Pre-flight complete."
}

print_dns_guidance() {
  local pub_ip="$1"
  cat >&2 <<EOF
${C_YLW}
  ── DNS pointing guidance ─────────────────────────────────────────────
  This script CANNOT edit your DNS registrar. Create this record yourself:

      Type:  A
      Name:  ${OPENBAO_DOMAIN}
      Value: ${pub_ip:-<this-host-public-IPv4>}
      Proxy: DNS only (grey cloud) — NOT proxied/orange.

  The record must be DNS-only because:
    * Let's Encrypt validates via HTTP-01 on port 80 directly to THIS host.
    * Cloudflare's orange-cloud proxy would resolve the name to Cloudflare's
      edge IPs, not this host, breaking that validation and the DNS check.
  Once the A record propagates (verify: 'dig +short A ${OPENBAO_DOMAIN}'), re-run.
  ──────────────────────────────────────────────────────────────────────${C_RST}
EOF
}

# A port is "free" if nothing is currently LISTENing on it. We do not count Docker
# yet (Caddy is what will bind these). HALT if occupied by something else.
preflight_port_free() {
  local port="$1" who=""
  if need_cmd ss; then
    who="$(ss -tnlpH "( sport = :$port )" 2>/dev/null | awk '{print $0}' | head -n3 || true)"
  fi
  if [ -n "$who" ]; then
    # If it's our own Caddy from a prior run, that's fine (idempotent re-run).
    if printf '%s' "$who" | grep -qi 'docker-proxy\|caddy'; then
      ok "Port ${port} already held by Caddy/Docker (prior run) — OK."
      return 0
    fi
    warn "Port ${port} is already in use by:"
    printf '%s\n' "$who" >&2
    die "Free port ${port} (stop the listener) before running. Caddy needs 80 (ACME) and 443 (HTTPS)." 2
  fi
  ok "Port ${port} is free."
}

# ============================================================================
# STEP 2 — Packages
# ============================================================================
install_packages() {
  step "Packages"

  log "apt-get update ..."
  run env DEBIAN_FRONTEND=noninteractive apt-get update -y \
    || die "apt-get update failed. Fix networking/apt sources and re-run." 3

  # Base tooling we always need.
  local base_pkgs="ufw fail2ban unattended-upgrades curl jq ca-certificates dnsutils"
  log "Installing base packages: ${base_pkgs}"
  # shellcheck disable=SC2086  # intentional word-split of the package list
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y $base_pkgs \
    || die "Failed to install base packages (${base_pkgs}). Halting." 3

  install_docker
  ok "Packages installed."
}

# Install Docker Engine + the compose plugin. Prefer the distro's docker.io for
# simplicity/idempotency; fall back to the official Docker repo if the compose
# plugin is unavailable. We HALT if we cannot end up with a working `docker compose`.
install_docker() {
  if need_cmd docker && docker compose version >/dev/null 2>&1; then
    ok "Docker + compose plugin already present ($(docker --version 2>/dev/null | head -n1))."
    return 0
  fi

  log "Installing Docker via distro packages (docker.io + docker-compose-plugin) ..."
  # shellcheck disable=SC2086
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 \
    || warn "Distro docker.io/docker-compose-v2 install hiccup — will verify the compose plugin next."

  if [ "$DRY_RUN" -eq 0 ] && ! docker compose version >/dev/null 2>&1; then
    warn "compose plugin not available from distro packages; adding the official Docker repository."
    install_docker_official
  fi

  run systemctl enable --now docker \
    || die "Could not enable/start the Docker service. Halting." 3

  if [ "$DRY_RUN" -eq 0 ] && ! docker compose version >/dev/null 2>&1; then
    die "Docker is installed but 'docker compose' still does not work. Halting (won't guess)." 3
  fi
  ok "Docker ready."
}

install_docker_official() {
  # Official Docker CE repo (covers compose-plugin) — only reached as a fallback.
  # OS facts were captured by preflight() (avoids re-sourcing /etc/os-release).
  run install -m 0755 -d /etc/apt/keyrings
  local codename="$OS_CODENAME" distro_id="${OS_ID:-ubuntu}"
  [ -n "$codename" ] || die "Cannot determine distro codename for the Docker repo. Halting." 3
  run bash -c "curl -fsSL https://download.docker.com/linux/${distro_id}/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg" \
    || die "Failed to fetch the Docker GPG key. Halting." 3
  run chmod a+r /etc/apt/keyrings/docker.gpg
  run bash -c "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${distro_id} ${codename} stable\" \
      > /etc/apt/sources.list.d/docker.list" \
    || die "Failed to add the Docker apt source. Halting." 3
  run env DEBIAN_FRONTEND=noninteractive apt-get update -y \
    || die "apt-get update failed after adding the Docker repo. Halting." 3
  # shellcheck disable=SC2086
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y \
      docker-ce docker-ce-cli containerd.io docker-compose-plugin \
    || die "Failed to install Docker CE from the official repo. Halting." 3
}

# ============================================================================
# STEP 3 — OS hardening (firewall, fail2ban, auto-updates, sysctl, SSH)
# ============================================================================
harden_os() {
  step "OS hardening"
  harden_ufw          # MUST allow SSH (rate-limited) BEFORE enabling default-deny
  harden_fail2ban
  harden_unattended_upgrades
  harden_sysctl
  harden_sshd         # disables root login + (conditionally) password auth — lockout-safe
  ok "OS hardening complete."
}

# ---- UFW ----------------------------------------------------------------
# ORDER IS LOAD-BEARING. We add the SSH allow rule (rate-limited) FIRST, then 443
# (later narrowed to Cloudflare in step 5), then 80 for the ACME challenge, and
# ONLY THEN enable the firewall. We never run `ufw reset`.
harden_ufw() {
  log "Configuring UFW (lockout-safe ordering: SSH first, then enable)."

  # Default policy: deny incoming, allow outgoing. (Applied to config, not yet live
  # until `ufw enable`; SSH rule below is added before enable.)
  run ufw default deny incoming  || die "ufw default deny incoming failed." 3
  run ufw default allow outgoing || die "ufw default allow outgoing failed." 3

  # 1) SSH FIRST — rate-limited (UFW 'limit' = brute-force throttle: 6 hits/30s).
  run ufw limit "${SSH_PORT}/tcp" comment "openbao-ssh" \
    || die "Failed to add the SSH allow rule on port ${SSH_PORT}. REFUSING to enable UFW (lockout risk)." 2
  ok "UFW: SSH allowed + rate-limited on ${SSH_PORT}/tcp."

  # 1b) Belt-and-suspenders: also explicitly allow the CURRENT client IP to SSH,
  #     so even a wrong SSH_PORT guess can't fully strand this exact session.
  if [ -n "$SSH_CLIENT_IP" ]; then
    run ufw allow from "$SSH_CLIENT_IP" to any port "${SSH_PORT}" proto tcp comment "openbao-ssh-current" \
      || warn "Could not add the current-client SSH allow rule (continuing; generic SSH rule is in place)."
  fi

  # 2) HTTP for ACME (HTTP-01). World-open by design — Let's Encrypt validates from
  #    LE servers, not Cloudflare, so 80 cannot be CF-restricted.
  run ufw allow 80/tcp comment "openbao-acme-http01" \
    || die "Failed to allow port 80 (needed for Let's Encrypt HTTP-01). Halting." 3
  ok "UFW: port 80 allowed (ACME HTTP-01)."

  # 3) HTTPS (443) is deliberately NOT opened here. Step 5 is the SOLE owner of all
  #    443 rules and opens it ONLY for Cloudflare's IP ranges. This guarantees 443 is
  #    never world-open, even transiently or if step 5's CF fetch later fails (it
  #    halts instead of falling back to open). main() always runs step 5 before any
  #    init, so OpenBao is reachable via Cloudflare from the moment it's needed.
  log "UFW: 443 left closed here; step 5 opens it for Cloudflare CIDRs only."

  # 4) Enable LAST.
  if ufw status 2>/dev/null | grep -qi '^Status: active'; then
    ok "UFW already active — rules updated in place."
  else
    run ufw --force enable || die "Failed to enable UFW. Halting." 3
    ok "UFW enabled (default-deny incoming)."
  fi

  printf '%s\n' "${C_GRN}${C_BLD}  ✔ Firewall keeps SSH reachable: UFW allows ${SSH_PORT}/tcp (rate-limited)${SSH_CLIENT_IP:+ and your IP ${SSH_CLIENT_IP}}.${C_RST}"
  log "  (SSH *auth* hardening — root login / password auth — is decided later, gated on a non-root key.)"
}

# ---- fail2ban -----------------------------------------------------------
harden_fail2ban() {
  log "Configuring fail2ban (sshd jail on port ${SSH_PORT})."
  # Write a local jail that watches the ACTUAL SSH port (else it guards 22 while
  # you're elsewhere). systemd backend works on modern Ubuntu/Debian.
  local jail="/etc/fail2ban/jail.d/openbao-sshd.local"
  write_file "$jail" "$(cat <<EOF
# Managed by ${SCRIPT_NAME}. SSH brute-force protection on the real SSH port.
[sshd]
enabled  = true
port     = ${SSH_PORT}
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
)"
  run systemctl enable --now fail2ban || die "Failed to enable fail2ban. Halting." 3
  run systemctl restart fail2ban     || warn "fail2ban restart reported an issue; check 'systemctl status fail2ban'."
  ok "fail2ban active (sshd jail on ${SSH_PORT})."
}

# ---- unattended-upgrades ------------------------------------------------
harden_unattended_upgrades() {
  log "Enabling unattended-upgrades (security autoupdates)."
  # Write the toggle file directly — never dpkg-reconfigure (interactive).
  write_file "$UNATTENDED_CFG" "$(cat <<'EOF'
// Managed by openbao-setup.sh
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
EOF
)"
  run systemctl enable --now unattended-upgrades \
    || warn "Could not enable the unattended-upgrades unit (timer-driven on some distros — config is in place)."
  ok "unattended-upgrades enabled (security updates auto-applied)."
}

# ---- sysctl -------------------------------------------------------------
# IMPORTANT: do NOT set net.ipv4.ip_forward=0 — Docker requires forwarding for
# container networking. We keep to anti-spoof / anti-redirect / syncookie knobs.
harden_sysctl() {
  log "Applying sysctl hardening (Docker-safe)."
  write_file "$SYSCTL_DROPIN" "$(cat <<'EOF'
# Managed by openbao-setup.sh — conservative, Docker-compatible hardening.
# (Deliberately omits net.ipv4.ip_forward — Docker needs it = 1.)
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
kernel.randomize_va_space = 2
EOF
)"
  run sysctl --system >/dev/null 2>&1 \
    || warn "sysctl --system reported a warning (a key may be unavailable in this kernel). Config is in place."
  ok "sysctl hardening applied."
}

# ---- SSH hardening (LOCKOUT-SAFE) ---------------------------------------
# We use a drop-in (Ubuntu/Debian sshd already Includes /etc/ssh/sshd_config.d/*).
# We ALWAYS disable root login + force pubkey, but ONLY disable PasswordAuthentication
# when a NON-root user already has a usable authorized_keys file. We validate with
# `sshd -t` and HALT on failure, then `reload` (not restart) to avoid dropping the
# current connection.
harden_sshd() {
  log "Hardening SSH (drop-in: ${SSHD_DROPIN})."

  # LOCKOUT RULE: disabling BOTH password auth AND root login on a host where the
  # only way in is root-with-a-password (the default on most fresh VPSes) would
  # strand the operator. So we gate *both* on the same precondition: a NON-root user
  # already has a usable authorized_keys. If absent, we keep root login AND password
  # auth enabled and tell the operator how to finish hardening on a re-run.
  local harden_login="no" keyfile=""
  if keyfile="$(has_nonroot_authorized_key)"; then
    harden_login="yes"
    ok "Found a non-root SSH key (${keyfile}) — safe to disable root login + password auth."
  else
    warn "No non-root user has an authorized_keys with a valid key."
    warn "Leaving BOTH root SSH login AND password auth ENABLED to avoid locking you out."
    warn "  -> Create a non-root user and add your key, e.g.:"
    warn "       adduser deploy && usermod -aG sudo deploy"
    warn "       ssh-copy-id deploy@${OPENBAO_DOMAIN:-this-host}"
    warn "     then re-run this script to finish SSH hardening."
  fi

  local rootline pwline
  if [ "$harden_login" = "yes" ]; then
    rootline="PermitRootLogin no"
    pwline="PasswordAuthentication no"
  else
    rootline="# PermitRootLogin left enabled (no non-root key detected) — see warning above"
    pwline="# PasswordAuthentication left enabled (no non-root key detected) — see warning above"
  fi

  write_file "$SSHD_DROPIN" "$(cat <<EOF
# Managed by ${SCRIPT_NAME}. SSH hardening.
Port ${SSH_PORT}
${rootline}
${pwline}
PubkeyAuthentication yes
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
X11Forwarding no
MaxAuthTries 4
LoginGraceTime 30
EOF
)"

  # Validate BEFORE reloading. A broken config + restart = lockout.
  if [ "$DRY_RUN" -eq 0 ]; then
    if ! sshd -t 2>/tmp/sshd_test.err; then
      warn "sshd -t failed:"; cat /tmp/sshd_test.err >&2
      run rm -f "$SSHD_DROPIN"
      die "Invalid sshd config — drop-in removed, SSH left untouched. Halting (no lockout)." 2
    fi
  fi
  # reload, not restart: existing sessions survive even if something is off.
  run systemctl reload ssh 2>/dev/null \
    || run systemctl reload sshd 2>/dev/null \
    || warn "Could not reload the SSH service (config validated; reload manually if needed)."
  if [ "$harden_login" = "yes" ]; then
    ok "SSH hardened: root login disabled, password auth disabled (non-root key present)."
  else
    warn "SSH partially hardened: root login + password auth LEFT ENABLED (no non-root key). Re-run after adding one."
  fi
}

# ============================================================================
# STEP 4 — OpenBao + Caddy via Docker Compose
# ============================================================================
# Topology (this is the security boundary — see README):
#   - Caddy runs in network_mode: host  -> binds REAL host :80 + :443, which UFW
#     actually controls (Docker does NOT filter published bridge ports, so host-net
#     is the only way the CF allowlist in step 5 is effective).
#   - OpenBao runs on the default bridge but publishes ONLY to loopback
#     (127.0.0.1:8200) -> never exposed on the public interface; Caddy reaches it
#     via 127.0.0.1:8200 on the host.
#   - OpenBao serves plain HTTP internally (tls_disable=true); Caddy terminates TLS.
#   - Storage: integrated raft, disable_mlock=true (mlock+raft is discouraged and
#     IPC_LOCK can break raft), so we do NOT add cap_add: IPC_LOCK.
#   - Audit: file device to a persisted, UID-100-owned logs volume.
readonly OPENBAO_UID=100
readonly OPENBAO_GID=1000
readonly BAO_DATA_DIR="${STACK_DIR}/openbao/data"
readonly BAO_LOGS_DIR="${STACK_DIR}/openbao/logs"
readonly BAO_CONFIG_DIR="${STACK_DIR}/openbao/config"
readonly CADDY_DATA_DIR="${STACK_DIR}/caddy/data"
readonly CADDY_CONFIG_DIR="${STACK_DIR}/caddy/config"

deploy_stack() {
  step "OpenBao + Caddy (Docker Compose)"

  # Host directories for bind-mounts. OpenBao's data + logs MUST be owned by the
  # container's UID (100) or it cannot write storage/audit. We chown explicitly
  # rather than hope a named volume inherits the right owner (halts-not-guesses).
  run mkdir -p "$BAO_DATA_DIR" "$BAO_LOGS_DIR" "$BAO_CONFIG_DIR" "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR"
  run chown -R "${OPENBAO_UID}:${OPENBAO_GID}" "$BAO_DATA_DIR" "$BAO_LOGS_DIR" \
    || die "Could not chown OpenBao data/logs to ${OPENBAO_UID}:${OPENBAO_GID}. OpenBao would fail to write. Halting." 3
  # Config readable by the container user; not group/other writable (image may
  # enforce VAULT_ENABLE_FILE_PERMISSIONS_CHECK).
  run chown -R "${OPENBAO_UID}:${OPENBAO_GID}" "$BAO_CONFIG_DIR"

  write_openbao_config
  write_caddyfile
  write_compose

  local compose_file="${STACK_DIR}/docker-compose.yml"
  log "Pulling images + starting the stack ..."
  run docker compose -f "$compose_file" pull \
    || die "docker compose pull failed (check the image tag '${OPENBAO_IMAGE}' and connectivity). Halting." 3
  run docker compose -f "$compose_file" up -d \
    || die "docker compose up failed. Inspect 'docker compose -f ${compose_file} logs'. Halting." 3

  wait_for_openbao_listening
  ok "Stack is up (OpenBao on 127.0.0.1:8200, Caddy on host :80/:443)."
}

write_openbao_config() {
  # NOTE: api_addr/cluster_addr use 127.0.0.1 because this is a single node reached
  # only via the host loopback by Caddy. listener binds 0.0.0.0:8200 INSIDE the
  # container, but compose only publishes that to 127.0.0.1 on the host.
  write_file "${BAO_CONFIG_DIR}/openbao.hcl" "$(cat <<EOF
# Managed by ${SCRIPT_NAME}. OpenBao server config (NOT dev mode).
ui = true

# Integrated raft storage. disable_mlock=true is the documented-safe setting with
# raft (enabling mlock/IPC_LOCK is discouraged and can break raft).
disable_mlock = true

storage "raft" {
  path    = "/openbao/data"
  node_id = "openbao-mcp-1"
}

# Plain HTTP on the internal listener; Caddy terminates TLS. Published to the host
# loopback only (see docker-compose.yml) so this is never on the public interface.
#
# We deliberately do NOT set x_forwarded_for_authorized_addrs: OpenBao runs on the
# docker bridge, so the source IP it sees for Caddy's proxied connection is the
# bridge GATEWAY (e.g. 172.17.0.1), not 127.0.0.1. Setting authorized_addrs would
# activate x_forwarded_for_reject_not_authorized (default true) with a value that
# can't match -> 400 on every request. The cost of omitting it: the audit log's
# remote_address shows the gateway, not the real client. That is acceptable given
# the loopback-only trust boundary. (For accurate client IPs, use the Cloudflare
# Tunnel upgrade in the README, not XFF.)
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"
EOF
)" 0640
  run chown "${OPENBAO_UID}:${OPENBAO_GID}" "${BAO_CONFIG_DIR}/openbao.hcl"
}

write_caddyfile() {
  # Caddy obtains a Let's Encrypt cert for the domain and reverse-proxies to OpenBao
  # on the host loopback. We FORCE the HTTP-01 challenge (disable_tlsalpn_challenge)
  # because port 443 is locked to Cloudflare in step 5, which would break TLS-ALPN-01
  # (LE validates from LE servers, not Cloudflare). HTTP-01 uses port 80 (world-open).
  write_file "${STACK_DIR}/Caddyfile" "$(cat <<EOF
# Managed by ${SCRIPT_NAME}.
{
	email ${LETSENCRYPT_EMAIL}
}

${OPENBAO_DOMAIN} {
	encode gzip
	reverse_proxy 127.0.0.1:8200

	tls {
		# Port 443 is Cloudflare-only (step 5) -> TLS-ALPN-01 cannot work; force HTTP-01.
		issuer acme {
			disable_tlsalpn_challenge
		}
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		-Server
	}
}
EOF
)"
}

write_compose() {
  write_file "${STACK_DIR}/docker-compose.yml" "$(cat <<EOF
# Managed by ${SCRIPT_NAME}. Do not run OpenBao in -dev mode.
services:
  openbao:
    image: ${OPENBAO_IMAGE}
    container_name: openbao
    restart: unless-stopped
    command: ["server", "-config=/openbao/config/openbao.hcl"]
    # Publish ONLY to the host loopback. NEVER "8200:8200" (that bypasses UFW and
    # exposes the KMS publicly). Caddy reaches OpenBao via 127.0.0.1:8200 on the host.
    ports:
      - "127.0.0.1:8200:8200"
    volumes:
      - ${BAO_DATA_DIR}:/openbao/data
      - ${BAO_LOGS_DIR}:/openbao/logs
      - ${BAO_CONFIG_DIR}:/openbao/config:ro
    # Raft + disable_mlock => zero Linux caps required (port 8200 > 1024 so no
    # NET_BIND_SERVICE; writes to bind-mounts it owns as uid 100; image USER is
    # already 'openbao' so no root->user privilege drop). cap_drop: ALL is the
    # logical completion of disable_mlock. If OpenBao ever fails to start, the
    # command 'docker logs openbao' names the cause — add back ONLY the cap it
    # names (or remove this cap_drop); do not pre-guess the set. Validate on VPS.
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      # 'bao status' exits 0 unsealed, 2 sealed, 1 error. Treat sealed (2) as healthy
      # for compose purposes (the script unseals after init).
      test: ["CMD-SHELL", "bao status >/dev/null 2>&1 || [ \$? -eq 2 ]"]
      interval: 15s
      timeout: 5s
      retries: 5
    environment:
      BAO_ADDR: "http://127.0.0.1:8200"

  caddy:
    image: ${CADDY_IMAGE}
    container_name: openbao-caddy
    restart: unless-stopped
    # host networking: Caddy binds the REAL host :80 and :443 so UFW controls them.
    network_mode: host
    volumes:
      - ${STACK_DIR}/Caddyfile:/etc/caddy/Caddyfile:ro
      - ${CADDY_DATA_DIR}:/data
      - ${CADDY_CONFIG_DIR}:/config
    cap_add:
      # Needed to bind :80/:443 as non-root inside the Caddy image.
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true
    depends_on:
      - openbao
EOF
)"
}

# Wait until OpenBao answers on the host loopback (sys/health). HALT after a bounded
# wait so we never hang forever or proceed against a dead container.
wait_for_openbao_listening() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would wait for OpenBao on 127.0.0.1:8200"
    return 0
  fi
  log "Waiting for OpenBao to answer on 127.0.0.1:8200 ..."
  local i
  for i in $(seq 1 30); do
    # 501 = not initialised, 503 = sealed, 200 = ok — ANY of these means it's up.
    if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:8200/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200" 2>/dev/null \
       || curl -s -o /dev/null --max-time 3 "http://127.0.0.1:8200/v1/sys/seal-status" 2>/dev/null; then
      ok "OpenBao is answering."
      return 0
    fi
    sleep 2
  done
  warn "OpenBao did not answer in time. Last 40 log lines:"
  docker logs --tail 40 openbao 2>&1 >&2 || true
  die "OpenBao is not reachable on 127.0.0.1:8200. Halting (won't init against a dead server)." 3
}

# ============================================================================
# STEP 5 — Lock 443 down to Cloudflare's published IP ranges
# ============================================================================
# RATIONALE + HONEST LIMIT: the Worker's egress originates from Cloudflare, so we
# restrict 443 ingress to Cloudflare's ranges as a coarse anti-scan / anti-DDoS
# baseline. This is NOT authentication — those ranges are shared by ALL Cloudflare
# customers, and Worker egress is not guaranteed to fall in the published CDN ranges.
# The REAL auth boundary is the AppRole the Worker presents. The README documents the
# strictly-stronger Cloudflare Tunnel + Access service-token upgrade.
restrict_443_to_cloudflare() {
  step "Restrict 443 to Cloudflare IP ranges"

  local v4 v6
  v4="$(fetch_cf_ranges "$CF_IPV4_URL")"
  v6="$(fetch_cf_ranges "$CF_IPV6_URL")"

  # HALT-not-guess: if we cannot fetch the lists, do NOT leave 443 world-open and do
  # NOT invent a cached list. Stop loudly and tell the operator.
  if [ -z "$v4" ]; then
    die "Could not fetch ${CF_IPV4_URL}. REFUSING to leave 443 open. Fix connectivity and re-run step 5." 3
  fi
  [ -z "$v6" ] && warn "Could not fetch IPv6 ranges (${CF_IPV6_URL}); applying IPv4-only allowlist."

  # Reconcile idempotently: delete every previously-tagged CF rule, then re-add the
  # current set. This prevents rule accumulation across re-runs.
  delete_tagged_ufw_rules "$UFW_CF_COMMENT"
  # Defensive: also remove any stray world-open 443 rule a PRIOR version of this
  # script may have created, so the FINAL state is strictly Cloudflare-only.
  delete_tagged_ufw_rules "openbao-https-temp"

  local cidr count=0
  while IFS= read -r cidr; do
    [ -z "$cidr" ] && continue
    run ufw allow from "$cidr" to any port 443 proto tcp comment "$UFW_CF_COMMENT" \
      || die "Failed to add UFW allow for ${cidr}:443. Halting (partial allowlist is unsafe)." 3
    count=$((count + 1))
  done <<EOF
$v4
$v6
EOF

  run ufw reload || warn "ufw reload reported an issue; rules are added (check 'ufw status')."
  ok "443 restricted to ${count} Cloudflare CIDR(s). World access to 443 is now denied."
  warn "Reminder: this is a coarse filter, NOT authentication. The AppRole token is the real boundary."
}

# Fetch + sanity-validate a Cloudflare range list. Returns only well-formed CIDRs.
fetch_cf_ranges() {
  local url="$1" body
  body="$(curl -fsS --max-time 15 "$url" 2>/dev/null || true)"
  [ -z "$body" ] && { printf ''; return 0; }
  # Keep only plausible IPv4/IPv6 CIDR lines (defensive: don't feed junk to ufw).
  printf '%s\n' "$body" | grep -E '^[0-9a-fA-F:.]+/[0-9]+$' || true
}

# Delete all UFW rules carrying a given comment tag. UFW has no "delete by comment",
# so we resolve rule NUMBERS from numbered status and delete high-to-low (numbers
# shift as you delete). Safe + idempotent.
delete_tagged_ufw_rules() {
  local tag="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s[dry-run]%s would delete any UFW rules tagged "%s"\n' "$C_YLW" "$C_RST" "$tag"
    return 0
  fi
  local nums
  nums="$(ufw status numbered 2>/dev/null \
    | grep -F "# ${tag}" \
    | sed -E 's/^\[[[:space:]]*([0-9]+)\].*/\1/' \
    | sort -rn || true)"
  local n
  for n in $nums; do
    yes | ufw delete "$n" >/dev/null 2>&1 || warn "Could not delete UFW rule #${n} (tag ${tag})."
  done
  [ -n "$nums" ] && log "Removed prior UFW rules tagged '${tag}'."
  return 0
}

# ============================================================================
# STEP 6 — Initialise + unseal OpenBao  (SECRET HANDLING — read carefully)
# ============================================================================
# RULES enforced here:
#   * NO `set -x` anywhere in this section (it would echo unseal keys to logs).
#   * `operator init -format=json` output is captured into a SHELL VARIABLE and
#     parsed with jq. It is NEVER written to a file by this script.
#   * Unseal keys + root token are shown ONCE on the terminal, then the variables
#     are unset. Operator stores them OFF this box (password manager).
#   * `operator init` is NOT idempotent: if already initialised we SKIP it (you can
#     never recover the original keys), and if sealed we tell the operator to unseal
#     manually with their stored keys rather than guess.
#
# These globals hold secrets transiently and are unset at the end of this step.
ROOT_TOKEN=""        # used by step 7, then revoked-advice given
WORKER_ROLE_ID=""    # printed in step 8 (not itself a secret without the secret-id)
WORKER_SECRET_ID=""  # printed once in step 8

# bao_exec <args...> : run the bao CLI inside the openbao container. Optionally
# authenticated by exporting BAO_TOKEN via the caller's environment of THIS function
# (we pass -e BAO_TOKEN explicitly only when ROOT_TOKEN is set).
# NOTE: `-i` is REQUIRED so that callers piping data in (e.g. `policy write NAME -`
# reading HCL from stdin) actually reach the container's stdin. Without -i, docker
# does not forward the pipe and `policy write -` would silently write an EMPTY
# policy. -i is harmless for the non-stdin calls (no TTY is allocated). No -t (we
# never want a TTY in non-interactive/CI contexts).
bao_exec() {
  if [ -n "${ROOT_TOKEN:-}" ]; then
    docker exec -i -e "BAO_ADDR=http://127.0.0.1:8200" -e "BAO_TOKEN=${ROOT_TOKEN}" openbao bao "$@"
  else
    docker exec -i -e "BAO_ADDR=http://127.0.0.1:8200" openbao bao "$@"
  fi
}

# Seal status helpers (parse JSON; tolerate non-zero exit on sealed/uninit).
bao_initialized() {
  docker exec -e "BAO_ADDR=http://127.0.0.1:8200" openbao \
    bao status -format=json 2>/dev/null | jq -re '.initialized == true' >/dev/null 2>&1
}
bao_sealed() {
  docker exec -e "BAO_ADDR=http://127.0.0.1:8200" openbao \
    bao status -format=json 2>/dev/null | jq -re '.sealed == true' >/dev/null 2>&1
}

initialize_openbao() {
  step "Initialise + unseal OpenBao"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would: operator init (5 shares / threshold 3), capture keys in memory, unseal, show once."
    return 0
  fi

  if bao_initialized; then
    ok "OpenBao is already initialised (skipping init — original keys cannot be recovered)."
    if bao_sealed; then
      warn "OpenBao is SEALED. This script will NOT guess unseal keys."
      warn "Unseal manually with the keys you saved at first init:"
      warn "    docker exec -it openbao bao operator unseal   (run 3 times with 3 different keys)"
      die "Cannot proceed past a sealed, already-initialised OpenBao without your stored keys." 2
    fi
    # Already initialised AND unsealed: we have no root token. The operator must
    # supply one for step 7. Prompt for it (not stored, not echoed by us).
    if [ -z "${ROOT_TOKEN:-}" ]; then
      if [ "$NON_INTERACTIVE" -eq 1 ]; then
        ROOT_TOKEN="${BAO_ROOT_TOKEN:-}"
        [ -n "$ROOT_TOKEN" ] || die "Already-initialised + non-interactive: set BAO_ROOT_TOKEN to run transit setup. Halting." 2
      else
        warn "OpenBao is initialised + unsealed but this script holds no root token."
        read -rsp "Paste a root (or sufficiently-privileged) token to continue transit setup: " ROOT_TOKEN || true
        printf '\n'
        [ -n "$ROOT_TOKEN" ] || die "No token provided. Halting." 2
      fi
    fi
    return 0
  fi

  # --- First-time init. Capture JSON in memory ONLY. ---
  log "Running operator init (5 key shares, threshold 3) ..."
  local init_json
  init_json="$(docker exec -e "BAO_ADDR=http://127.0.0.1:8200" openbao \
      bao operator init -key-shares=5 -key-threshold=3 -format=json 2>/dev/null)" \
    || die "operator init failed. Inspect 'docker logs openbao'. Halting." 3
  [ -n "$init_json" ] || die "operator init produced no output. Halting (won't guess)." 3

  # Parse keys + root token from the in-memory JSON.
  local -a unseal_keys=()
  mapfile -t unseal_keys < <(printf '%s' "$init_json" | jq -r '.unseal_keys_b64[]')
  ROOT_TOKEN="$(printf '%s' "$init_json" | jq -r '.root_token')"
  [ "${#unseal_keys[@]}" -ge 3 ] || die "Expected >=3 unseal keys, got ${#unseal_keys[@]}. Halting." 3
  if [ -z "$ROOT_TOKEN" ] || [ "$ROOT_TOKEN" = "null" ]; then
    die "No root token in init output. Halting." 3
  fi

  # Unseal using threshold (3) keys, from memory.
  log "Unsealing (threshold 3) ..."
  local k
  for k in "${unseal_keys[0]}" "${unseal_keys[1]}" "${unseal_keys[2]}"; do
    docker exec -e "BAO_ADDR=http://127.0.0.1:8200" openbao \
      bao operator unseal "$k" >/dev/null 2>&1 \
      || die "Unseal step failed. Halting." 3
  done
  if bao_sealed; then
    die "OpenBao is still sealed after applying 3 keys. Halting." 3
  fi
  ok "OpenBao unsealed."

  # --- Show secrets ONCE. This is the only time they are visible. ---
  show_init_secrets_once unseal_keys[@]

  # Scrub the local copy of the JSON (best-effort; bash has no secure-wipe).
  init_json=""
  unset init_json
}

# Prints the unseal keys + root token exactly once, with storage instructions.
# Takes the unseal-keys array by name-reference (bash 4.3+).
show_init_secrets_once() {
  local -a keys=( "${!1}" )
  cat <<EOF

${C_RED}${C_BLD}================ STORE THESE NOW — SHOWN ONCE, NOT SAVED TO DISK ================${C_RST}
${C_YLW}These are the ROOT OF TRUST for your KMS. This script does NOT persist them.
Copy them into a password manager OFF this server. Anyone with the threshold (3)
unseal keys + storage can decrypt everything; anyone with the root token controls
OpenBao. Lose all unseal keys and the data is unrecoverable.${C_RST}

  Root token: ${ROOT_TOKEN}

EOF
  local i=1 key
  for key in "${keys[@]}"; do
    printf '  Unseal key %d: %s\n' "$i" "$key"
    i=$((i + 1))
  done
  cat <<EOF

${C_YLW}Threshold to unseal = 3 of ${#keys[@]}. Distribute keys to separate custodians.
After setup, consider REVOKING the root token (the Worker uses an AppRole, not this
token); generate a fresh root only when needed via 'operator generate-root'.${C_RST}
${C_RED}${C_BLD}================================================================================${C_RST}

EOF
  if [ "$ASSUME_YES" -ne 1 ] && [ "$NON_INTERACTIVE" -ne 1 ]; then
    read -rp "Type 'stored' once you have saved these off-server: " _ack || true
    if [ "${_ack:-}" != "stored" ]; then
      warn "You did not confirm storage. The keys are above — do NOT lose them."
    fi
  fi
}

# ============================================================================
# STEP 7 — Transit engine + least-privilege policy + AppRole + quota + audit
# ============================================================================
# Every action is check-then-create so re-runs are idempotent. The Worker gets ONLY
# the ability to encrypt + decrypt with ONE key — no read of key material, no sys
# access, no datakey/rewrap/export.
configure_transit() {
  step "Transit engine, KEK, policy, AppRole, quota, audit"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would: enable audit(file) + transit; create non-exportable KEK '${OPENBAO_KEY_NAME}' (rotation on);"
    log "[dry-run]        write policy '${OPENBAO_POLICY_NAME}' (encrypt+decrypt only); enable approle; create role '${OPENBAO_APPROLE_NAME}';"
    log "[dry-run]        set rate-limit quota '${OPENBAO_QUOTA_NAME}' (${OPENBAO_QUOTA_RATE}/s) on transit/${OPENBAO_KEY_NAME}."
    return 0
  fi

  [ -n "${ROOT_TOKEN:-}" ] || die "No privileged token available for transit setup. Halting." 2

  # --- Audit device (file) -> persisted, UID-100-owned logs volume ---
  if bao_exec audit list -format=json 2>/dev/null | jq -e '."file/"' >/dev/null 2>&1; then
    ok "Audit device 'file/' already enabled."
  else
    bao_exec audit enable file file_path=/openbao/logs/openbao_audit.log \
      || die "Failed to enable the file audit device (is /openbao/logs writable by uid ${OPENBAO_UID}?). Halting." 3
    ok "Audit device enabled -> ${BAO_LOGS_DIR}/openbao_audit.log (host)."
  fi

  # --- Transit engine ---
  if bao_exec secrets list -format=json 2>/dev/null | jq -e '."transit/"' >/dev/null 2>&1; then
    ok "transit/ already enabled."
  else
    bao_exec secrets enable transit || die "Failed to enable the transit engine. Halting." 3
    ok "transit/ enabled."
  fi

  # --- KEK: non-exportable, rotation enabled ---
  # exportable=false is the DEFAULT and is what we want (the KEK must never leave
  # OpenBao). allow_plaintext_backup=false likewise. We set them explicitly for clarity.
  if bao_exec read -format=json "transit/keys/${OPENBAO_KEY_NAME}" >/dev/null 2>&1; then
    ok "Transit key '${OPENBAO_KEY_NAME}' already exists."
  else
    bao_exec write -f "transit/keys/${OPENBAO_KEY_NAME}" \
        type=aes256-gcm96 exportable=false allow_plaintext_backup=false \
      || die "Failed to create transit key '${OPENBAO_KEY_NAME}'. Halting." 3
    ok "Created non-exportable KEK '${OPENBAO_KEY_NAME}' (aes256-gcm96)."
  fi
  # Enable automatic rotation (90 days). Idempotent (re-setting config is harmless).
  bao_exec write "transit/keys/${OPENBAO_KEY_NAME}/config" \
      auto_rotate_period=2160h deletion_allowed=false \
    || warn "Could not set auto_rotate/deletion config on the key (continuing)."
  ok "KEK rotation: auto-rotate every 90 days; deletion disabled."

  write_transit_policy
  configure_approle
  configure_quota
  ok "Transit setup complete."
}

# Least-privilege policy. encrypt/decrypt are POST endpoints, so the capability is
# UPDATE — NOT read. No wildcards. No sys/*. No transit/keys read (would expose key
# metadata). No datakey/rewrap/export. This is the whole point of the design.
write_transit_policy() {
  local policy_hcl
  policy_hcl="$(cat <<EOF
# Least-privilege policy for the Cloudflare MCP Worker.
# encrypt + decrypt ONLY, on exactly one key. Nothing else.
path "transit/encrypt/${OPENBAO_KEY_NAME}" {
  capabilities = ["update"]
}
path "transit/decrypt/${OPENBAO_KEY_NAME}" {
  capabilities = ["update"]
}
EOF
)"
  # Write the policy from stdin so the HCL never lands in a host file or argv.
  if printf '%s' "$policy_hcl" | bao_exec policy write "$OPENBAO_POLICY_NAME" - ; then
    ok "Policy '${OPENBAO_POLICY_NAME}' written (encrypt+decrypt on '${OPENBAO_KEY_NAME}' only)."
  else
    die "Failed to write policy '${OPENBAO_POLICY_NAME}'. Halting." 3
  fi
}

# AppRole for the Worker (preferred over a static token: secret-id rotation).
# token_ttl/token_max_ttl keep Worker tokens short-lived; secret_id_ttl forces
# periodic secret-id rotation. The Worker re-authenticates (role-id + secret-id ->
# token) on expiry — that is the rotation story (documented in README).
configure_approle() {
  if bao_exec auth list -format=json 2>/dev/null | jq -e '."approle/"' >/dev/null 2>&1; then
    ok "approle auth already enabled."
  else
    bao_exec auth enable approle || die "Failed to enable approle auth. Halting." 3
    ok "approle auth enabled."
  fi

  # NOTE: we do NOT pass secret_id_bound_cidrs / token_bound_cidrs — OpenBao can
  # reject an empty-string CIDR as invalid, and "unbound" is the default anyway.
  # (To pin the Worker's source CIDRs later, set them to real Cloudflare ranges.)
  bao_exec write "auth/approle/role/${OPENBAO_APPROLE_NAME}" \
      token_policies="${OPENBAO_POLICY_NAME}" \
      token_ttl=20m token_max_ttl=1h \
      secret_id_ttl=720h secret_id_num_uses=0 token_num_uses=0 \
    || die "Failed to create/update AppRole '${OPENBAO_APPROLE_NAME}'. Halting." 3
  ok "AppRole '${OPENBAO_APPROLE_NAME}' bound to policy '${OPENBAO_POLICY_NAME}' (token TTL 20m/1h, secret-id TTL 30d)."

  # Fetch role-id (stable across runs) and mint a fresh secret-id (shown once in
  # step 8). NOTE: the role config above is an idempotent upsert, but each run
  # INTENTIONALLY issues a NEW secret-id (there is no check-then-create for a
  # secret you can't read back). Old secret-ids simply expire at their TTL; this is
  # the rotation path. If you only want to (re)configure without a new secret-id,
  # skip this script and run the role-config write by hand.
  WORKER_ROLE_ID="$(bao_exec read -format=json "auth/approle/role/${OPENBAO_APPROLE_NAME}/role-id" 2>/dev/null \
    | jq -r '.data.role_id')" || true
  if [ -z "$WORKER_ROLE_ID" ] || [ "$WORKER_ROLE_ID" = "null" ]; then
    die "Could not read AppRole role-id. Halting." 3
  fi
  WORKER_SECRET_ID="$(bao_exec write -f -format=json "auth/approle/role/${OPENBAO_APPROLE_NAME}/secret-id" 2>/dev/null \
    | jq -r '.data.secret_id')" || true
  if [ -z "$WORKER_SECRET_ID" ] || [ "$WORKER_SECRET_ID" = "null" ]; then
    die "Could not mint an AppRole secret-id. Halting." 3
  fi
}

# Rate-limit quota on the transit path so a compromised Worker can't bulk-unwrap.
# Applied at the path that covers encrypt+decrypt for this engine. Created by the
# privileged token here — NOT part of the Worker's policy.
configure_quota() {
  bao_exec write "sys/quotas/rate-limit/${OPENBAO_QUOTA_NAME}" \
      path="transit/" rate="${OPENBAO_QUOTA_RATE}" interval=1s \
    || die "Failed to set the transit rate-limit quota. Halting." 3
  ok "Rate-limit quota '${OPENBAO_QUOTA_NAME}': ${OPENBAO_QUOTA_RATE} req/s on the transit path."
}

# ============================================================================
# STEP 8 — Output: Worker config + security checklist
# ============================================================================
print_summary() {
  step "Done — Cloudflare Worker configuration + security checklist"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would print the OpenBao URL, AppRole role-id/secret-id, transit key, and next steps."
    return 0
  fi

  local approle_login_curl
  approle_login_curl="curl -s --request POST \\
       \"https://${OPENBAO_DOMAIN}/v1/auth/approle/login\" \\
       --data '{\"role_id\":\"${WORKER_ROLE_ID}\",\"secret_id\":\"<SECRET_ID>\"}'"

  cat <<EOF

${C_GRN}${C_BLD}OpenBao is installed, hardened, initialised, and serving the transit KMS.${C_RST}

${C_BLD}Endpoint${C_RST}
  OpenBao HTTPS URL : https://${OPENBAO_DOMAIN}
  Transit key (KEK) : ${OPENBAO_KEY_NAME}   (non-exportable, auto-rotate 90d)
  Worker policy     : ${OPENBAO_POLICY_NAME}   (encrypt + decrypt ONLY)
  Rate-limit quota  : ${OPENBAO_QUOTA_RATE} req/s on transit/

${C_BLD}Cloudflare Worker auth (AppRole — store the secret-id as a Worker secret NOW)${C_RST}
  BAO_ADDR          = https://${OPENBAO_DOMAIN}
  BAO_TRANSIT_KEY   = ${OPENBAO_KEY_NAME}
  BAO_ROLE_ID       = ${WORKER_ROLE_ID}
  ${C_YLW}BAO_SECRET_ID     = ${WORKER_SECRET_ID}   <-- shown ONCE; not saved by this script${C_RST}

  Set them on the Worker, e.g.:
    npx wrangler secret put BAO_SECRET_ID      # paste the value above
    npx wrangler secret put BAO_ROLE_ID
    # BAO_ADDR / BAO_TRANSIT_KEY can be plain vars in wrangler.toml [vars]

${C_BLD}Worker request flow (envelope decrypt)${C_RST}
  1) Exchange role-id + secret-id for a short-lived token:
       ${approle_login_curl}
     -> read .auth.client_token (TTL 20m). Cache + refresh on 403/expiry.
  2) Unwrap a per-user data key (the KEK never leaves OpenBao):
       curl -s --header "X-Vault-Token: <client_token>" \\
            --request POST "https://${OPENBAO_DOMAIN}/v1/transit/decrypt/${OPENBAO_KEY_NAME}" \\
            --data '{"ciphertext":"vault:v1:..."}'
     -> .data.plaintext is the base64 data key. Use it client-side; never log it.

${C_BLD}Security checklist (verify each)${C_RST}
  [ ] Unseal keys (3-of-5) + root token saved in a password manager OFF this box?
  [ ] Root token revoked after setup? (Worker uses the AppRole, not root.)
  [ ] Firewall verified: ${C_BLD}ufw status${C_RST} shows SSH (${SSH_PORT}) limited, 80 open,
      443 ${C_BLD}only from Cloudflare CIDRs${C_RST} (no global 443 allow)?
  [ ] You can still SSH in from a second session BEFORE you close this one?
  [ ] Audit log present + writable: ${BAO_LOGS_DIR}/openbao_audit.log ?
  [ ] On a disposable VPS test: did the Worker actually reach transit/decrypt
      THROUGH the Cloudflare allowlist? (Worker egress is not guaranteed to be in
      the published CDN ranges — see README; if blocked, use Cloudflare Tunnel.)
  [ ] Read scripts/README-openbao.md "Honest limits" + the Cloudflare Tunnel upgrade.

${C_YLW}Reminder: a compromise of THIS running box can reach the unsealed KEK. Keep it
minimal, dedicated, and patched. This is a software seal, not an HSM.${C_RST}

EOF

  # Scrub transient secrets from the environment of this process.
  ROOT_TOKEN=""; WORKER_SECRET_ID=""
  unset ROOT_TOKEN WORKER_SECRET_ID
}

# ============================================================================
# main
# ============================================================================
main() {
  parse_args "$@"

  printf '%s%s — OpenBao KMS installer/hardener%s\n' "$C_BLD" "$SCRIPT_NAME" "$C_RST"
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "DRY-RUN: no changes will be made. Remove --dry-run to apply."
  fi

  gather_params       # step 0: params + destructive gate
  preflight           # step 1
  install_packages    # step 2
  harden_os           # step 3  (lockout-safe firewall/SSH)
  deploy_stack        # step 4  (OpenBao + Caddy)
  restrict_443_to_cloudflare   # step 5
  initialize_openbao  # step 6  (secret handling)
  configure_transit   # step 7
  print_summary       # step 8
}

main "$@"
