#!/usr/bin/env npx tsx
/**
 * x402 Delete Test Script
 *
 * Tests the free delete flow:
 * 1. Sign wallet identity proof (EIP-712, same as download — value=0)
 * 2. GET the file — verify it exists (200)
 * 3. DELETE the file with X-PAYMENT header (free, wallet verified)
 * 4. GET the file again — verify it's gone (404)
 *
 * Usage:
 *   npx tsx scripts/test-x402-delete.ts <private-key> <bucket> <key> [endpoint]
 *
 * Example:
 *   npx tsx scripts/test-x402-delete.ts 0xac0974... test-bucket hello-world-1234.txt
 *   npx tsx scripts/test-x402-delete.ts 0xac0974... test-bucket hello-world-1234.txt http://localhost:4002
 *
 * Environment variables (optional):
 *   X402_ENDPOINT - Gateway URL (default: http://localhost:4002)
 *   PRIVATE_KEY - Wallet private key (alternative to command line)
 *   DEBUG - Set to "1" to show full payload details
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
    console.error('Usage: npx tsx scripts/test-x402-delete.ts <private-key> <bucket> <key> [endpoint]');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx scripts/test-x402-delete.ts 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 test-bucket hello-world-1234.txt');
    console.error('');
    console.error('The gateway verifies your wallet identity via EIP-712 signature.');
    console.error('Deletes are FREE — no payment is charged.');
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

async function getSigningParams(endpoint: string, bucket: string, key: string): Promise<SigningParams> {
  console.log('\n[Step 1] Getting signing parameters from server...');

  const response = await fetch(`${endpoint}/${bucket}/${key}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/plain',
      'X-Fula-TTL': '3600',
    },
    body: 'x',
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

async function createSignedPaymentHeader(
  privateKey: Hex,
  params: SigningParams,
  debug: boolean
): Promise<string> {
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

  const nonce = keccak256(
    encodePacked(
      ['address', 'uint256'],
      [account.address, BigInt(Date.now())]
    )
  );

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + 300;

  const domain = {
    name: params.tokenName,
    version: params.tokenVersion,
    chainId: params.chainId,
    verifyingContract: params.tokenAddress as Hex,
  };

  const message = {
    from: account.address,
    to: params.recipientAddress as Hex,
    value: BigInt(0),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as Hex,
  };

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
  return header;
}

// ============================================
// Main Flow
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('x402 Delete Test (Free — Wallet Identity Verification)');
  console.log('='.repeat(60));

  const cfg = parseArgs();
  const account = privateKeyToAccount(cfg.privateKey);

  console.log(`\nWallet: ${account.address}`);
  console.log(`Endpoint: ${cfg.endpoint}`);
  console.log(`File: ${cfg.bucket}/${cfg.key}`);
  console.log(`Debug: ${cfg.debug ? 'ON' : 'OFF'}`);

  try {
    // Step 1: Get signing parameters
    const params = await getSigningParams(cfg.endpoint, cfg.bucket, cfg.key);

    // Step 2: Verify file exists (GET)
    console.log('\n[Step 2] Verifying file exists (GET)...');
    const getHeader1 = await createSignedPaymentHeader(cfg.privateKey, params, false);
    const getRes1 = await fetch(`${cfg.endpoint}/${cfg.bucket}/${cfg.key}`, {
      method: 'GET',
      headers: { 'X-PAYMENT': getHeader1 },
    });

    console.log(`  GET status: ${getRes1.status}`);
    if (getRes1.status !== 200) {
      const text = await getRes1.text();
      console.error(`  File does not exist (or access denied): ${text}`);
      console.error('\n  Cannot test delete — file must exist first.');
      console.error('  Upload a file first with: npx tsx scripts/test-x402-upload.ts <key> [endpoint] [bucket]');
      process.exit(1);
    }
    const content = await getRes1.text();
    console.log(`  File exists (${content.length} bytes)`);

    // Step 3: Delete the file
    console.log('\n[Step 3] Deleting file (DELETE)...');
    const deleteHeader = await createSignedPaymentHeader(cfg.privateKey, params, cfg.debug);
    const deleteRes = await fetch(`${cfg.endpoint}/${cfg.bucket}/${cfg.key}`, {
      method: 'DELETE',
      headers: { 'X-PAYMENT': deleteHeader },
    });

    console.log(`  DELETE status: ${deleteRes.status}`);
    const deleteBody = await deleteRes.json();
    console.log(`  Response: ${JSON.stringify(deleteBody)}`);

    if (deleteRes.status !== 200) {
      console.error('\n  DELETE FAILED');
      process.exit(1);
    }

    // Step 4: Verify file is gone (GET should 404)
    console.log('\n[Step 4] Verifying file is gone (GET)...');
    const getHeader2 = await createSignedPaymentHeader(cfg.privateKey, params, false);
    const getRes2 = await fetch(`${cfg.endpoint}/${cfg.bucket}/${cfg.key}`, {
      method: 'GET',
      headers: { 'X-PAYMENT': getHeader2 },
    });

    console.log(`  GET status: ${getRes2.status}`);
    await getRes2.text(); // consume body

    console.log('\n' + '='.repeat(60));
    if (getRes2.status === 404 || getRes2.status === 403) {
      console.log('DELETE TEST: PASSED');
      console.log('='.repeat(60));
      console.log(`\n  File ${cfg.bucket}/${cfg.key} was successfully deleted.`);
      console.log('  No payment was charged — wallet identity verified via EIP-712 signature.');
    } else {
      console.log('DELETE TEST: FAILED');
      console.log('='.repeat(60));
      console.log(`\n  Expected 404 after delete, but got ${getRes2.status}.`);
      console.log('  The file may still exist.');
      process.exit(1);
    }
    console.log('='.repeat(60));

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
