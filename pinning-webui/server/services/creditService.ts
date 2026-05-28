/**
 * Credit Service - Shared functions for credit management
 * Uses PostgreSQL for database operations
 */

import type { PoolClient } from 'pg';
import { query, getClient, decryptApiKey, encryptApiKey } from '../database/postgres.js';
import { emailToUserId, hashWalletAddress } from '../utils/hash.js';

// Configuration
export const FREE_TIER_BYTES = parseInt(process.env.FREE_TIER_BYTES || '524288000'); // 500MB
export const FULA_PER_GB_MONTH = parseFloat(process.env.FULA_PER_GB_MONTH || '3');
export const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const ADMIN_USER_IDS = ADMIN_EMAILS.map(e => emailToUserId(e));

// FULA token decimals
const FULA_DECIMALS = 18;

// Referral bonus rates per level (1-indexed: BONUS_RATES[0] = level 1)
// Bonus = sourceAmount * BONUS_RATES[level - 1], rounded to FULA_ROUNDING_DIGITS.
const BONUS_RATES = [0.10, 0.01, 0.01] as const;

// Round bonuses to 6 decimal places. REAL (float32) carries ~7 decimal digits of
// total precision, so finer rounding is illusory once balances grow.
const FULA_ROUNDING_DIGITS = 6;
const FULA_ROUNDING_FACTOR = Math.pow(10, FULA_ROUNDING_DIGITS);

// Kill switch for the referral-bonus distribution path. When false, creditUser
// behaves exactly as it did before this feature: no chain walk, no bonus rows.
// Default is true (feature enabled). Set REFERRAL_BONUSES_ENABLED=false at the
// process level to disable in an incident without a redeploy.
const REFERRAL_BONUSES_ENABLED = process.env.REFERRAL_BONUSES_ENABLED !== 'false';

// Chain configuration
export interface ChainInfo {
  chainId: number;
  chainName: string;
  tokenAddress: string;
  vaultAddress: string;
  isEnabled: boolean;
}

// Credit status for a user
export interface UserCreditStatus {
  userId: string;
  email?: string;
  balanceFula: number;
  totalDeposited: number;
  totalDeducted: number;
  isSuspended: boolean;
  lastDeductionAt: string | null;
  currentStorageBytes: number;
  freeTierBytes: number;
  canUpload: boolean;
  message: string;
}

// Get supported chains
export async function getSupportedChains(): Promise<ChainInfo[]> {
  const result = await query<{
    chainid: number;
    chainname: string;
    tokenaddress: string;
    vaultaddress: string;
    isenabled: number;
  }>(`
    SELECT chain_id as chainid, chain_name as chainname, token_address as tokenaddress,
           vault_address as vaultaddress, is_enabled as isenabled
    FROM chain_sync_state
  `);

  return result.rows.map(row => ({
    chainId: row.chainid,
    chainName: row.chainname,
    tokenAddress: row.tokenaddress,
    vaultAddress: row.vaultaddress,
    isEnabled: row.isenabled === 1,
  }));
}

// Get user's storage usage
export async function getUserStorageBytes(userId: string): Promise<number> {
  const result = await query<{ totalsize: string }>(
    `SELECT COALESCE(SUM(size), 0) as totalsize
     FROM pins
     WHERE user_id = $1 AND status != 'deleted'`,
    [userId]
  );

  return parseInt(result.rows[0]?.totalsize || '0', 10);
}

