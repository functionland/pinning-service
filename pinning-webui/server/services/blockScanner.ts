/**
 * Block Scanner Cron Service
 *
 * Scans blockchain explorers for FULA token transfers to the vault address.
 * Auto-credits users whose linked wallets sent payments.
 * Runs every 10 minutes.
 * Uses PostgreSQL for database operations.
 */

import { query } from '../database/postgres.js';
import { hashWalletAddress } from '../utils/hash.js';
import { creditUser } from './creditService.js';

// Chain configuration
export interface ChainConfig {
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
  const whole = amount / divisor;
  const frac = amount % divisor;
  return Number(whole) + Number(frac) / Number(divisor);
}

// Get explorer API URL for a chain (Ethereum + SKALE only; Base uses direct RPC)
function getExplorerUrl(chainId: number, tokenAddress: string, vaultAddress: string, startBlock: number): string {
  switch (chainId) {
    case 1: // Ethereum
      return `https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokentx&contractaddress=${tokenAddress}&address=${vaultAddress}&startblock=${startBlock}&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
    case 2046399126: // Skale Europa
      return `https://elated-tan-skat.explorer.mainnet.skalenodes.com/api?module=account&action=tokentx&contractaddress=${tokenAddress}&address=${vaultAddress}&startblock=${startBlock}&sort=asc`;
    default:
      throw new Error(`Unsupported chain ID: ${chainId}`);
  }
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RPC_LOG_RANGE = 10000; // Base RPC limits eth_getLogs to 10,000 blocks

// Fetch token transfers via direct RPC eth_getLogs (for Base chain)
async function fetchTokenTransfersViaRpc(tokenAddress: string, vaultAddress: string, startBlock: number): Promise<TokenTransfer[]> {
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const vaultPadded = '0x' + vaultAddress.slice(2).toLowerCase().padStart(64, '0');

  try {
    // Get current block number
    const blockResp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
    });
    const blockData = await blockResp.json();
    const currentBlock = parseInt(blockData.result, 16);

    if (startBlock > currentBlock) return [];

    const allTransfers: TokenTransfer[] = [];

    // Scan in chunks of RPC_LOG_RANGE blocks
    for (let from = startBlock; from <= currentBlock; from += RPC_LOG_RANGE) {
      const to = Math.min(from + RPC_LOG_RANGE - 1, currentBlock);

      const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_getLogs',
          params: [{
            address: tokenAddress,
            topics: [TRANSFER_TOPIC, null, vaultPadded],
            fromBlock: '0x' + from.toString(16),
            toBlock: '0x' + to.toString(16)
          }]
        })
      });
      const data = await resp.json();

      if (data.error) {
        console.error(`[blockScanner] Base RPC eth_getLogs error:`, data.error.message);
        break;
      }

      for (const log of data.result || []) {
        allTransfers.push({
          hash: log.transactionHash,
          from: '0x' + log.topics[1].slice(26),
          to: '0x' + log.topics[2].slice(26),
          value: BigInt(log.data).toString(),
          blockNumber: parseInt(log.blockNumber, 16).toString(),
          timeStamp: log.blockTimestamp ? parseInt(log.blockTimestamp, 16).toString() : Math.floor(Date.now() / 1000).toString()
        });
      }

      // Small delay between chunks to avoid rate limiting
      if (to < currentBlock) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    return allTransfers;
  } catch (error) {
    console.error(`[blockScanner] Error fetching Base transfers via RPC:`, error);
    return [];
  }
}

