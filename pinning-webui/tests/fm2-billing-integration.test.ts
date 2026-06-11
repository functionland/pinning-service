/**
 * FM-2 integration tests — REQUIRE a reachable Postgres (POSTGRES_* env).
 * Skipped automatically when no DB is available (local dev on Windows);
 * the Phase 1.5 e2e runs them on the test master against the real stack DB.
 *
 * BILLING_IDEMPOTENCY is a module-load constant, so it is stubbed BEFORE the
 * dynamic imports below — do not convert these to static imports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

process.env.BILLING_IDEMPOTENCY = 'true';

const USER = 'itest-fm2-user';
const WALLET = '0x00000000000000000000000000000000f0f0f0f0';
const GB = 1024 * 1024 * 1024;

let pgAvailable = false;
let db: typeof import('../server/services/../database/postgres');
let dj: typeof import('../server/services/deductionJob');
let bs: typeof import('../server/services/blockScanner');
let hash: typeof import('../server/utils/hash');

beforeAll(async () => {
  db = await import('../server/database/postgres');
  try {
    await db.query('SELECT 1');
    pgAvailable = true;
  } catch {
    pgAvailable = false;
    return;
  }
  dj = await import('../server/services/deductionJob');
  bs = await import('../server/services/blockScanner');
  hash = await import('../server/utils/hash');
  await cleanup();
  // Seed: a credited user with a verified wallet.
  await db.query(
    `INSERT INTO user_credits (user_id, balance_fula, total_deposited_fula)
     VALUES ($1, 100, 100)
     ON CONFLICT (user_id) DO UPDATE SET balance_fula = 100`,
    [USER]
  );
  await db.query(
    `INSERT INTO user_wallets (user_id, wallet_address, wallet_address_hash, chain_id, is_verified, connected_at)
     VALUES ($1, NULL, $2, 8453, 1, NOW())
     ON CONFLICT DO NOTHING`,
    [USER, hash.hashWalletAddress(WALLET)]
  );
});

async function cleanup() {
  await db.query(`DELETE FROM referral_bonuses WHERE recipient_user_id = $1 OR source_user_id = $1`, [USER]).catch(() => {});
  await db.query(`DELETE FROM credit_history WHERE user_id = $1`, [USER]);
  await db.query(`DELETE FROM token_transactions WHERE from_address = $1`, [WALLET.toLowerCase()]);
  await db.query(`DELETE FROM user_wallets WHERE user_id = $1`, [USER]);
  await db.query(`DELETE FROM user_credits WHERE user_id = $1`, [USER]);
}

afterAll(async () => {
  if (pgAvailable) {
    await cleanup();
    await db.closePool();
  }
});

describe('FM-2 multi-master billing (live Postgres)', () => {
  it('two concurrent deductions for the same (user, hour) deduct exactly once', async (ctx) => {
    if (!pgAvailable) return ctx.skip();
    const bytes = 10 * GB; // well over the free tier
    const [a, b] = await Promise.all([
      dj.processUserDeduction(USER, bytes),
      dj.processUserDeduction(USER, bytes),
    ]);

    // Exactly one of the two racers deducted; the other observed the gate.
    expect([a.deducted, b.deducted].filter(Boolean)).toHaveLength(1);

    const rows = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM credit_history
       WHERE user_id = $1 AND tx_type = 'hourly_deduction' AND reference_id = $2`,
      [USER, dj.currentHourBucket()]
    );
    expect(parseInt(rows.rows[0].n, 10)).toBe(1);

    const bal = await db.query<{ balance_fula: number }>(
      `SELECT balance_fula FROM user_credits WHERE user_id = $1`, [USER]
    );
    const expected = 100 - dj.calculateHourlyDeduction(bytes);
    expect(bal.rows[0].balance_fula).toBeCloseTo(expected, 4);
  });

  it('replayed deposit (same tx hash) credits exactly once — atomically', async (ctx) => {
    if (!pgAvailable) return ctx.skip();
    const transfer = {
      hash: '0xfm2itest' + Date.now().toString(16),
      from: WALLET,
      to: '0x000000000000000000000000000000000000dead',
      value: (5n * 10n ** 18n).toString(), // 5 FULA
      blockNumber: '12345678',
      timeStamp: `${Math.floor(Date.now() / 1000)}`,
    };

    const before = await db.query<{ balance_fula: number }>(
      `SELECT balance_fula FROM user_credits WHERE user_id = $1`, [USER]
    );

    const first = await bs.processTransfer(8453, transfer);
    const second = await bs.processTransfer(8453, transfer); // replay
    expect(first).toBe(true);
    expect(second).toBe(false);

    const txs = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM token_transactions WHERE tx_hash = $1 AND chain_id = 8453`,
      [transfer.hash]
    );
    expect(parseInt(txs.rows[0].n, 10)).toBe(1);

    const deposits = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM credit_history
       WHERE user_id = $1 AND tx_type = 'deposit' AND reference_id = $2`,
      [USER, `8453:${transfer.hash}`]
    );
    expect(parseInt(deposits.rows[0].n, 10)).toBe(1);

    const after = await db.query<{ balance_fula: number }>(
      `SELECT balance_fula FROM user_credits WHERE user_id = $1`, [USER]
    );
    expect(after.rows[0].balance_fula).toBeCloseTo(before.rows[0].balance_fula + 5, 4);

    // Atomicity: the recorded tx is also claimed (no recorded-but-uncredited state).
    const claimed = await db.query<{ user_id: string | null; claimed_at: string | null }>(
      `SELECT user_id, claimed_at FROM token_transactions WHERE tx_hash = $1 AND chain_id = 8453`,
      [transfer.hash]
    );
    expect(claimed.rows[0].user_id).toBe(USER);
    expect(claimed.rows[0].claimed_at).not.toBeNull();
  });
});