// Get user credit status
export async function getUserCreditStatus(userId: string): Promise<UserCreditStatus> {
  const storageBytes = await getUserStorageBytes(userId);

  const result = await query<{
    balance_fula: number;
    total_deposited_fula: number;
    total_deducted_fula: number;
    is_suspended: number;
    last_deduction_at: string | null;
  }>(
    `SELECT balance_fula, total_deposited_fula, total_deducted_fula,
            is_suspended, last_deduction_at
     FROM user_credits
     WHERE user_id = $1`,
    [userId]
  );

  const credits = result.rows[0];
  const balanceFula = credits?.balance_fula || 0;
  const isSuspended = credits?.is_suspended === 1;

  // Determine if user can upload
  let canUpload = true;
  let message = '';

  if (storageBytes < FREE_TIER_BYTES) {
    canUpload = true;
    const usedMB = Math.round(storageBytes / (1024 * 1024));
    const freeMB = Math.round(FREE_TIER_BYTES / (1024 * 1024));
    message = `Using free tier: ${usedMB}/${freeMB} MB`;
  } else if (isSuspended) {
    canUpload = false;
    message = 'Account suspended. Please add FULA credits to continue.';
  } else if (balanceFula <= 0) {
    canUpload = false;
    message = 'Free tier exceeded. Please add FULA credits to continue.';
  } else {
    canUpload = true;
    message = `Using paid storage. Balance: ${balanceFula.toFixed(2)} FULA`;
  }

  return {
    userId,
    balanceFula,
    totalDeposited: credits?.total_deposited_fula || 0,
    totalDeducted: credits?.total_deducted_fula || 0,
    isSuspended,
    lastDeductionAt: credits?.last_deduction_at || null,
    currentStorageBytes: storageBytes,
    freeTierBytes: FREE_TIER_BYTES,
    canUpload,
    message,
  };
}

// ============================================================
// Internal types & helpers for creditUser + referral bonuses
// ============================================================

type CreditTxType = 'deposit' | 'adjustment' | 'referral_bonus';

interface ChainEntry {
  /** The referrer's user_id (a SHA-256 hash; already opaque — do NOT re-hash). */
  userId: string;
  /** The referral_code used by the descendant at this link in the chain. */
  code: string;
}

interface BonusMetadata {
  /** The recipient-owned code at the chain entry — used for per-code attribution. */
  recipientCode: string;
  /** The signup code of the original credit's source user (rightmost in description chain). */
  sourceSignupCode: string;
  /** 1, 2, or 3. */
  level: 1 | 2 | 3;
}

interface CreditOp {
  userId: string;
  amount: number;
  txType: CreditTxType;
  referenceId: string;
  /** Present iff this op is a referral bonus. */
  bonus?: BonusMetadata;
}

/**
 * Walks the referrals graph up to 3 levels above `startUserId`. Returns a
 * chain ordered from level-1 (immediate referrer) outward. Stops early on:
 *  - missing referrer (chain ends naturally)
 *  - cycle detection (defensive — the unique index on referred_id and
 *    sign-up validation should prevent cycles, but we guard anyway)
 */
async function _walkReferralChain(
  client: PoolClient,
  startUserId: string
): Promise<ChainEntry[]> {
  const chain: ChainEntry[] = [];
  const seen = new Set<string>([startUserId]);
  let cursor = startUserId;

  for (let level = 1; level <= 3; level++) {
    const result = await client.query<{ referrer_id: string; referral_code: string }>(
      `SELECT referrer_id, referral_code
       FROM referrals
       WHERE referred_id = $1`,
      [cursor]
    );
    if (result.rows.length === 0) break;
    const { referrer_id, referral_code } = result.rows[0];
    if (!referrer_id || seen.has(referrer_id)) break; // cycle / self-referral guard
    chain.push({ userId: referrer_id, code: referral_code });
    seen.add(referrer_id);
    cursor = referrer_id;
  }

  return chain;
}

/**
 * Formats the human-readable description string used as `reference_id` on
 * the bonus's credit_history row. The user-specified format:
 *   '<pct>%' bonus referral code <chain> for '<sourceUserId>' level '<N>'
 * where <chain> is the codes from recipient's entry code (leftmost) down to
 * the source's signup code (rightmost), joined with ' > '. L1 collapses to a
 * single code; L3 is a 3-code chain.
 */
function _formatBonusDescription(
  rate: number,
  codePath: string[],
  sourceUserId: string,
  level: number
): string {
  const pct = `${Math.round(rate * 100)}%`;
  const quotedChain = codePath.map(c => `'${c}'`).join(' > ');
  return `'${pct}' bonus referral code ${quotedChain} for '${sourceUserId}' level '${level}'`;
}

