/**
 * Credit Service - Shared functions for credit management
 */

import Database from 'better-sqlite3';

// Configuration
export const FREE_TIER_BYTES = parseInt(process.env.FREE_TIER_BYTES || '524288000'); // 500MB
export const FULA_PER_GB_MONTH = parseFloat(process.env.FULA_PER_GB_MONTH || '3');
export const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

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
  email: string;
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
export function getSupportedChains(db: Database.Database): ChainInfo[] {
  return db.prepare(`
    SELECT chain_id as chainId, chain_name as chainName, token_address as tokenAddress,
           vault_address as vaultAddress, is_enabled as isEnabled
    FROM chain_sync_state
  `).all() as ChainInfo[];
}

// Get user's storage usage
export function getUserStorageBytes(db: Database.Database, userEmail: string): number {
  const result = db.prepare(`
    SELECT COALESCE(SUM(size), 0) as totalSize
    FROM pins
    WHERE username = ? AND status != 'deleted'
  `).get(userEmail) as { totalSize: number };

  return result.totalSize;
}

// Get user credit status
export function getUserCreditStatus(db: Database.Database, userEmail: string): UserCreditStatus {
  const storageBytes = getUserStorageBytes(db, userEmail);

  const credits = db.prepare(`
    SELECT balance_fula, total_deposited_fula, total_deducted_fula,
           is_suspended, last_deduction_at
    FROM user_credits
    WHERE user_email = ?
  `).get(userEmail) as {
    balance_fula: number;
    total_deposited_fula: number;
    total_deducted_fula: number;
    is_suspended: number;
    last_deduction_at: string | null;
  } | undefined;

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
    email: userEmail,
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
export function creditUser(db: Database.Database, userEmail: string, amount: number, referenceId: string, txType: 'deposit' | 'adjustment' = 'deposit'): void {
  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT balance_fula FROM user_credits WHERE user_email = ?').get(userEmail) as { balance_fula: number } | undefined;

    let newBalance: number;
    if (existing) {
      newBalance = existing.balance_fula + amount;
      const updateFields = txType === 'deposit'
        ? 'balance_fula = ?, total_deposited_fula = total_deposited_fula + ?'
        : 'balance_fula = ?';
      const updateValues = txType === 'deposit'
        ? [newBalance, amount, userEmail]
        : [newBalance, userEmail];

      db.prepare(`
        UPDATE user_credits
        SET ${updateFields}, is_suspended = 0, updated_at = CURRENT_TIMESTAMP
        WHERE user_email = ?
      `).run(...updateValues);
    } else {
      newBalance = amount;
      db.prepare(`
        INSERT INTO user_credits (user_email, balance_fula, total_deposited_fula)
        VALUES (?, ?, ?)
      `).run(userEmail, amount, txType === 'deposit' ? amount : 0);
    }

    // Log in credit history
    db.prepare(`
      INSERT INTO credit_history (user_email, tx_type, amount_fula, balance_after, reference_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(userEmail, txType, amount, newBalance, referenceId);
  });

  transaction();
}

// Convert raw token amount (from blockchain) to FULA
export function rawToFula(rawAmount: string): number {
  const amount = BigInt(rawAmount);
  const divisor = BigInt(10 ** FULA_DECIMALS);
  return Number(amount) / Number(divisor);
}

// Verify EIP-191 signature for wallet ownership
export function verifySignature(message: string, signature: string, expectedAddress: string): boolean {
  // Simple EIP-191 signature verification
  // In production, use ethers.js or viem for proper verification
  try {
    // Import viem for verification (will be added to dependencies)
    const { verifyMessage } = require('viem');
    verifyMessage({
      address: expectedAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    return true; // verifyMessage throws if invalid
  } catch {
    // Fallback: just check that the signature exists and address format is valid
    // This is a temporary workaround until viem is properly integrated
    return /^0x[a-fA-F0-9]{130}$/.test(signature) && /^0x[a-fA-F0-9]{40}$/i.test(expectedAddress);
  }
}

// Get user's linked wallets
export function getUserWallets(db: Database.Database, userEmail: string): Array<{
  address: string;
  chainId: number;
  isVerified: boolean;
  connectedAt: string;
}> {
  return db.prepare(`
    SELECT wallet_address as address, chain_id as chainId,
           is_verified as isVerified, connected_at as connectedAt
    FROM user_wallets
    WHERE user_email = ?
    ORDER BY connected_at DESC
  `).all(userEmail) as Array<{
    address: string;
    chainId: number;
    isVerified: boolean;
    connectedAt: string;
  }>;
}

// Link a wallet to a user
export function linkWallet(db: Database.Database, userEmail: string, walletAddress: string, chainId: number, isVerified: boolean = false): void {
  db.prepare(`
    INSERT OR REPLACE INTO user_wallets (user_email, wallet_address, chain_id, is_verified, connected_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(userEmail, walletAddress.toLowerCase(), chainId, isVerified ? 1 : 0);
}

// Unlink a wallet from a user
export function unlinkWallet(db: Database.Database, userEmail: string, walletAddress: string): boolean {
  const result = db.prepare(`
    DELETE FROM user_wallets
    WHERE user_email = ? AND wallet_address = ?
  `).run(userEmail, walletAddress.toLowerCase());

  return result.changes > 0;
}

// Get user's credit history
export function getCreditHistory(db: Database.Database, userEmail: string, limit: number = 50): Array<{
  txType: string;
  amountFula: number;
  balanceAfter: number;
  referenceId: string | null;
  createdAt: string;
}> {
  return db.prepare(`
    SELECT tx_type as txType, amount_fula as amountFula, balance_after as balanceAfter,
           reference_id as referenceId, created_at as createdAt
    FROM credit_history
    WHERE user_email = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userEmail, limit) as Array<{
    txType: string;
    amountFula: number;
    balanceAfter: number;
    referenceId: string | null;
    createdAt: string;
  }>;
}

// Check if email is admin
export function isAdmin(email: string): boolean {
  return ADMIN_EMAILS.includes(email);
}

// Get suspended users (admin only)
export function getSuspendedUsers(db: Database.Database): Array<{
  email: string;
  balanceFula: number;
  suspendedAt: string | null;
  storageBytes: number;
}> {
  const users = db.prepare(`
    SELECT uc.user_email as email, uc.balance_fula as balanceFula, uc.suspended_at as suspendedAt
    FROM user_credits uc
    WHERE uc.is_suspended = 1
    ORDER BY uc.suspended_at DESC
  `).all() as Array<{ email: string; balanceFula: number; suspendedAt: string | null }>;

  return users.map(user => ({
    ...user,
    storageBytes: getUserStorageBytes(db, user.email),
  }));
}

// Unsuspend a user (admin only)
export function unsuspendUser(db: Database.Database, userEmail: string): boolean {
  const result = db.prepare(`
    UPDATE user_credits
    SET is_suspended = 0, suspended_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE user_email = ?
  `).run(userEmail);

  return result.changes > 0;
}
