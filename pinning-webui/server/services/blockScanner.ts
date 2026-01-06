/**
 * Block Scanner Cron Service
 *
 * Scans blockchain explorers for FULA token transfers to the vault address.
 * Auto-credits users whose linked wallets sent payments.
 * Runs every 10 minutes.
 */

import Database from 'better-sqlite3';

// Chain configuration
interface ChainConfig {
  chainId: number;
  chainName: string;
  tokenAddress: string;
  vaultAddress: string;
  lastScannedBlock: number;
  isEnabled: boolean;
}

// Token transfer from explorer API
interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  value: string; // Raw amount in wei (18 decimals)
  blockNumber: string;
  timeStamp: string;
}

// Explorer API response
interface ExplorerResponse {
  status: string;
  message: string;
  result: TokenTransfer[] | string;
}

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const FULA_DECIMALS = 18;

// Convert raw token amount to FULA
function toFula(rawAmount: string): number {
  const amount = BigInt(rawAmount);
  const divisor = BigInt(10 ** FULA_DECIMALS);
  const fula = Number(amount) / Number(divisor);
  return fula;
}

// Get explorer API URL for a chain
function getExplorerUrl(chainId: number, tokenAddress: string, vaultAddress: string, startBlock: number): string {
  switch (chainId) {
    case 1: // Ethereum
      return `https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokentx&contractaddress=${tokenAddress}&address=${vaultAddress}&startblock=${startBlock}&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
    case 8453: // Base
      return `https://api.etherscan.io/v2/api?chainid=8453&module=account&action=tokentx&contractaddress=${tokenAddress}&address=${vaultAddress}&startblock=${startBlock}&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
    case 2046399126: // Skale Europa
      return `https://elated-tan-skat.explorer.mainnet.skalenodes.com/api?module=account&action=tokentx&contractaddress=${tokenAddress}&address=${vaultAddress}&startblock=${startBlock}&sort=asc`;
    default:
      throw new Error(`Unsupported chain ID: ${chainId}`);
  }
}

