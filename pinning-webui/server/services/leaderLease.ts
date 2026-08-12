/**
 * Cron leader lease (FM-2, federated masters).
 *
 * With more than one master running pinning-webui against the SAME Postgres,
 * exactly one of them may run the cron family (blockScanner, deductionJob).
 * The lease is a Postgres session advisory lock held on a dedicated client:
 *  - pg_try_advisory_lock never blocks: the holder gets true, others false;
 *  - the lock is session-scoped, so if the holder crashes or loses its
 *    connection, Postgres frees it and another master acquires it on its
 *    next tick — automatic failover with no extra infrastructure;
 *  - the shared database is the single arbiter: a master partitioned away
 *    from Postgres cannot run the crons at all (it cannot deduct either),
 *    so split-brain double-billing is impossible by construction.
 *
 * Flag: CRON_LEADER_LEASE=true (default OFF — single-master behavior is
 * byte-identical when dark; ticks run unguarded exactly as before).
 */

import type { PoolClient } from 'pg';
import { getClient } from '../database/postgres.js';

// App-unique advisory lock key (int64). Never reuse for another lease.
const CRON_LEASE_KEY = 815_551_001;

export function isLeaseEnabled(): boolean {
  return process.env.CRON_LEADER_LEASE === 'true';
}

let leaseClient: PoolClient | null = null;
let heldSinceMs: number | null = null;

/**
 * Try to acquire (or confirm we still hold) the cron lease.
 * Returns true if this process is the leader. Never throws.
 *
 * Re-calling on the same session re-acquires the same lock (Postgres stacks
 * advisory locks per session) — harmless, since the lease is held for the
 * process lifetime and freed by session end.
 */
export async function tryAcquireLease(): Promise<boolean> {
  try {
    if (!leaseClient) {
      leaseClient = await getClient();
    }
    const r = await leaseClient.query<{ got: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS got',
      [CRON_LEASE_KEY]
    );
    const got = r.rows[0]?.got === true;
    if (got && heldSinceMs === null) {
      heldSinceMs = Date.now();
      console.log('[leaderLease] acquired cron lease — this master runs the crons');
    }
    if (!got && heldSinceMs !== null) {
      // Should not happen on a healthy session (we held it); treat as lost.
      heldSinceMs = null;
    }
    return got;
  } catch (err) {
    // Connection died: drop the client so the next tick reconnects. The lock
    // was session-scoped, so Postgres already released it.
    console.error('[leaderLease] lease check failed (treating as not-leader):', err);
    try { leaseClient?.release(); } catch { /* already gone */ }
    leaseClient = null;
    heldSinceMs = null;
    return false;
  }
}

/**
 * Gate for a cron tick. True = proceed. When the flag is off this is a
 * constant-true no-op (legacy single-master behavior).
 */
export async function leaseGate(cronName: string): Promise<boolean> {
  if (!isLeaseEnabled()) return true;
  const leader = await tryAcquireLease();
  if (!leader) {
    console.log(`[leaderLease] ${cronName}: standby (lease held by another master) — skipping tick`);
  }
  return leader;
}

/** Release the lease + dedicated client (graceful shutdown). */
export async function releaseLease(): Promise<void> {
  if (!leaseClient) return;
  try {
    await leaseClient.query('SELECT pg_advisory_unlock_all()');
  } catch { /* session teardown releases anyway */ }
  try { leaseClient.release(); } catch { /* ignore */ }
  leaseClient = null;
  heldSinceMs = null;
}

/** For tests/diagnostics. */
export function leaseHeldSince(): number | null {
  return heldSinceMs;
}
