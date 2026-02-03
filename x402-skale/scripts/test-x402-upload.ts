#!/usr/bin/env npx tsx
/**
 * Real x402 Upload Test Script
 *
 * Tests the x402-only authentication flow by:
 * 1. Creating a "Hello World" file
 * 2. Signing an x402 payment with a real wallet
 * 3. Uploading the file using only x402 (no JWT)
 * 4. Displaying the result
 *
 * Usage:
 *   npx tsx scripts/test-x402-upload.ts <private-key> [endpoint] [bucket]
 *
 * Example:
 *   npx tsx scripts/test-x402-upload.ts 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 *   npx tsx scripts/test-x402-upload.ts 0xac0974... http://localhost:4002 test-bucket
 *
 * Environment variables (optional, override command line):
 *   X402_ENDPOINT - Gateway URL (default: http://localhost:4002)
 *   X402_BUCKET - Bucket name (default: test-bucket)
 *   PRIVATE_KEY - Wallet private key
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, type Hex, encodePacked, keccak256 } from 'viem';
import { skaleEuropaTestnet } from 'viem/chains';

// ============================================
// Configuration
// ============================================

interface Config {
  privateKey: Hex;
  endpoint: string;
  bucket: string;
  fileName: string;
  fileContent: string;
  ttlSeconds: number;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);

  // Get private key
  let privateKey = process.env.PRIVATE_KEY || args[0];
  if (!privateKey) {
    console.error('Error: Private key required');
    console.error('');
    console.error('Usage: npx tsx scripts/test-x402-upload.ts <private-key> [endpoint] [bucket]');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx scripts/test-x402-upload.ts 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    console.error('');
    process.exit(1);
  }

  // Ensure 0x prefix
  if (!privateKey.startsWith('0x')) {
    privateKey = `0x${privateKey}`;
  }

  return {
    privateKey: privateKey as Hex,
    endpoint: process.env.X402_ENDPOINT || args[1] || 'http://localhost:4002',
    bucket: process.env.X402_BUCKET || args[2] || 'test-bucket',
    fileName: `hello-world-${Date.now()}.txt`,
    fileContent: `Hello World from x402!\n\nTimestamp: ${new Date().toISOString()}\nThis file was uploaded using x402 payment only (no JWT required).`,
    ttlSeconds: 3600, // 1 hour
  };
}

// ============================================
// x402 Payment Signing (EIP-712)
// ============================================

// SKALE Europa chain (used for x402 payments)
const skaleEuropa = {
  id: 2046399126,
  name: 'SKALE Europa',
  network: 'skale-europa',
  nativeCurrency: { name: 'sFUEL', symbol: 'sFUEL', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://mainnet.skalenodes.com/v1/elated-tan-skat'] },
    public: { http: ['https://mainnet.skalenodes.com/v1/elated-tan-skat'] },
  },
};

// EIP-712 Domain for x402 payments
const EIP712_DOMAIN = {
  name: 'Bridged USDC (SKALE Bridge)',
  version: '1',
  chainId: 2046399126, // SKALE Europa mainnet
};

// EIP-712 Types for x402 payment
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

interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: Hex;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

/**
 * Sign an x402 payment using EIP-712
 */
async function signX402Payment(
  privateKey: Hex,
  recipientAddress: string,
  amountMicroUsdc: string
): Promise<string> {
  const account = privateKeyToAccount(privateKey);

  const walletClient = createWalletClient({
    account,
    chain: skaleEuropa as any,
    transport: http(),
  });

  // Generate random nonce
  const nonce = keccak256(
    encodePacked(
      ['address', 'uint256'],
      [account.address, BigInt(Date.now())]
    )
  );

  // Valid time window
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60; // 1 minute ago
  const validBefore = now + 300; // 5 minutes from now

  // EIP-712 message
  const message = {
    from: account.address,
    to: recipientAddress as Hex,
    value: BigInt(amountMicroUsdc),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as Hex,
  };

  console.log('  Signing payment with EIP-712...');
  console.log(`  From: ${account.address}`);
  console.log(`  To: ${recipientAddress}`);
  console.log(`  Amount: ${amountMicroUsdc} microUSDC ($${(parseInt(amountMicroUsdc) / 1_000_000).toFixed(6)})`);

  // Sign with EIP-712
  const signature = await walletClient.signTypedData({
    account,
    domain: EIP712_DOMAIN,
    types: PAYMENT_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  });

  // Build x402 payment payload
  const paymentPayload: PaymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: `eip155:${EIP712_DOMAIN.chainId}`,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: recipientAddress,
        value: amountMicroUsdc,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  // Base64 encode the payload
  return Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
}

// ============================================
// Upload Flow
// ============================================

interface UploadResult {
  success: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  paymentResponse?: unknown;
}

/**
 * Step 1: Get pricing info (optional 402 response)
 */