// Fetch token transfers from explorer API or RPC
async function fetchTokenTransfers(chainId: number, tokenAddress: string, vaultAddress: string, startBlock: number): Promise<TokenTransfer[]> {
  // Base: use direct RPC (Etherscan v2 dropped free Base support)
  if (chainId === 8453) {
    return fetchTokenTransfersViaRpc(tokenAddress, vaultAddress, startBlock);
  }

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
export async function processTransfer(chainId: number, transfer: TokenTransfer): Promise<boolean> {
  const amountFula = toFula(transfer.value);

  // Skip tiny amounts (dust)
  if (amountFula < 0.001) {
    return false;
  }

  try {
    // Insert transaction (ON CONFLICT DO NOTHING to handle duplicates)
    const result = await query(
      `INSERT INTO token_transactions
         (tx_hash, chain_id, from_address, to_address, amount_raw, amount_fula, block_number, block_timestamp, ingestion_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'cron')
       ON CONFLICT (tx_hash, chain_id) DO NOTHING`,
      [
        transfer.hash,
        chainId,
        transfer.from.toLowerCase(),
        transfer.to.toLowerCase(),
        transfer.value,
        amountFula,
        parseInt(transfer.blockNumber),
        parseInt(transfer.timeStamp)
      ]
    );

    if ((result.rowCount || 0) === 0) {
      // Transaction already exists
      return false;
    }

    // Check if sender has a linked wallet (lookup by address hash)
    const fromHash = hashWalletAddress(transfer.from);
    const walletResult = await query<{ user_id: string }>(
      `SELECT user_id FROM user_wallets
       WHERE wallet_address_hash = $1 AND is_verified = 1`,
      [fromHash]
    );

    const wallet = walletResult.rows[0];

    if (wallet) {
      // Auto-credit the user via the shared creditService (also fires
      // multi-level referral bonuses to the user's ancestors).
      await creditUser(wallet.user_id, amountFula, `${chainId}:${transfer.hash}`, 'deposit');

      // Update transaction with user_id — no plain-text email
      await query(
        `UPDATE token_transactions
         SET user_id = $1, claimed_at = NOW()
         WHERE tx_hash = $2 AND chain_id = $3`,
        [wallet.user_id, transfer.hash, chainId]
      );

      console.log(`[blockScanner] Auto-credited ${amountFula} FULA to user ${wallet.user_id} from tx ${transfer.hash}`);
    }

    return true;
  } catch (error) {
    console.error(`[blockScanner] Error processing transfer ${transfer.hash}:`, error);
    return false;
  }
}

// Update the last scanned block for a chain
async function updateLastScannedBlock(chainId: number, blockNumber: number): Promise<void> {
  await query(
    `UPDATE chain_sync_state
     SET last_scanned_block = $1, last_scan_at = NOW()
     WHERE chain_id = $2`,
    [blockNumber, chainId]
  );
}

// Get enabled chains from database
export async function getEnabledChains(): Promise<ChainConfig[]> {
  const result = await query<{
    chainid: number;
    chainname: string;
    tokenaddress: string;
    vaultaddress: string;
    lastscannedblock: number;
    isenabled: number;
  }>(`
    SELECT chain_id as chainid, chain_name as chainname, token_address as tokenaddress,
           vault_address as vaultaddress, last_scanned_block as lastscannedblock, is_enabled as isenabled
    FROM chain_sync_state
    WHERE is_enabled = 1
  `);

  return result.rows.map(row => ({
    chainId: row.chainid,
    chainName: row.chainname,
    tokenAddress: row.tokenaddress,
    vaultAddress: row.vaultaddress,
    lastScannedBlock: row.lastscannedblock,
    isEnabled: row.isenabled === 1,
  }));
}

// Scan a single chain
export async function scanChain(chain: ChainConfig): Promise<{ processed: number; newTxs: number }> {
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
    const isNew = await processTransfer(chain.chainId, transfer);
    if (isNew) newTxs++;

    const blockNum = parseInt(transfer.blockNumber);
    if (blockNum > maxBlock) {
      maxBlock = blockNum;
    }
  }

  // Update last scanned block
  if (maxBlock > chain.lastScannedBlock) {
    await updateLastScannedBlock(chain.chainId, maxBlock);
  }

  return { processed: transfers.length, newTxs };
}

// Main scanner function
export async function runBlockScanner(): Promise<void> {
  console.log('[blockScanner] Starting block scan...');

  const chains = await getEnabledChains();

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
      const { processed, newTxs } = await scanChain(chain);
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

// Cron runner
let scanInterval: NodeJS.Timeout | null = null;
let isScanning = false;

export function startBlockScanner(intervalMs: number = 10 * 60 * 1000): void {
  if (scanInterval) {
    console.warn('[blockScanner] Scanner already running');
    return;
  }

  // Run immediately on start
  isScanning = true;
  runBlockScanner()
    .catch(err => console.error('[blockScanner] Error:', err))
    .finally(() => { isScanning = false; });

  // Then run at interval
  scanInterval = setInterval(async () => {
    if (isScanning) {
      console.log('[blockScanner] Previous scan still running, skipping');
      return;
    }
    isScanning = true;
    try {
      await runBlockScanner();
    } catch (err) {
      console.error('[blockScanner] Error:', err);
    } finally {
      isScanning = false;
    }
  }, intervalMs);

  console.log(`[blockScanner] Started with interval: ${intervalMs}ms`);
}

export function stopBlockScanner(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
    console.log('[blockScanner] Stopped');
  }
}
