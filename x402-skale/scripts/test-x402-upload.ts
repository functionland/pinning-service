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
  fileName: string;
  fileContent: string;
  ttlSeconds: number;
  debug: boolean;
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
    debug: process.env.DEBUG === '1' || args.includes('--debug'),
  };
}

// ============================================
// x402 Payment Signing (EIP-712)
// ============================================

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

interface PaymentRequirements {
  requiredAmount: string;
  recipientAddress: string;
  chainId: number;
  network: string;
  tokenName: string;
}

/**
 * Sign an x402 payment using EIP-712
 */
async function signX402Payment(
  privateKey: Hex,
  requirements: PaymentRequirements,
  debug: boolean = false
): Promise<{ paymentHeader: string; paymentPayload: PaymentPayload }> {
  const account = privateKeyToAccount(privateKey);

  // Create a custom chain definition for signing
  const customChain = {
    id: requirements.chainId,
    name: `Chain ${requirements.chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: ['http://localhost:8545'] },
    },
  };

  const walletClient = createWalletClient({
    account,
    chain: customChain as any,
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
    to: requirements.recipientAddress as Hex,
    value: BigInt(requirements.requiredAmount),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as Hex,
  };

  // EIP-712 Domain - dynamically set from server's 402 response
  const domain = {
    name: requirements.tokenName,
    version: '1',
    chainId: requirements.chainId,
  };

  console.log('  Signing payment with EIP-712...');
  console.log(`  From: ${account.address}`);
  console.log(`  To: ${requirements.recipientAddress}`);
  console.log(`  Amount: ${requirements.requiredAmount} microUSDC ($${(parseInt(requirements.requiredAmount) / 1_000_000).toFixed(6)})`);
  console.log(`  Chain ID: ${requirements.chainId}`);
  console.log(`  Token Name: ${requirements.tokenName}`);

  // Sign with EIP-712
  const signature = await walletClient.signTypedData({
    account,
    domain,
    types: PAYMENT_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  });

  // Build x402 payment payload
  const paymentPayload: PaymentPayload = {
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

  if (debug) {
    console.log('\n  [DEBUG] EIP-712 Domain:');
    console.log(JSON.stringify(domain, null, 2).split('\n').map(l => '    ' + l).join('\n'));
    console.log('\n  [DEBUG] EIP-712 Message:');
    console.log(JSON.stringify({
      from: message.from,
      to: message.to,
      value: message.value.toString(),
      validAfter: message.validAfter.toString(),
      validBefore: message.validBefore.toString(),
      nonce: message.nonce,
    }, null, 2).split('\n').map(l => '    ' + l).join('\n'));
    console.log('\n  [DEBUG] Payment Payload:');
    console.log(JSON.stringify(paymentPayload, null, 2).split('\n').map(l => '    ' + l).join('\n'));
  }

  // Base64 encode the payload
  const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
  return { paymentHeader, paymentPayload };
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
 * Step 1: Get pricing info (402 response)
 */
async function getPaymentRequirements(
  endpoint: string,
  bucket: string,
  key: string,
  contentLength: number,
  ttlSeconds: number
): Promise<PaymentRequirements> {
  console.log('\n[Step 1] Getting payment requirements...');

  // Create a dummy body of the right size to get accurate pricing
  const dummyBody = 'x'.repeat(contentLength);

  const response = await fetch(`${endpoint}/${bucket}/${key}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/plain',
      'X-Fula-TTL': ttlSeconds.toString(),
    },
    body: dummyBody,
  });

  if (response.status !== 402) {
    const text = await response.text();
    throw new Error(`Expected 402 response, got ${response.status}: ${text}`);
  }

  const paymentRequired = await response.json() as {
    x402Version: number;
    accepts: Array<{
      maxAmountRequired: string;
      payTo: string;
      network: string;
      asset: string;
      extra?: {
        name?: string;
        version?: string;
      };
    }>;
  };

  const accept = paymentRequired.accepts[0];

  // Extract chain ID from network string (e.g., "eip155:1187947933" -> 1187947933)
  const chainIdMatch = accept.network.match(/eip155:(\d+)/);
  if (!chainIdMatch) {
    throw new Error(`Invalid network format: ${accept.network}`);
  }
  const chainId = parseInt(chainIdMatch[1], 10);

  // Get token name from extra field or use default
  const tokenName = accept.extra?.name || 'USD Coin';

  console.log(`  Required: ${accept.maxAmountRequired} microUSDC`);
  console.log(`  Pay to: ${accept.payTo}`);
  console.log(`  Network: ${accept.network}`);
  console.log(`  Chain ID: ${chainId}`);
  console.log(`  Asset: ${accept.asset}`);
  console.log(`  Token Name: ${tokenName}`);

  return {
    requiredAmount: accept.maxAmountRequired,
    recipientAddress: accept.payTo,
    chainId,
    network: accept.network,
    tokenName,
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
  console.log(`Debug mode: ${config.debug ? 'ON' : 'OFF (use DEBUG=1 or --debug to enable)'}`);
  if (config.debug) {
    console.log('\n[DEBUG] Full configuration:');
    console.log(`  Endpoint: ${config.endpoint}`);
    console.log(`  Bucket: ${config.bucket}`);
    console.log(`  File: ${config.fileName}`);
    console.log(`  TTL: ${config.ttlSeconds} seconds`);
  }

  try {
    // Step 1: Get payment requirements (includes chain ID)
    const requirements = await getPaymentRequirements(
      config.endpoint,
      config.bucket,
      config.fileName,
      config.fileContent.length,
      config.ttlSeconds
    );

    // Step 2: Sign payment using chain ID from server
    console.log('\n[Step 2] Signing x402 payment...');
    const { paymentHeader, paymentPayload } = await signX402Payment(config.privateKey, requirements, config.debug);
    console.log(`  Payment header created (${paymentHeader.length} chars)`);

    if (config.debug) {
      console.log('\n  [DEBUG] Base64 Encoded Payment Header:');
      console.log(`    ${paymentHeader.substring(0, 100)}...`);
    }

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

      // Check for specific error patterns and provide helpful hints
      const bodyStr = JSON.stringify(result.body || {});
      if (bodyStr.includes('Facilitator verify failed') || bodyStr.includes('500')) {
        console.log('\n[HINT] The facilitator returned an error. This could mean:');
        console.log('  1. The chain ID might not be supported by the facilitator');
        console.log('  2. The USDC token address might be incorrect for this chain');
        console.log('  3. The facilitator service might be temporarily unavailable');
        console.log('  4. The payment payload format might not match the facilitator\'s expectations');
        console.log('\nTo debug, run with DEBUG=1 to see the exact payment payload being sent.');
        console.log('You can also check the facilitator status at: https://facilitator.dirtroad.dev/health');
      }

      process.exit(1);
    }

  } catch (error) {
    console.error('\n  ERROR:', error instanceof Error ? error.message : error);
    if (error instanceof Error) {
      // Show cause if available (Node.js fetch errors often have a cause)
      const cause = (error as any).cause;
      if (cause) {
        console.error('  Cause:', cause.message || cause);
        if (cause.code) console.error('  Code:', cause.code);
      }
      if (error.stack) {
        console.error('\n  Stack:', error.stack);
      }
    }
    console.error('\n  TIP: If running in WSL, try running this script directly on the server,');
    console.error('       or test with: curl -X PUT <endpoint>/<bucket>/<key> -H "Content-Length: 100"');
    process.exit(1);
  }
}

main();