// Fetch token transfers from explorer API
async function fetchTokenTransfers(chainId: number, tokenAddress: string, vaultAddress: string, startBlock: number): Promise<TokenTransfer[]> {
  const url = getExplorerUrl(chainId, tokenAddress, vaultAddress, startBlock);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[blockScanner] Explorer API error for chain ${chainId}:`, response.status);
      return [];
    }

    const data: ExplorerResponse = await response.json();

    if (data.status !== '1' || typeof data.result === 'string') {
      // No results or error
      if (data.message !== 'No transactions found') {
        console.log(`[blockScanner] Chain ${chainId}: ${data.message || 'No transactions'}`);
      }
      return [];
    }

    // Filter for transfers TO the vault address
    return data.result.filter(tx => tx.to.toLowerCase() === vaultAddress.toLowerCase());
  } catch (error) {
    console.error(`[blockScanner] Error fetching transfers for chain ${chainId}:`, error);
    return [];
  }
}

// Process a single token transfer
function processTransfer(db: Database.Database, chainId: number, transfer: TokenTransfer): boolean {
  const amountFula = toFula(transfer.value);

  // Skip tiny amounts (dust)
  if (amountFula < 0.001) {
    return false;
  }

  try {
    // Insert transaction (ON CONFLICT IGNORE to handle duplicates)
    const insertTx = db.prepare(`
      INSERT OR IGNORE INTO token_transactions
        (tx_hash, chain_id, from_address, to_address, amount_raw, amount_fula, block_number, block_timestamp, ingestion_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cron')
    `);

    const result = insertTx.run(
      transfer.hash,
      chainId,
      transfer.from.toLowerCase(),
      transfer.to.toLowerCase(),
      transfer.value,
      amountFula,
      parseInt(transfer.blockNumber),
      parseInt(transfer.timeStamp)
    );

    if (result.changes === 0) {
      // Transaction already exists
      return false;
    }

    // Check if sender has a linked wallet
    const wallet = db.prepare(`
      SELECT user_email FROM user_wallets
      WHERE wallet_address = ? AND is_verified = 1
    `).get(transfer.from.toLowerCase()) as { user_email: string } | undefined;

    if (wallet) {
      // Auto-credit the user
      creditUser(db, wallet.user_email, amountFula, transfer.hash, chainId);

      // Update transaction with user email
      db.prepare(`
        UPDATE token_transactions
        SET user_email = ?, claimed_at = CURRENT_TIMESTAMP
        WHERE tx_hash = ? AND chain_id = ?
      `).run(wallet.user_email, transfer.hash, chainId);

      console.log(`[blockScanner] Auto-credited ${amountFula} FULA to ${wallet.user_email} from tx ${transfer.hash}`);
    }

    return true;
  } catch (error) {
    console.error(`[blockScanner] Error processing transfer ${transfer.hash}:`, error);
    return false;
  }
}

// Credit FULA to a user's account
function creditUser(db: Database.Database, userEmail: string, amount: number, txHash: string, chainId: number): void {
  const transaction = db.transaction(() => {
    // Get or create user credits record
    const existing = db.prepare('SELECT balance_fula FROM user_credits WHERE user_email = ?').get(userEmail) as { balance_fula: number } | undefined;

    let newBalance: number;
    if (existing) {
      newBalance = existing.balance_fula + amount;
      db.prepare(`
        UPDATE user_credits
        SET balance_fula = ?, total_deposited_fula = total_deposited_fula + ?,
            is_suspended = 0, updated_at = CURRENT_TIMESTAMP
        WHERE user_email = ?
      `).run(newBalance, amount, userEmail);
    } else {
      newBalance = amount;
      db.prepare(`
        INSERT INTO user_credits (user_email, balance_fula, total_deposited_fula)
        VALUES (?, ?, ?)
      `).run(userEmail, amount, amount);
    }

    // Log the deposit in credit history
    db.prepare(`
      INSERT INTO credit_history (user_email, tx_type, amount_fula, balance_after, reference_id)
      VALUES (?, 'deposit', ?, ?, ?)
    `).run(userEmail, amount, newBalance, `${chainId}:${txHash}`);
  });

  transaction();
}

// Update the last scanned block for a chain
function updateLastScannedBlock(db: Database.Database, chainId: number, blockNumber: number): void {
  db.prepare(`
    UPDATE chain_sync_state
    SET last_scanned_block = ?, last_scan_at = CURRENT_TIMESTAMP
    WHERE chain_id = ?
  `).run(blockNumber, chainId);
}

// Get enabled chains from database
function getEnabledChains(db: Database.Database): ChainConfig[] {
  return db.prepare(`
    SELECT chain_id as chainId, chain_name as chainName, token_address as tokenAddress,
           vault_address as vaultAddress, last_scanned_block as lastScannedBlock, is_enabled as isEnabled
    FROM chain_sync_state
    WHERE is_enabled = 1
  `).all() as ChainConfig[];
}

// Scan a single chain
async function scanChain(db: Database.Database, chain: ChainConfig): Promise<{ processed: number; newTxs: number }> {
  console.log(`[blockScanner] Scanning ${chain.chainName} (${chain.chainId}) from block ${chain.lastScannedBlock}`);

  const transfers = await fetchTokenTransfers(
    chain.chainId,
    chain.tokenAddress,
    chain.vaultAddress,
    chain.lastScannedBlock + 1
  );

  if (transfers.length === 0) {
    return { processed: 0, newTxs: 0 };
  }

  let newTxs = 0;
  let maxBlock = chain.lastScannedBlock;

  for (const transfer of transfers) {
    const isNew = processTransfer(db, chain.chainId, transfer);
    if (isNew) newTxs++;

    const blockNum = parseInt(transfer.blockNumber);
    if (blockNum > maxBlock) {
      maxBlock = blockNum;
    }
  }

  // Update last scanned block
  if (maxBlock > chain.lastScannedBlock) {
    updateLastScannedBlock(db, chain.chainId, maxBlock);
  }

  return { processed: transfers.length, newTxs };
}

// Main scanner function
export async function runBlockScanner(db: Database.Database): Promise<void> {
  console.log('[blockScanner] Starting block scan...');

  const chains = getEnabledChains(db);

  if (chains.length === 0) {
    console.log('[blockScanner] No enabled chains found');
    return;
  }

  // Check if vault address is configured
  const vaultCheck = chains[0];
  if (vaultCheck.vaultAddress === '0x0000000000000000000000000000000000000000') {
    console.log('[blockScanner] Vault address not configured, skipping scan');
    return;
  }

  let totalProcessed = 0;
  let totalNew = 0;

  for (const chain of chains) {
    try {
      const { processed, newTxs } = await scanChain(db, chain);
      totalProcessed += processed;
      totalNew += newTxs;

      // Small delay between chains to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`[blockScanner] Error scanning ${chain.chainName}:`, error);
    }
  }

  console.log(`[blockScanner] Scan complete. Processed: ${totalProcessed}, New: ${totalNew}`);
}

// Start the cron job
let scannerInterval: NodeJS.Timeout | null = null;

export function startBlockScanner(db: Database.Database, intervalMs: number = 10 * 60 * 1000): void {
  if (scannerInterval) {
    console.log('[blockScanner] Scanner already running');
    return;
  }

  console.log(`[blockScanner] Starting scanner with ${intervalMs / 1000}s interval`);

  // Run immediately on start
  runBlockScanner(db).catch(err => console.error('[blockScanner] Initial scan error:', err));

  // Then run on interval
  scannerInterval = setInterval(() => {
    runBlockScanner(db).catch(err => console.error('[blockScanner] Scan error:', err));
  }, intervalMs);
}

export function stopBlockScanner(): void {
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
    console.log('[blockScanner] Scanner stopped');
  }
}