/**
 * Atomic UPSERT on user_credits + append to credit_history for one credit op,
 * using a caller-provided client (so the caller owns the transaction).
 *
 * Dispatch on txType:
 *   - 'deposit'        → balance += amount, total_deposited_fula += amount,
 *                        is_suspended cleared.
 *   - 'adjustment'     → balance += amount, totals unchanged, is_suspended cleared.
 *   - 'referral_bonus' → balance += amount, total_bonus_received_fula += amount,
 *                        is_suspended PRESERVED (a descendant's credit must not
 *                        silently unsuspend an ancestor).
 *
 * Returns the new credit_history.id and the post-UPSERT balance.
 */
async function _insertCreditRow(
  client: PoolClient,
  userId: string,
  amount: number,
  txType: CreditTxType,
  referenceId: string
): Promise<{ creditHistoryId: number; balanceAfter: number }> {
  const depositAdd = txType === 'deposit' ? amount : 0;

  let upsertSql: string;
  let upsertArgs: unknown[];

  if (txType === 'referral_bonus') {
    upsertSql = `
      INSERT INTO user_credits (user_id, balance_fula, total_bonus_received_fula)
      VALUES ($1, $2, $2)
      ON CONFLICT (user_id) DO UPDATE
      SET balance_fula = user_credits.balance_fula + $2,
          total_bonus_received_fula = user_credits.total_bonus_received_fula + $2,
          updated_at = NOW()
      RETURNING balance_fula
    `;
    upsertArgs = [userId, amount];
  } else {
    upsertSql = `
      INSERT INTO user_credits (user_id, balance_fula, total_deposited_fula)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE
      SET balance_fula = user_credits.balance_fula + $2,
          total_deposited_fula = user_credits.total_deposited_fula + $3,
          is_suspended = 0, updated_at = NOW()
      RETURNING balance_fula
    `;
    upsertArgs = [userId, amount, depositAdd];
  }

  const balanceResult = await client.query<{ balance_fula: number }>(upsertSql, upsertArgs);
  const balanceAfter = balanceResult.rows[0].balance_fula;

  const historyResult = await client.query<{ id: number }>(
    `INSERT INTO credit_history (user_id, tx_type, amount_fula, balance_after, reference_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, txType, amount, balanceAfter, referenceId]
  );

  return { creditHistoryId: historyResult.rows[0].id, balanceAfter };
}

/**
 * Public credit entry point: atomic-upserts the user's balance, appends the
 * credit_history row, and (for positive deposits/adjustments) emits up to 3
 * referral bonus credits to ancestors in the same transaction.
 *
 * Deadlock safety: source + ancestor UPSERTs are sorted by user_id ASC so all
 * concurrent transactions acquire row locks in the same order regardless of
 * which user is the source of the original credit.
 *
 * No cascade: bonus credits use txType='referral_bonus', which this function
 * does NOT itself emit bonuses for (the bonus-emission branch is keyed on
 * txType ∈ {deposit, adjustment} only).
 */
export async function creditUser(
  userId: string,
  amount: number,
  referenceId: string,
  txType: 'deposit' | 'adjustment' = 'deposit'
): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // 1. Walk the referral chain BEFORE acquiring any row locks (read-only).
    //    Only positive credits trigger bonuses; negative / zero amounts skip
    //    the walk. The kill switch lets ops disable bonuses without redeploy.
    let chain: ChainEntry[] = [];
    if (amount > 0 && REFERRAL_BONUSES_ENABLED) {
      chain = await _walkReferralChain(client, userId);
    }

    // 2. Build the full set of credit operations: source + bonus ops.
    const ops: CreditOp[] = [
      { userId, amount, txType, referenceId },
    ];

    for (let i = 0; i < chain.length; i++) {
      const level = (i + 1) as 1 | 2 | 3;
      const rate = BONUS_RATES[i];
      const bonusAmount = Math.round(amount * rate * FULA_ROUNDING_FACTOR) / FULA_ROUNDING_FACTOR;
      if (bonusAmount <= 0) continue;

      // codePath at level N = [chain[N-1].code, chain[N-2].code, ..., chain[0].code]
      // i.e. recipient's chain-entry code first, source's signup code last.
      const codePath: string[] = [];
      for (let j = i; j >= 0; j--) codePath.push(chain[j].code);

      const description = _formatBonusDescription(rate, codePath, userId, level);

      ops.push({
        userId: chain[i].userId,
        amount: bonusAmount,
        txType: 'referral_bonus',
        referenceId: description,
        bonus: {
          recipientCode: chain[i].code,
          sourceSignupCode: chain[0].code, // = codePath[codePath.length - 1]
          level,
        },
      });
    }

    // 3. Sort by userId ASC so all transactions acquire row locks in the same
    //    order. This eliminates deadlocks on overlapping ancestor chains.
    ops.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

    // 4. Apply all UPSERTs in sorted order.
    const results: Array<{ op: CreditOp; creditHistoryId: number }> = [];
    let sourceCreditHistoryId: number | null = null;
    for (const op of ops) {
      const { creditHistoryId } = await _insertCreditRow(
        client,
        op.userId,
        op.amount,
        op.txType,
        op.referenceId
      );
      results.push({ op, creditHistoryId });
      if (!op.bonus && op.userId === userId && op.txType === txType) {
        sourceCreditHistoryId = creditHistoryId;
      }
    }

    // 5. Record each bonus in referral_bonuses for per-code rollup + audit.
    //    Within this transaction, sourceCreditHistoryId is brand-new (SERIAL),
    //    so the UNIQUE (source_credit_history_id, level) constraint cannot
    //    spuriously conflict; the ON CONFLICT DO NOTHING is the idempotency
    //    contract for a future admin-only backfill endpoint that may replay
    //    bonus emission over existing credit_history rows.
    if (sourceCreditHistoryId !== null) {
      for (const { op, creditHistoryId } of results) {
        if (!op.bonus) continue;
        await client.query(
          `INSERT INTO referral_bonuses (
             credit_history_id, recipient_user_id, recipient_referral_code,
             source_credit_history_id, source_user_id, source_referral_code,
             level, bonus_amount_fula, source_amount_fula
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (source_credit_history_id, level) DO NOTHING`,
          [
            creditHistoryId, op.userId, op.bonus.recipientCode,
            sourceCreditHistoryId, userId, op.bonus.sourceSignupCode,
            op.bonus.level, op.amount, amount,
          ]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Convert raw token amount (from blockchain) to FULA
// Preserves precision for the integer part; only fractional part may lose precision above 2^53
export function rawToFula(rawAmount: string): number {
  const amount = BigInt(rawAmount);
  const divisor = BigInt(10 ** FULA_DECIMALS);
  const whole = amount / divisor;
  const remainder = amount % divisor;
  return Number(whole) + Number(remainder) / Number(divisor);
}

// Get user's linked wallets
export async function getUserWallets(userId: string): Promise<Array<{
  address: string;
  chainId: number;
  isVerified: boolean;
  connectedAt: string;
  walletAddressHash?: string;
  encryptedWalletAddress?: string;
}>> {
  const result = await query<{
    address: string;
    chainid: number;
    isverified: number;
    connectedat: string;
    walletaddresshash: string | null;
    encryptedwalletaddress: string | null;
  }>(
    `SELECT wallet_address as address, chain_id as chainid,
            is_verified as isverified, connected_at as connectedat,
            wallet_address_hash as walletaddresshash,
            encrypted_wallet_address as encryptedwalletaddress
     FROM user_wallets
     WHERE user_id = $1
     ORDER BY connected_at DESC`,
    [userId]
  );

  return result.rows.map(row => {
    let displayAddress = row.address;
    if (!displayAddress && row.encryptedwalletaddress) {
      try {
        const decrypted = decryptApiKey(row.encryptedwalletaddress);
        if (decrypted) displayAddress = decrypted;
      } catch { /* legacy */ }
    }
    return {
      address: displayAddress || '(address hidden)',
      chainId: row.chainid,
      isVerified: row.isverified === 1,
      connectedAt: row.connectedat,
      walletAddressHash: row.walletaddresshash || undefined,
      encryptedWalletAddress: row.encryptedwalletaddress || undefined,
    };
  });
}

// Link a wallet to a user
export async function linkWallet(
  userId: string,
  walletAddress: string,
  chainId: number,
  isVerified: boolean = false,
): Promise<void> {
  const addressHash = hashWalletAddress(walletAddress);
  const serverEncrypted = encryptApiKey(walletAddress.toLowerCase());
  await query(
    `INSERT INTO user_wallets (user_id, wallet_address, wallet_address_hash, encrypted_wallet_address, chain_id, is_verified, connected_at)
     VALUES ($1, NULL, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id, wallet_address_hash, chain_id) DO UPDATE
     SET is_verified = $5, connected_at = NOW(), encrypted_wallet_address = COALESCE($3, user_wallets.encrypted_wallet_address)`,
    [userId, addressHash, serverEncrypted, chainId, isVerified ? 1 : 0]
  );
}

// Unlink a wallet from a user
export async function unlinkWallet(userId: string, addressOrHash: string): Promise<boolean> {
  // Determine if addressOrHash is a hash (64 hex chars) or an address (starts with 0x)
  const isHash = /^[0-9a-f]{64}$/i.test(addressOrHash);
  const walletHash = isHash ? addressOrHash : hashWalletAddress(addressOrHash);

  // Try by user_id + wallet_address_hash first
  let result = await query(
    `DELETE FROM user_wallets
     WHERE user_id = $1 AND wallet_address_hash = $2`,
    [userId, walletHash]
  );

  if ((result.rowCount || 0) > 0) {
    return true;
  }

  // Fallback: try by user_id + wallet_address for legacy rows
  if (!isHash) {
    result = await query(
      `DELETE FROM user_wallets
       WHERE user_id = $1 AND wallet_address = $2`,
      [userId, addressOrHash.toLowerCase()]
    );
  }

  return (result.rowCount || 0) > 0;
}

// Get user's credit history
export async function getCreditHistory(
  userId: string,
  limit: number = 50
): Promise<Array<{
  txType: string;
  amountFula: number;
  balanceAfter: number;
  referenceId: string | null;
  createdAt: string;
}>> {
  const result = await query<{
    txtype: string;
    amountfula: number;
    balanceafter: number;
    referenceid: string | null;
    createdat: string;
  }>(
    `SELECT tx_type as txtype, amount_fula as amountfula, balance_after as balanceafter,
            reference_id as referenceid, created_at as createdat
     FROM credit_history
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );

  return result.rows.map(row => ({
    txType: row.txtype,
    amountFula: row.amountfula,
    balanceAfter: row.balanceafter,
    referenceId: row.referenceid,
    createdAt: row.createdat,
  }));
}

// Check if email is admin
export function isAdmin(email: string): boolean {
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

// Check if user_id is admin
export function isAdminById(userId: string): boolean {
  return ADMIN_USER_IDS.includes(userId);
}

// Get suspended users (admin only)
export async function getSuspendedUsers(): Promise<Array<{
  userId: string;
  email: string;
  balanceFula: number;
  suspendedAt: string | null;
  storageBytes: number;
}>> {
  const result = await query<{
    userid: string;
    email: string;
    balancefula: number;
    suspendedat: string | null;
  }>(`
    SELECT uc.user_id as userid, uc.user_email as email, uc.balance_fula as balancefula, uc.suspended_at as suspendedat
    FROM user_credits uc
    WHERE uc.is_suspended = 1
    ORDER BY uc.suspended_at DESC
  `);

  const users: Array<{
    userId: string;
    email: string;
    balanceFula: number;
    suspendedAt: string | null;
    storageBytes: number;
  }> = [];

  for (const row of result.rows) {
    const storageBytes = await getUserStorageBytes(row.userid);
    users.push({
      userId: row.userid,
      email: row.email,
      balanceFula: row.balancefula,
      suspendedAt: row.suspendedat,
      storageBytes,
    });
  }

  return users;
}

// Unsuspend a user (admin only)
export async function unsuspendUser(userId: string): Promise<boolean> {
  const result = await query(
    `UPDATE user_credits
     SET is_suspended = 0, suspended_at = NULL, updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );

  return (result.rowCount || 0) > 0;
}

// Re-export hashWalletAddress for external use
export { hashWalletAddress };
