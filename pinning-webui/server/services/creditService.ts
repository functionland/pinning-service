/**
 * Credit Service - Shared functions for credit management
 * Uses PostgreSQL for database operations
 */

import { query, getClient } from '../database/postgres.js';
import { emailToUserId, hashWalletAddress } from '../utils/hash.js';

// Configuration
export const FREE_TIER_BYTES = parseInt(process.env.FREE_TIER_BYTES || '524288000'); // 500MB
export const FULA_PER_GB_MONTH = parseFloat(process.env.FULA_PER_GB_MONTH || '3');
export const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const ADMIN_USER_IDS = ADMIN_EMAILS.map(e => emailToUserId(e));

// FULA token decimals
const FULA_DECIMALS = 18;

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

// Credit user with FULA (from manual claim or admin adjustment)
export async function creditUser(
  userId: string,
  amount: number,
  referenceId: string,
  txType: 'deposit' | 'adjustment' = 'deposit'
): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Atomic upsert — no read-then-write race condition
    const depositAdd = txType === 'deposit' ? amount : 0;
    const result = await client.query<{ balance_fula: number }>(
      `INSERT INTO user_credits (user_id, balance_fula, total_deposited_fula)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
       SET balance_fula = user_credits.balance_fula + $2,
           total_deposited_fula = user_credits.total_deposited_fula + $3,
           is_suspended = 0, updated_at = NOW()
       RETURNING balance_fula`,
      [userId, amount, depositAdd]
    );
    const newBalance = result.rows[0].balance_fula;

    // Log in credit history — no plain-text email
    await client.query(
      `INSERT INTO credit_history (user_id, tx_type, amount_fula, balance_after, reference_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, txType, amount, newBalance, referenceId]
    );

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

  return result.rows.map(row => ({
    address: row.address,
    chainId: row.chainid,
    isVerified: row.isverified === 1,
    connectedAt: row.connectedat,
    walletAddressHash: row.walletaddresshash || undefined,
    encryptedWalletAddress: row.encryptedwalletaddress || undefined,
  }));
}

// Link a wallet to a user
export async function linkWallet(
  userId: string,
  walletAddress: string,
  chainId: number,
  isVerified: boolean = false,
  encryptedAddress?: string
): Promise<void> {
  const addressHash = hashWalletAddress(walletAddress);
  await query(
    `INSERT INTO user_wallets (user_id, wallet_address, wallet_address_hash, encrypted_wallet_address, chain_id, is_verified, connected_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id, wallet_address_hash, chain_id) DO UPDATE
     SET is_verified = $6, connected_at = NOW(), encrypted_wallet_address = COALESCE($4, user_wallets.encrypted_wallet_address)`,
    [userId, walletAddress.toLowerCase(), addressHash, encryptedAddress || null, chainId, isVerified ? 1 : 0]
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
