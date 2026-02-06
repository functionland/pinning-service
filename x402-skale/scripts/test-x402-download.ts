#!/usr/bin/env npx tsx
/**
 * x402 Download Test Script
 *
 * Downloads a file from the x402 gateway using wallet identity verification.
 * Creates a fresh EIP-712 signature (same structure as upload payment) but
 * the gateway verifies it locally without charging — downloads are free.
 *
 * Usage:
 *   npx tsx scripts/test-x402-download.ts <private-key> <bucket> <key> [endpoint]
 *
 * Example:
 *   npx tsx scripts/test-x402-download.ts 0xac0974... test-bucket hello-world-1234.txt
 *   npx tsx scripts/test-x402-download.ts 0xac0974... test-bucket hello-world-1234.txt http://localhost:4002
 *
 * Environment variables (optional):
 *   X402_ENDPOINT - Gateway URL (default: http://localhost:4002)
 *   PRIVATE_KEY - Wallet private key (alternative to command line)
 *   DEBUG - Set to "1" to show full payload details
 *
 * How it works:
 *   1. Client creates an EIP-712 TransferWithAuthorization signature (same as upload)
 *   2. Client sends GET request with X-PAYMENT header containing the signed payload
 *   3. Gateway verifies the signature locally (no facilitator call, no on-chain tx)
 *   4. Gateway looks up the wallet's API key and proxies the request to S3
 *   5. File content is returned — no payment is charged
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, type Hex, encodePacked, keccak256 } from 'viem';

// ============================================
// Configuration
// ============================================

interface Config {
  privateKey: Hex;
  endpoint: string;
  bucket: string;
  key: string;
  debug: boolean;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);

  let privateKey = process.env.PRIVATE_KEY || args[0];
  const bucket = args[1];
  const key = args[2];

  if (!privateKey || !bucket || !key) {
    console.error('Error: Private key, bucket, and key are required');
    console.error('');
    console.error('Usage: npx tsx scripts/test-x402-download.ts <private-key> <bucket> <key> [endpoint]');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx scripts/test-x402-download.ts 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 test-bucket hello-world-1234.txt');
    console.error('');
    console.error('The gateway verifies your wallet identity via EIP-712 signature.');
    console.error('Downloads are FREE — no payment is charged.');
    process.exit(1);
  }

  if (!privateKey.startsWith('0x')) {
    privateKey = `0x${privateKey}`;
  }

  return {
    privateKey: privateKey as Hex,
    endpoint: process.env.X402_ENDPOINT || args[3] || 'http://localhost:4002',
    bucket,
    key,
    debug: process.env.DEBUG === '1' || args.includes('--debug'),
  };
}

// ============================================
// EIP-712 Signing (wallet identity proof)
// ============================================

// Same EIP-712 types as upload — TransferWithAuthorization (EIP-3009)
const PAYMENT_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

interface SigningParams {
  tokenName: string;
  tokenVersion: string;
  chainId: number;
  tokenAddress: string;
  recipientAddress: string;
}

/**
 * Get signing parameters from the server's 402 response.
 * We trigger a 402 with a dummy PUT to read the EIP-712 domain config,
 * so the client signs with the exact same parameters the server expects.
 */
