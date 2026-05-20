#!/usr/bin/env bash
# standby-sync-postgres-wal.sh — pull WAL segments from primary into the
# standby's local archive directory.
#
# Runs as a frequent (~1 min) cron on the STANDBY HOST. Pulls every WAL file
# present in primary's archive that isn't already in standby's local archive.
# Postgres (inside the container) then reads from a bind-mounted copy of the
# local archive via a simple in-container `cp` restore_command.
#
# Why this layering: postgres runs in a docker container that does NOT have
# ssh or rsync installed, and even if it did, mounting standby's host SSH key
# into the container is unsafe (any future docker-cve or container escape
# would expose the key). Host-side pull + read-only bind mount keeps the
# container minimal and the SSH key isolated.
#
# This script is idempotent and resumable: rsync --partial + per-file
# timestamps mean a kill mid-sync just re-fetches the partial file next run.

set -uo pipefail

CONFIG="/etc/fula-standby/standby-config.sh"
# shellcheck source=/dev/null
. "$CONFIG"

# Single-instance via flock. Cron fires every minute; if one run takes longer
# (large backlog after standby reboot, slow network), subsequent runs would
# pile up, exhaust SSH sessions on primary, and trigger sshd's MaxStartups
# rate-limit — exactly when we most need WAL flowing. flock -n exits 0 when
# already held (next minute's tick will retry).
LOCK="/var/lock/fula-standby-wal-puller.lock"
exec 9>"$LOCK"
flock -n 9 || exit 0

# The host-side archive dir. Bind-mounted read-only into postgres at
# /var/lib/pg-archive (set up by recover.sh phase 8 in standby mode).
LOCAL_ARCHIVE="/var/lib/fula-pg-wal-archive"

mkdir -p "$LOCAL_ARCHIVE"

# rsync the entire archive directory. --ignore-existing lets us skip files
# we've already pulled (WAL files are immutable once archived). --partial
# allows resuming an interrupted pull. --remove-source-files would also be
# correct but is destructive against primary; we rely on primary's retention
# cron to delete old WAL.
exec rsync -t --partial --timeout=120 \
  --ignore-existing \
  -e "ssh $SSH_OPTS -o ConnectTimeout=10" \
  "$PRIMARY_USER@$PRIMARY_HOST:$PRIMARY_PG_ARCHIVE/" \
  "$LOCAL_ARCHIVE/"
