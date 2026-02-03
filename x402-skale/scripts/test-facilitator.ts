#!/usr/bin/env npx tsx
/**
 * Facilitator Diagnostic Script
 *
 * Directly tests the facilitator endpoint to diagnose 500 errors.
 * This bypasses the gateway and calls the facilitator /verify endpoint directly.
 *
 * Usage:
 *   npx tsx scripts/test-facilitator.ts <private-key> <receiving-address> [chain-id] [token-address] [facilitator-url]
 *
 * Example (SKALE Calypso):
 *   npx tsx scripts/test-facilitator.ts 0xac0974... 0xYourReceivingAddress 1187947933 0x7F5373AE26c3E8FfC4c77b7255DF7eC1A9aF52a6
 *
 * Example (Base Sepolia - default x402 test chain):
 *   npx tsx scripts/test-facilitator.ts 0xac0974... 0xYourReceivingAddress 84532 0x036CbD53842c5426634e7929541eC2318f3dCF7e
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, type Hex, encodePacked, keccak256 } from 'viem';

// Known chain configurations
// Network names must match facilitator's supported networks
// Token names must match the token contract's name() function for EIP-712
const KNOWN_CHAINS: Record<number, { networkName: string; tokenName: string; tokenVersion: string; tokenAddress: string }> = {
  // Base Sepolia (x402 default test network)
  84532: {
    networkName: 'base-sepolia',
    tokenName: 'USD Coin',
    tokenVersion: '2',
    tokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  // SKALE Base (mainnet) - Chain ID 1187947933
  // Bridged USDC using FiatTokenV2_2 implementation
  1187947933: {
    networkName: 'skale-base',
    tokenName: 'Bridged USDC (SKALE Bridge)',
    tokenVersion: '1',
    tokenAddress: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
  },
  // SKALE Base Spolia (testnet) - Chain ID 324705682
  324705682: {
    networkName: 'skale-base-spolia',
    tokenName: 'USDC',
    tokenVersion: '1',
    tokenAddress: '0x7F5373AE26c3E8FfC4c77b7255DF7eC1A9aF52a6',
  },
};

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let privateKey = args[0];
  const receivingAddress = args[1] || '0xc2dc75e756029fe7b70f6d13160a436345ea91db';
  const chainId = parseInt(args[2] || '1187947933', 10);
  const tokenAddress = args[3] || KNOWN_CHAINS[chainId]?.tokenAddress || '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20';
  const tokenName = args[4] || KNOWN_CHAINS[chainId]?.tokenName || 'USD Coin';
  const tokenVersion = args[5] || KNOWN_CHAINS[chainId]?.tokenVersion || '2';
  const networkName = KNOWN_CHAINS[chainId]?.networkName || 'skale-base';
  const facilitatorUrl = args[6] || 'https://facilitator.payai.network';

  if (!privateKey) {
    console.error('Facilitator Diagnostic Script');
    console.error('');
    console.error('Usage:');
    console.error('  npx tsx scripts/test-facilitator.ts <private-key> <receiving-address> [chain-id] [token-address] [facilitator-url]');
    console.error('');
    console.error('Arguments:');
    console.error('  private-key       Your wallet private key (for signing test payment)');
    console.error('  receiving-address Your server RECEIVING_ADDRESS from .env');
    console.error('  chain-id          Chain ID (default: 1187947933 = SKALE Calypso)');
    console.error('  token-address     USDC token address on that chain');
    console.error('  facilitator-url   Facilitator URL (default: https://facilitator.dirtroad.dev)');
    console.error('');
    console.error('Examples:');
    console.error('  # SKALE Calypso (chain 1187947933)');
    console.error('  npx tsx scripts/test-facilitator.ts 0xYourPrivateKey 0xYourReceivingAddress');
    console.error('');
    console.error('  # Base Sepolia (chain 84532) - standard x402 test chain');
    console.error('  npx tsx scripts/test-facilitator.ts 0xYourPrivateKey 0xYourReceivingAddress 84532');
    process.exit(1);
  }

  if (!privateKey.startsWith('0x')) {
    privateKey = `0x${privateKey}`;
  }

  const amount = '10000'; // 0.01 USDC in microUSDC

  console.log('='.repeat(60));
  console.log('Facilitator Diagnostic Test');
  console.log('='.repeat(60));

  // Create wallet
  const account = privateKeyToAccount(privateKey as Hex);
  console.log(`\nWallet: ${account.address}`);
  console.log(`Facilitator: ${facilitatorUrl}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Network Name: ${networkName}`);
  console.log(`Token Name: ${tokenName}`);
  console.log(`Token Address: ${tokenAddress}`);
  console.log(`Receiving Address: ${receivingAddress}`);

  // Step 1: Check facilitator health
  console.log('\n[Step 1] Checking facilitator health...');
  try {
    const healthResponse = await fetch(`${facilitatorUrl}/health`);
    console.log(`  Status: ${healthResponse.status}`);
    if (healthResponse.ok) {
      const healthText = await healthResponse.text();
      console.log(`  Response: ${healthText}`);
    } else {
      console.log(`  Health check failed!`);
    }
  } catch (error) {
    console.log(`  Health check error: ${error instanceof Error ? error.message : error}`);
  }

  // Step 2: Check if facilitator supports our chain
  console.log('\n[Step 2] Checking facilitator capabilities...');
  try {
    const infoResponse = await fetch(`${facilitatorUrl}/`);
    if (infoResponse.ok) {
      const infoText = await infoResponse.text();
      console.log(`  Root response: ${infoText.substring(0, 200)}...`);
    }
  } catch (error) {
    console.log(`  Info check: ${error instanceof Error ? error.message : 'Not available'}`);
  }

  // Step 3: Create and sign a test payment
  console.log('\n[Step 3] Creating test payment...');

  const customChain = {
    id: chainId,
    name: `Chain ${chainId}`,
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

  const message = {
    from: account.address,
    to: receivingAddress as Hex,
    value: BigInt(amount),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as Hex,
  };

  // EIP-712 domain for EIP-3009 transferWithAuthorization
  // Must include verifyingContract (the token address)
  const domain = {
    name: tokenName,
    version: tokenVersion,
    chainId: chainId,
    verifyingContract: tokenAddress as Hex,
  };

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

  console.log('  Signing with EIP-712...');
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
    network: networkName,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: receivingAddress,
        value: amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  console.log('  Payment created successfully');
  console.log(`  From: ${account.address}`);
  console.log(`  To: ${receivingAddress}`);
  console.log(`  Amount: ${amount} microUSDC`);

  console.log('\n  Payment Payload (decoded):');
  console.log(JSON.stringify(paymentPayload, null, 2).split('\n').map(l => '    ' + l).join('\n'));

  // Step 4: Call facilitator /verify endpoint
  console.log('\n[Step 4] Calling facilitator /verify...');

  const paymentRequirements = {
    scheme: 'exact',
    network: networkName,
    maxAmountRequired: amount,
    resource: '*',
    description: 'Test payment',
    mimeType: 'application/octet-stream',
    payTo: receivingAddress,
    maxTimeoutSeconds: 300,
    asset: tokenAddress,
    extra: {
      name: tokenName,
      version: tokenVersion,
    },
  };

  // x402 spec: paymentPayload should be the JSON object, not base64
  const verifyBody = {
    paymentPayload: paymentPayload,
    paymentRequirements,
  };

  console.log('\n  Request body being sent to /verify:');
  console.log(JSON.stringify(verifyBody, null, 2).split('\n').map(l => '    ' + l).join('\n'));

  try {
    const response = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyBody),
    });

    console.log(`\n  Response Status: ${response.status}`);
    console.log(`  Response Headers:`);
    response.headers.forEach((value, key) => {
      console.log(`    ${key}: ${value}`);
    });

    const responseText = await response.text();
    console.log('\n  Response Body:');
    try {
      const responseJson = JSON.parse(responseText);
      console.log(JSON.stringify(responseJson, null, 2).split('\n').map(l => '    ' + l).join('\n'));
    } catch {
      console.log(`    ${responseText}`);
    }

    if (!response.ok) {
      console.log('\n[DIAGNOSIS] The facilitator returned an error.');
      console.log('  Possible causes:');
      console.log(`  1. Chain ${chainId} might not be supported by this facilitator`);
      console.log('  2. The token address might be incorrect');
      console.log('  3. The payment format might not match what the facilitator expects');
      console.log('  4. The facilitator might require specific setup for SKALE chains');

      console.log('\n  Suggested actions:');
      console.log('  - Try testing with Base Sepolia (chain 84532) to see if facilitator works at all');
      console.log('  - Check if the facilitator supports your chain');
      console.log('  - Consider using a different facilitator or self-hosting one');
      console.log('  - Check the x402 facilitator documentation: https://github.com/coinbase/x402');
    }

  } catch (error) {
    console.error('\n  Fetch error:', error instanceof Error ? error.message : error);
  }

  console.log('\n' + '='.repeat(60));
}

main();
