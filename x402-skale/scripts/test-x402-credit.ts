#!/usr/bin/env npx tsx
/**
 * x402 Credit Top-Up Test Script
 *
 * Tests the POST /credit endpoint:
 * 1. POST /credit with no payment → get 402 with minimum amount
 * 2. Sign x402 payment for the required amount
 * 3. POST /credit with X-PAYMENT → get credit response
 * 4. Display credits added, new balance, tx hash
 *
 * Usage:
 *   npx tsx scripts/test-x402-credit.ts <private-key> [endpoint] [amount-micro-usdc]
 *
 * Example:
 *   npx tsx scripts/test-x402-credit.ts 0xac0974...
 *   npx tsx scripts/test-x402-credit.ts 0xac0974... http://localhost:4002
 *   npx tsx scripts/test-x402-credit.ts 0xac0974... http://localhost:4002 10000
 *
 * Environment variables (optional):
 *   X402_ENDPOINT - Gateway URL (default: http://localhost:4002)
 *   PRIVATE_KEY - Wallet private key (alternative to command line)
 *   DEBUG - Set to "1" to show full payload details
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, type Hex, encodePacked, keccak256 } from 'viem';

// Known network name → chain ID lookup
const KNOWN_NETWORKS: Record<string, number> = {
  'skale-base': 1187947933,
  'eip155:1187947933': 1187947933,
  'skale-base-testnet': 324705682,
  'eip155:324705682': 324705682,
  'skale-base-spolia': 324705682,
  'base-sepolia': 84532,
  'base': 8453,
};

// ============================================
// Configuration
// ============================================

interface Config {
  privateKey: Hex;
  endpoint: string;
  amountMicroUsdc: number | null; // null = use server minimum
  debug: boolean;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);

  let privateKey = process.env.PRIVATE_KEY || args[0];
  if (!privateKey) {
    console.error('Error: Private key required');
    console.error('');
    console.error('Usage: npx tsx scripts/test-x402-credit.ts <private-key> [endpoint] [amount-micro-usdc]');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx scripts/test-x402-credit.ts 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    console.error('');
    process.exit(1);
  }

  if (!privateKey.startsWith('0x')) {
    privateKey = `0x${privateKey}`;
  }

  const amountArg = args[2];

  return {
    privateKey: privateKey as Hex,
    endpoint: process.env.X402_ENDPOINT || args[1] || 'http://localhost:4002',
    amountMicroUsdc: amountArg ? parseInt(amountArg, 10) : null,
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

async function getPaymentRequirements(endpoint: string): Promise<PaymentRequirements> {
  console.log('\n[Step 1] Getting payment requirements from POST /credit...');

  const response = await fetch(`${endpoint}/credit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
      description?: string;
      extra?: { name?: string; version?: string; chainId?: number };
    }>;
  };

  const accept = paymentRequired.accepts[0];

  let chainId: number | undefined;
  const chainIdMatch = accept.network.match(/eip155:(\d+)/);
  if (chainIdMatch) chainId = parseInt(chainIdMatch[1], 10);
  if (!chainId) chainId = KNOWN_NETWORKS[accept.network];
  if (!chainId && accept.extra?.chainId) chainId = accept.extra.chainId;
  if (!chainId && process.env.NETWORK_CHAIN_ID) chainId = parseInt(process.env.NETWORK_CHAIN_ID, 10);
  if (!chainId) throw new Error(`Could not resolve chain ID from network "${accept.network}"`);

  const tokenName = accept.extra?.name || 'USD Coin';
  const tokenVersion = accept.extra?.version || '2';

  console.log(`  Description: ${accept.description}`);
  console.log(`  Minimum: ${accept.maxAmountRequired} microUSDC ($${(parseInt(accept.maxAmountRequired) / 1_000_000).toFixed(6)})`);
  console.log(`  Pay to: ${accept.payTo}`);
  console.log(`  Network: ${accept.network}`);
  console.log(`  Chain ID: ${chainId}`);
  console.log(`  Token: ${tokenName} v${tokenVersion}`);

  return {
    requiredAmount: accept.maxAmountRequired,
    recipientAddress: accept.payTo,
    chainId,
    network: accept.network,
    tokenName,
    tokenVersion,
    tokenAddress: accept.asset,
  };
}

async function signPayment(
  privateKey: Hex,
  requirements: PaymentRequirements,
  amountMicroUsdc: string,
  debug: boolean
): Promise<string> {
  console.log('\n[Step 2] Signing x402 payment...');

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
    encodePacked(
      ['address', 'uint256'],
      [account.address, BigInt(Date.now())]
    )
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
    value: BigInt(amountMicroUsdc),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as Hex,
  };

  console.log(`  From: ${account.address}`);
  console.log(`  Amount: ${amountMicroUsdc} microUSDC ($${(parseInt(amountMicroUsdc) / 1_000_000).toFixed(6)})`);

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
    network: requirements.network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: requirements.recipientAddress,
        value: amountMicroUsdc,
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
  console.log(`  Payment header created (${header.length} chars)`);
  return header;
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('x402 Credit Top-Up Test');
  console.log('='.repeat(60));

  const cfg = parseArgs();
  const account = privateKeyToAccount(cfg.privateKey);

  console.log(`\nWallet: ${account.address}`);
  console.log(`Endpoint: ${cfg.endpoint}`);
  console.log(`Amount: ${cfg.amountMicroUsdc ? `${cfg.amountMicroUsdc} microUSDC` : '(use server minimum)'}`);
  console.log(`Debug: ${cfg.debug ? 'ON' : 'OFF'}`);

  try {
    // Step 1: Get payment requirements
    const requirements = await getPaymentRequirements(cfg.endpoint);

    // Determine amount to pay
    const amount = cfg.amountMicroUsdc
      ? cfg.amountMicroUsdc.toString()
      : requirements.requiredAmount;

    console.log(`\n  Paying: ${amount} microUSDC ($${(parseInt(amount) / 1_000_000).toFixed(6)})`);

    // Step 2: Sign payment
    const paymentHeader = await signPayment(cfg.privateKey, requirements, amount, cfg.debug);

    // Step 3: POST /credit with payment
    console.log('\n[Step 3] Sending credit top-up request...');
    const response = await fetch(`${cfg.endpoint}/credit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PAYMENT': paymentHeader,
      },
    });

    console.log(`  Status: ${response.status}`);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Parse X-PAYMENT-RESPONSE if present
    let paymentResponse: unknown;
    if (headers['x-payment-response']) {
      try {
        paymentResponse = JSON.parse(
          Buffer.from(headers['x-payment-response'], 'base64').toString('utf-8')
        );
      } catch {
        paymentResponse = headers['x-payment-response'];
      }
    }

    const body = await response.json() as Record<string, unknown>;

    // Display results
    console.log('\n' + '='.repeat(60));
    if (response.status === 200 && body.success) {
      console.log('CREDIT TOP-UP: SUCCESS');
      console.log('='.repeat(60));
      console.log(`\n  Credits Added: ${body.creditsAdded} FULA`);
      console.log(`  New Balance: ${body.newBalance} FULA`);
      console.log(`  Amount Paid: $${body.amountPaidUsdc} USDC`);
      console.log(`  TX Hash: ${body.tx_hash || '(pending)'}`);
      console.log(`  User: ${body.userEmail}`);

      if (paymentResponse) {
        console.log('\n  Payment Response (X-PAYMENT-RESPONSE):');
        console.log(JSON.stringify(paymentResponse, null, 4).split('\n').map(l => '    ' + l).join('\n'));
      }
    } else {
      console.log('CREDIT TOP-UP: FAILED');
      console.log('='.repeat(60));
      console.log('\n  Response:');
      console.log(JSON.stringify(body, null, 4).split('\n').map(l => '    ' + l).join('\n'));
    }
    console.log('\n' + '='.repeat(60));

    if (response.status !== 200) {
      process.exit(1);
    }

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