async function getSigningParams(endpoint: string, bucket: string, key: string): Promise<SigningParams> {
  console.log('\n[Step 1] Getting signing parameters from server...');

  const response = await fetch(`${endpoint}/${bucket}/${key}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/plain',
      'X-Fula-TTL': '3600',
    },
    body: 'x', // minimal body to trigger 402
  });

  if (response.status !== 402) {
    const text = await response.text();
    throw new Error(`Expected 402 response to read signing params, got ${response.status}: ${text}`);
  }

  const paymentRequired = await response.json() as {
    accepts: Array<{
      payTo: string;
      network: string;
      asset: string;
      extra?: { name?: string; version?: string; chainId?: number };
    }>;
  };

  const accept = paymentRequired.accepts[0];

  // Resolve chain ID (same multi-strategy as upload script)
  let chainId: number | undefined;
  const chainIdMatch = accept.network.match(/eip155:(\d+)/);
  if (chainIdMatch) chainId = parseInt(chainIdMatch[1], 10);
  if (!chainId && accept.extra?.chainId) chainId = accept.extra.chainId;
  if (!chainId && process.env.NETWORK_CHAIN_ID) chainId = parseInt(process.env.NETWORK_CHAIN_ID, 10);
  if (!chainId) throw new Error(`Could not resolve chain ID from network "${accept.network}"`);

  const params: SigningParams = {
    tokenName: accept.extra?.name || 'USD Coin',
    tokenVersion: accept.extra?.version || '2',
    chainId,
    tokenAddress: accept.asset,
    recipientAddress: accept.payTo,
  };

  console.log(`  Token: ${params.tokenName} v${params.tokenVersion}`);
  console.log(`  Chain ID: ${params.chainId}`);
  console.log(`  Token Address: ${params.tokenAddress}`);
  console.log(`  Recipient: ${params.recipientAddress}`);

  return params;
}

/**
 * Create a signed X-PAYMENT header for download (wallet identity proof).
 *
 * Uses the same EIP-712 structure as upload payments so the server can
 * verify it with the same code. The value is 0 (no payment) but the
 * signature proves wallet ownership.
 */
async function createSignedPaymentHeader(
  privateKey: Hex,
  params: SigningParams,
  debug: boolean
): Promise<string> {
  console.log('\n[Step 2] Signing wallet identity proof (EIP-712)...');

  const account = privateKeyToAccount(privateKey);

  const customChain = {
    id: params.chainId,
    name: `Chain ${params.chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://localhost:8545'] } },
  };

  const walletClient = createWalletClient({
    account,
    chain: customChain as any,
    transport: http(),
  });

  // Random nonce
  const nonce = keccak256(
    encodePacked(
      ['address', 'uint256'],
      [account.address, BigInt(Date.now())]
    )
  );

  // Time window (5 minutes)
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + 300;

  const domain = {
    name: params.tokenName,
    version: params.tokenVersion,
    chainId: params.chainId,
    verifyingContract: params.tokenAddress as Hex,
  };

  // Value is 0 — this is an identity proof, not a payment
  const message = {
    from: account.address,
    to: params.recipientAddress as Hex,
    value: BigInt(0),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as Hex,
  };

  console.log(`  Wallet: ${account.address}`);
  console.log(`  Value: 0 (identity proof, no payment)`);
  console.log(`  Valid: ${new Date(validAfter * 1000).toISOString()} → ${new Date(validBefore * 1000).toISOString()}`);

  const signature = await walletClient.signTypedData({
    account,
    domain,
    types: PAYMENT_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  });

  const paymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: `eip155:${params.chainId}`,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: params.recipientAddress,
        value: '0',
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  if (debug) {
    console.log('\n  [DEBUG] EIP-712 Domain:');
    console.log(JSON.stringify(domain, null, 2).split('\n').map(l => '    ' + l).join('\n'));
    console.log('\n  [DEBUG] Payment Payload:');
    console.log(JSON.stringify(paymentPayload, null, 2).split('\n').map(l => '    ' + l).join('\n'));
  }

  const header = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
  console.log(`  Header created (${header.length} chars)`);
  return header;
}

// ============================================
// Download
// ============================================

async function downloadFile(
  endpoint: string,
  bucket: string,
  key: string,
  paymentHeader: string
): Promise<void> {
  const url = `${endpoint}/${bucket}/${key}`;
  console.log(`\n[Step 3] Downloading file...`);
  console.log(`  GET ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-PAYMENT': paymentHeader,
    },
  });

  console.log(`  Status: ${response.status}`);

  // Show response headers
  const contentType = response.headers.get('content-type') || 'unknown';
  const contentLength = response.headers.get('content-length') || 'unknown';
  console.log(`  Content-Type: ${contentType}`);
  console.log(`  Content-Length: ${contentLength}`);

  if (response.status !== 200) {
    const errorText = await response.text();
    console.error(`\n  DOWNLOAD FAILED: ${response.status}`);
    console.error(`  Error: ${errorText}`);

    if (response.status === 403) {
      console.error('\n  [HINT] 403 Forbidden — possible causes:');
      console.error('  1. The wallet has no account on the S3 backend yet (upload first)');
      console.error('  2. The EIP-712 signature verification failed');
      console.error('  3. The file was uploaded by a different wallet');
    } else if (response.status === 404) {
      console.error('\n  [HINT] 404 Not Found — the file may not exist or may have expired');
    }

    process.exit(1);
  }

  // Read content
  const content = await response.text();

  console.log('\n' + '='.repeat(60));
  console.log('DOWNLOAD SUCCESS');
  console.log('='.repeat(60));
  console.log(`\n  File: ${bucket}/${key}`);
  console.log(`  Size: ${content.length} bytes`);
  console.log(`  Content-Type: ${contentType}`);

  // Display content (truncate if very large)
  const maxDisplay = 2000;
  if (content.length <= maxDisplay) {
    console.log(`\n  --- Content ---`);
    console.log(content.split('\n').map(l => '  ' + l).join('\n'));
    console.log(`  --- End ---`);
  } else {
    console.log(`\n  --- Content (first ${maxDisplay} chars of ${content.length}) ---`);
    console.log(content.substring(0, maxDisplay).split('\n').map(l => '  ' + l).join('\n'));
    console.log(`  ... (truncated)`);
    console.log(`  --- End ---`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Download completed successfully!');
  console.log('No payment was charged — wallet identity verified via EIP-712 signature.');
  console.log('='.repeat(60));
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('x402 Download Test (Free — Wallet Identity Verification)');
  console.log('='.repeat(60));

  const cfg = parseArgs();
  const account = privateKeyToAccount(cfg.privateKey);

  console.log(`\nWallet: ${account.address}`);
  console.log(`Endpoint: ${cfg.endpoint}`);
  console.log(`File: ${cfg.bucket}/${cfg.key}`);
  console.log(`Debug: ${cfg.debug ? 'ON' : 'OFF'}`);

  try {
    // Step 1: Get signing parameters from server's 402 response
    const params = await getSigningParams(cfg.endpoint, cfg.bucket, cfg.key);

    // Step 2: Sign wallet identity proof
    const paymentHeader = await createSignedPaymentHeader(cfg.privateKey, params, cfg.debug);

    // Step 3: Download with signed header
    await downloadFile(cfg.endpoint, cfg.bucket, cfg.key, paymentHeader);

  } catch (error) {
    console.error('\n  ERROR:', error instanceof Error ? error.message : error);
    if (error instanceof Error) {
      const cause = (error as any).cause;
      if (cause) {
        console.error('  Cause:', cause.message || cause);
        if (cause.code) console.error('  Code:', cause.code);
      }
    }
    process.exit(1);
  }
}

main();