async function getPaymentRequirements(
  endpoint: string,
  bucket: string,
  key: string,
  contentLength: number,
  ttlSeconds: number
): Promise<{ requiredAmount: string; recipientAddress: string }> {
  console.log('\n[Step 1] Getting payment requirements...');

  const response = await fetch(`${endpoint}/${bucket}/${key}`, {
    method: 'PUT',
    headers: {
      'Content-Length': contentLength.toString(),
      'Content-Type': 'text/plain',
      'X-Fula-TTL': ttlSeconds.toString(),
    },
    body: '', // Empty body for pricing request
  });

  if (response.status !== 402) {
    throw new Error(`Expected 402 response, got ${response.status}`);
  }

  const paymentRequired = await response.json() as {
    x402Version: number;
    accepts: Array<{
      maxAmountRequired: string;
      payTo: string;
      network: string;
      asset: string;
    }>;
  };

  const accept = paymentRequired.accepts[0];
  console.log(`  Required: ${accept.maxAmountRequired} microUSDC`);
  console.log(`  Pay to: ${accept.payTo}`);
  console.log(`  Network: ${accept.network}`);
  console.log(`  Asset: ${accept.asset}`);

  return {
    requiredAmount: accept.maxAmountRequired,
    recipientAddress: accept.payTo,
  };
}

/**
 * Step 2: Upload with x402 payment
 */
async function uploadWithPayment(
  endpoint: string,
  bucket: string,
  key: string,
  content: string,
  ttlSeconds: number,
  paymentHeader: string
): Promise<UploadResult> {
  console.log('\n[Step 3] Uploading with x402 payment...');
  console.log(`  Bucket: ${bucket}`);
  console.log(`  Key: ${key}`);
  console.log(`  Size: ${content.length} bytes`);
  console.log(`  TTL: ${ttlSeconds} seconds`);

  const response = await fetch(`${endpoint}/${bucket}/${key}`, {
    method: 'PUT',
    headers: {
      'Content-Length': content.length.toString(),
      'Content-Type': 'text/plain',
      'X-Fula-TTL': ttlSeconds.toString(),
      'X-PAYMENT': paymentHeader,
      // Note: NO Authorization header - x402-only mode!
    },
    body: content,
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let body: unknown;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  // Parse X-PAYMENT-RESPONSE header if present
  let paymentResponse: unknown;
  const paymentResponseHeader = headers['x-payment-response'];
  if (paymentResponseHeader) {
    try {
      paymentResponse = JSON.parse(
        Buffer.from(paymentResponseHeader, 'base64').toString('utf-8')
      );
    } catch {
      paymentResponse = paymentResponseHeader;
    }
  }

  return {
    success: response.status >= 200 && response.status < 300,
    status: response.status,
    headers,
    body,
    paymentResponse,
  };
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('x402-only Upload Test');
  console.log('='.repeat(60));

  const config = parseArgs();

  // Get account info
  const account = privateKeyToAccount(config.privateKey);
  console.log(`\nWallet: ${account.address}`);
  console.log(`Endpoint: ${config.endpoint}`);
  console.log(`Bucket: ${config.bucket}`);
  console.log(`File: ${config.fileName}`);
  console.log(`Content length: ${config.fileContent.length} bytes`);

  try {
    // Step 1: Get payment requirements
    const { requiredAmount, recipientAddress } = await getPaymentRequirements(
      config.endpoint,
      config.bucket,
      config.fileName,
      config.fileContent.length,
      config.ttlSeconds
    );

    // Step 2: Sign payment
    console.log('\n[Step 2] Signing x402 payment...');
    const paymentHeader = await signX402Payment(
      config.privateKey,
      recipientAddress,
      requiredAmount
    );
    console.log(`  Payment header created (${paymentHeader.length} chars)`);

    // Step 3: Upload with payment
    const result = await uploadWithPayment(
      config.endpoint,
      config.bucket,
      config.fileName,
      config.fileContent,
      config.ttlSeconds,
      paymentHeader
    );

    // Display results
    console.log('\n' + '='.repeat(60));
    console.log('RESULT');
    console.log('='.repeat(60));

    if (result.success) {
      console.log('\n  STATUS: SUCCESS');
    } else {
      console.log('\n  STATUS: FAILED');
    }

    console.log(`  HTTP Status: ${result.status}`);

    console.log('\n  Response Body:');
    console.log(JSON.stringify(result.body, null, 4).split('\n').map(l => '    ' + l).join('\n'));

    if (result.paymentResponse) {
      console.log('\n  Payment Response (X-PAYMENT-RESPONSE):');
      console.log(JSON.stringify(result.paymentResponse, null, 4).split('\n').map(l => '    ' + l).join('\n'));
    }

    console.log('\n' + '='.repeat(60));

    if (result.success) {
      const body = result.body as { gateway_url?: string; cid?: string };
      console.log('\nFile uploaded successfully!');
      if (body.gateway_url) {
        console.log(`Gateway URL: ${body.gateway_url}`);
      }
      if (body.cid) {
        console.log(`CID: ${body.cid}`);
      }
      console.log(`\nThe file was uploaded using x402 payment only (no JWT).`);
      console.log(`User was auto-created with email: ${account.address.toLowerCase()}@walletpayment.fx.land`);
    } else {
      console.log('\nUpload failed. Check the error above.');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n  ERROR:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error('\n  Stack:', error.stack);
    }
    process.exit(1);
  }
}

main();
