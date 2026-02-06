#!/usr/bin/env npx tsx
/**
 * x402 Cleanup Test Script
 *
 * Tests the full lifecycle: upload → download → expire → cleanup → verify gone.
 *
 * Steps:
 * 1. Upload a file with a very short TTL (60 seconds)
 * 2. Verify it's downloadable
 * 3. Check /health/detailed to see ephemeral object stats
 * 4. Wait for TTL to expire
 * 5. Trigger manual cleanup via POST /health/cleanup
 * 6. Verify the file is no longer downloadable (404)
 * 7. Check /health/detailed to confirm cleanup stats changed
 *
 * Usage:
 *   npx tsx scripts/test-cleanup.ts <private-key> [endpoint] [admin-token]
 *
 * Example:
 *   npx tsx scripts/test-cleanup.ts 0xac0974... https://x402.api.cloud.fx.land <admin-token>
 *
 * Environment variables (optional):
 *   X402_ENDPOINT - Gateway URL (default: http://localhost:4002)
 *   PRIVATE_KEY - Wallet private key
 *   S3_ADMIN_TOKEN - Admin token for triggering cleanup
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
  adminToken: string;
  ttlSeconds: number;
  debug: boolean;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);

  let privateKey = process.env.PRIVATE_KEY || args[0];
  if (!privateKey) {
    console.error('Error: Private key required');
    console.error('');
    console.error('Usage: npx tsx scripts/test-cleanup.ts <private-key> [endpoint] [admin-token]');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx scripts/test-cleanup.ts 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 https://x402.api.cloud.fx.land <admin-token>');
    process.exit(1);
  }

  if (!privateKey.startsWith('0x')) {
    privateKey = `0x${privateKey}`;
  }

  const adminToken = process.env.S3_ADMIN_TOKEN || args[2];
  if (!adminToken) {
    console.error('Error: Admin token required (for triggering cleanup)');
    console.error('  Pass as 3rd argument or set S3_ADMIN_TOKEN env var');
    process.exit(1);
  }

  return {
    privateKey: privateKey as Hex,
    endpoint: process.env.X402_ENDPOINT || args[1] || 'http://localhost:4002',
    bucket: 'test-cleanup-bucket',
    adminToken,
    ttlSeconds: 60, // 1 minute — shortest practical TTL
    debug: process.env.DEBUG === '1' || args.includes('--debug'),
  };
}

// ============================================
// EIP-712 Signing
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

interface PaymentRequirements {
  requiredAmount: string;
  recipientAddress: string;
  chainId: number;
  network: string;
  tokenName: string;
  tokenVersion: string;
  tokenAddress: string;
}

async function getPaymentRequirements(
  endpoint: string,
  bucket: string,
  key: string,
  contentLength: number,
  ttlSeconds: number
): Promise<PaymentRequirements> {
  const response = await fetch(`${endpoint}/${bucket}/${key}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/plain',
      'X-Fula-TTL': ttlSeconds.toString(),
    },
    body: 'x'.repeat(contentLength),
  });

  if (response.status !== 402) {
    const text = await response.text();
    throw new Error(`Expected 402, got ${response.status}: ${text}`);
  }

  const paymentRequired = await response.json() as {
    accepts: Array<{
      maxAmountRequired: string;
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

  return {
    requiredAmount: accept.maxAmountRequired,
    recipientAddress: accept.payTo,
    chainId,
    network: accept.network,
    tokenName: accept.extra?.name || 'USD Coin',
    tokenVersion: accept.extra?.version || '2',
    tokenAddress: accept.asset,
  };
}

async function signPayment(
  privateKey: Hex,
  requirements: PaymentRequirements
): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const customChain = {
    id: requirements.chainId,
    name: `Chain ${requirements.chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://localhost:8545'] } },
  };

  const walletClient = createWalletClient({
    account,
    chain: customChain as any,
    transport: http(),
  });

  const nonce = keccak256(
    encodePacked(['address', 'uint256'], [account.address, BigInt(Date.now())])
  );

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + 300;

  const domain = {
    name: requirements.tokenName,
    version: requirements.tokenVersion,
    chainId: requirements.chainId,
    verifyingContract: requirements.tokenAddress as Hex,
  };

  const message = {
    from: account.address,
    to: requirements.recipientAddress as Hex,
    value: BigInt(requirements.requiredAmount),
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

  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: requirements.recipientAddress,
        value: requirements.requiredAmount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Create a download identity header (value=0, for free download auth)
 */
async function signDownloadAuth(
  privateKey: Hex,
  requirements: PaymentRequirements
): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const customChain = {
    id: requirements.chainId,
    name: `Chain ${requirements.chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://localhost:8545'] } },
  };

  const walletClient = createWalletClient({
    account,
    chain: customChain as any,
    transport: http(),
  });

  const nonce = keccak256(
    encodePacked(['address', 'uint256'], [account.address, BigInt(Date.now())])
  );

  const now = Math.floor(Date.now() / 1000);

  const domain = {
    name: requirements.tokenName,
    version: requirements.tokenVersion,
    chainId: requirements.chainId,
    verifyingContract: requirements.tokenAddress as Hex,
  };

  const message = {
    from: account.address,
    to: requirements.recipientAddress as Hex,
    value: BigInt(0), // Free — identity proof only
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + 300),
    nonce: nonce as Hex,
  };

  const signature = await walletClient.signTypedData({
    account,
    domain,
    types: PAYMENT_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  });

  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: requirements.recipientAddress,
        value: '0',
        validAfter: (now - 60).toString(),
        validBefore: (now + 300).toString(),
        nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// ============================================
// Helpers
// ============================================

function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => {
    let remaining = seconds;
    const interval = setInterval(() => {
      process.stdout.write(`\r  Waiting... ${remaining}s remaining   `);
      remaining--;
      if (remaining < 0) {
        clearInterval(interval);
        process.stdout.write('\r  Wait complete.                    \n');
        resolve();
      }
    }, 1000);
  });
}

async function getHealthDetailed(endpoint: string): Promise<any> {
  const res = await fetch(`${endpoint}/health/detailed`);
  return res.json();
}

async function triggerCleanup(endpoint: string, adminToken: string): Promise<any> {
  const res = await fetch(`${endpoint}/health/cleanup`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${adminToken}` },
  });
  return res.json();
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('x402 Cleanup Test');
  console.log('='.repeat(60));

  const cfg = parseArgs();
  const account = privateKeyToAccount(cfg.privateKey);
  const fileName = `cleanup-test-${Date.now()}.txt`;
  const fileContent = `Cleanup test file.\nTimestamp: ${new Date().toISOString()}\nThis file should be auto-deleted after ${cfg.ttlSeconds}s.`;

  console.log(`\n  Wallet: ${account.address}`);
  console.log(`  Endpoint: ${cfg.endpoint}`);
  console.log(`  Bucket: ${cfg.bucket}`);
  console.log(`  File: ${fileName}`);
  console.log(`  TTL: ${cfg.ttlSeconds}s`);

  try {
    // ──────────────────────────────────────────
    // Step 1: Check initial state
    // ──────────────────────────────────────────
    console.log('\n[Step 1] Checking initial health state...');
    const healthBefore = await getHealthDetailed(cfg.endpoint);
    console.log(`  Active objects: ${healthBefore.ephemeralObjects?.total_active ?? 'N/A'}`);
    console.log(`  Expired objects: ${healthBefore.ephemeralObjects?.total_expired ?? 'N/A'}`);
    console.log(`  Deleted objects: ${healthBefore.ephemeralObjects?.total_deleted ?? 'N/A'}`);

    // ──────────────────────────────────────────
    // Step 2: Get payment requirements
    // ──────────────────────────────────────────
    console.log('\n[Step 2] Getting payment requirements...');
    const requirements = await getPaymentRequirements(
      cfg.endpoint, cfg.bucket, fileName, fileContent.length, cfg.ttlSeconds
    );
    console.log(`  Amount: ${requirements.requiredAmount} microUSDC`);
    console.log(`  Chain: ${requirements.network} (${requirements.chainId})`);

    // ──────────────────────────────────────────
    // Step 3: Upload file with payment
    // ──────────────────────────────────────────
    console.log('\n[Step 3] Uploading file with x402 payment...');
    const paymentHeader = await signPayment(cfg.privateKey, requirements);

    const uploadRes = await fetch(`${cfg.endpoint}/${cfg.bucket}/${fileName}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/plain',
        'X-Fula-TTL': cfg.ttlSeconds.toString(),
        'X-PAYMENT': paymentHeader,
      },
      body: fileContent,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`Upload failed: ${uploadRes.status} ${text}`);
    }

    const uploadBody = await uploadRes.json() as any;
    console.log(`  Upload SUCCESS: ${uploadBody.cid || 'no-cid'}`);
    console.log(`  Expires at: ${uploadBody.expires_at}`);

    // ──────────────────────────────────────────
    // Step 4: Verify file is downloadable
    // ──────────────────────────────────────────
    console.log('\n[Step 4] Verifying file is downloadable...');
    const downloadAuth = await signDownloadAuth(cfg.privateKey, requirements);

    const downloadRes = await fetch(`${cfg.endpoint}/${cfg.bucket}/${fileName}`, {
      method: 'GET',
      headers: { 'X-PAYMENT': downloadAuth },
    });

    if (downloadRes.status === 200) {
      const content = await downloadRes.text();
      console.log(`  Download SUCCESS (${content.length} bytes)`);
      const match = content === fileContent;
      console.log(`  Content match: ${match ? 'YES' : 'NO'}`);
    } else {
      const text = await downloadRes.text();
      console.log(`  Download FAILED: ${downloadRes.status} ${text}`);
    }

    // ──────────────────────────────────────────
    // Step 5: Check health — should show 1 more active object
    // ──────────────────────────────────────────
    console.log('\n[Step 5] Checking health after upload...');
    const healthAfterUpload = await getHealthDetailed(cfg.endpoint);
    console.log(`  Active objects: ${healthAfterUpload.ephemeralObjects?.total_active ?? 'N/A'}`);
    console.log(`  Expired objects: ${healthAfterUpload.ephemeralObjects?.total_expired ?? 'N/A'}`);

    // ──────────────────────────────────────────
    // Step 6: Wait for TTL to expire
    // ──────────────────────────────────────────
    const waitSeconds = cfg.ttlSeconds + 5; // extra 5s buffer
    console.log(`\n[Step 6] Waiting ${waitSeconds}s for TTL to expire...`);
    await sleep(waitSeconds);

    // ──────────────────────────────────────────
    // Step 7: Check health — should show expired object
    // ──────────────────────────────────────────
    console.log('\n[Step 7] Checking health after TTL expiry...');
    const healthAfterExpiry = await getHealthDetailed(cfg.endpoint);
    console.log(`  Active objects: ${healthAfterExpiry.ephemeralObjects?.total_active ?? 'N/A'}`);
    console.log(`  Expired objects: ${healthAfterExpiry.ephemeralObjects?.total_expired ?? 'N/A'}`);

    // ──────────────────────────────────────────
    // Step 8: Trigger manual cleanup
    // ──────────────────────────────────────────
    console.log('\n[Step 8] Triggering manual cleanup...');
    const cleanupResult = await triggerCleanup(cfg.endpoint, cfg.adminToken);
    console.log(`  Cleanup result: ${JSON.stringify(cleanupResult)}`);

    // ──────────────────────────────────────────
    // Step 9: Verify file is gone (404)
    // ──────────────────────────────────────────
    console.log('\n[Step 9] Verifying file is deleted (should be 404)...');
    // Need a fresh signature for the new download attempt
    const downloadAuth2 = await signDownloadAuth(cfg.privateKey, requirements);

    const verifyRes = await fetch(`${cfg.endpoint}/${cfg.bucket}/${fileName}`, {
      method: 'GET',
      headers: { 'X-PAYMENT': downloadAuth2 },
    });

    const verifyStatus = verifyRes.status;
    const verifyText = await verifyRes.text();

    if (verifyStatus === 404) {
      console.log(`  File correctly returns 404 — cleanup worked!`);
    } else {
      console.log(`  Unexpected status: ${verifyStatus}`);
      console.log(`  Body: ${verifyText.substring(0, 200)}`);
    }

    // ──────────────────────────────────────────
    // Step 10: Check final health stats
    // ──────────────────────────────────────────
    console.log('\n[Step 10] Final health check...');
    const healthFinal = await getHealthDetailed(cfg.endpoint);
    console.log(`  Active objects: ${healthFinal.ephemeralObjects?.total_active ?? 'N/A'}`);
    console.log(`  Expired objects: ${healthFinal.ephemeralObjects?.total_expired ?? 'N/A'}`);
    console.log(`  Deleted objects: ${healthFinal.ephemeralObjects?.total_deleted ?? 'N/A'}`);

    // ──────────────────────────────────────────
    // Summary
    // ──────────────────────────────────────────
    console.log('\n' + '='.repeat(60));
    console.log('CLEANUP TEST RESULTS');
    console.log('='.repeat(60));
    console.log(`  Upload:      SUCCESS`);
    console.log(`  Download:    ${downloadRes.status === 200 ? 'SUCCESS' : 'FAILED'}`);
    console.log(`  Cleanup:     ${cleanupResult.deleted > 0 ? 'SUCCESS' : cleanupResult.errors > 0 ? 'ERRORS' : 'NO EXPIRED OBJECTS FOUND'}`);
    console.log(`  After delete: ${verifyStatus === 404 ? 'CORRECTLY RETURNS 404' : `UNEXPECTED: ${verifyStatus}`}`);
    console.log('='.repeat(60));

    if (downloadRes.status === 200 && verifyStatus === 404) {
      console.log('\nCleanup lifecycle test PASSED!');
    } else {
      console.log('\nCleanup lifecycle test FAILED — review steps above.');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n  ERROR:', error instanceof Error ? error.message : error);
    if (error instanceof Error) {
      const cause = (error as any).cause;
      if (cause) console.error('  Cause:', cause.message || cause);
    }
    process.exit(1);
  }
}

main();
