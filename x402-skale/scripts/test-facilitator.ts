#!/usr/bin/env npx tsx
/**
 * Facilitator Diagnostic Script (Corbits x402 v1 Facilitator)
 *
 * Directly tests the Corbits facilitator endpoints to diagnose payment issues.
 * This bypasses the gateway and calls the facilitator endpoints directly.
 *
 * Documentation: https://x402.org
 * Facilitator URL: https://facilitator.corbits.dev
 *
 * Endpoints tested:
 *   GET  /supported - Query supported payment schemes and networks
 *   POST /accepts   - Enrich payment requirements with facilitator-specific details
 *   POST /verify    - Validate payment proofs without executing blockchain transactions
 *
 * Note: This script uses EIP-3009 (TransferWithAuthorization) for signing.
 * The Corbits v1 facilitator uses x402Version: 1 and paymentPayload as JSON.
 *
 * Usage:
 *   npx tsx scripts/test-facilitator.ts <private-key> [receiving-address] [chain-id] [token-address] [facilitator-url]
 *
 * Example (Base Sepolia - default x402 test chain):
 *   npx tsx scripts/test-facilitator.ts 0xac0974... 0xYourReceivingAddress 84532
 *
 * Example (SKALE Calypso):
 *   npx tsx scripts/test-facilitator.ts 0xac0974... 0xYourReceivingAddress 1187947933
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, type Hex, encodePacked, keccak256 } from 'viem';

// Known chain configurations
// Network names must match facilitator's supported networks
// Corbits uses EIP-155 format for SKALE chains: eip155:<chainId>
// Token names must match the token contract's name() function for EIP-712
const KNOWN_CHAINS: Record<number, { networkName: string; tokenName: string; tokenVersion: string; tokenAddress: string }> = {
  // Base Sepolia (x402 default test network)
  84532: {
    networkName: 'base-sepolia',
    tokenName: 'USD Coin',
    tokenVersion: '2',
    tokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  // Base Mainnet
  8453: {
    networkName: 'base',
    tokenName: 'USD Coin',
    tokenVersion: '2',
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  // SKALE Calypso (mainnet) - Chain ID 1187947933
  // Corbits uses EIP-155 format: eip155:1187947933
  1187947933: {
    networkName: 'eip155:1187947933',
    tokenName: 'USDC',
    tokenVersion: '1',
    tokenAddress: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
  },
  // SKALE Calypso Testnet - Chain ID 324705682
  // Corbits uses EIP-155 format: eip155:324705682
  324705682: {
    networkName: 'eip155:324705682',
    tokenName: 'USDC',
    tokenVersion: '1',
    tokenAddress: '0x2e08028E3C4c2356572E096d8EF835cD5C6030bD',
  },
};

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let privateKey = args[0];
  const receivingAddress = args[1] || '0xc2dc75e756029fe7b70f6d13160a436345ea91db';
  const chainId = parseInt(args[2] || '84532', 10); // Default to Base Sepolia (supported by Corbits)
  const tokenAddress = args[3] || KNOWN_CHAINS[chainId]?.tokenAddress || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const tokenName = args[4] || KNOWN_CHAINS[chainId]?.tokenName || 'USD Coin';
  const tokenVersion = args[5] || KNOWN_CHAINS[chainId]?.tokenVersion || '2';
  // Default to EIP-155 format for unknown chains (e.g., eip155:12345)
  const networkName = args[6] || KNOWN_CHAINS[chainId]?.networkName || `eip155:${chainId}`;
  const facilitatorUrl = args[7] || 'https://facilitator.corbits.dev';

  if (!privateKey) {
    console.error('Facilitator Diagnostic Script (Corbits x402 v1)');
    console.error('');
    console.error('Usage:');
    console.error('  npx tsx scripts/test-facilitator.ts <private-key> [receiving-address] [chain-id] [token-address] [token-name] [token-version] [network-name] [facilitator-url]');
    console.error('');
    console.error('Arguments:');
    console.error('  private-key       Your wallet private key (for signing test payment)');
    console.error('  receiving-address Your server RECEIVING_ADDRESS (default: 0xc2dc75e756029fe7b70f6d13160a436345ea91db)');
    console.error('  chain-id          Chain ID (default: 84532 = Base Sepolia)');
    console.error('  token-address     USDC token address');
    console.error('  token-name        Token name for EIP-712 domain');
    console.error('  token-version     Token version for EIP-712 domain');
    console.error('  network-name      Network identifier (default: base-sepolia or eip155:<chainId>)');
    console.error('  facilitator-url   Facilitator URL (default: https://facilitator.corbits.dev)');
    console.error('');
    console.error('Examples:');
    console.error('  # Base Sepolia (chain 84532) - default, supported by Corbits');
    console.error('  npx tsx scripts/test-facilitator.ts 0xYourPrivateKey 0xYourReceivingAddress');
    console.error('');
    console.error('  # SKALE Calypso (chain 1187947933)');
    console.error('  npx tsx scripts/test-facilitator.ts 0xYourPrivateKey 0xYourReceivingAddress 1187947933');
    process.exit(1);
  }

  if (!privateKey.startsWith('0x')) {
    privateKey = `0x${privateKey}`;
  }

  const amount = '10000'; // 0.01 USDC in microUSDC

  console.log('='.repeat(60));
  console.log('Corbits x402 v1 Facilitator Diagnostic Test');
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

  // Step 1: Check supported networks via GET /supported
  console.log('\n[Step 1] Checking supported networks (GET /supported)...');
  let networkSupported = false;
  try {
    const supportedResponse = await fetch(`${facilitatorUrl}/supported`);
    console.log(`  Status: ${supportedResponse.status}`);
    if (supportedResponse.ok) {
      const supportedData = await supportedResponse.json() as { kinds: Array<{ scheme: string; network: string; x402Version: number }> };
      console.log(`  Supported configurations:`);
      for (const kind of supportedData.kinds || []) {
        const isMatch = kind.network === networkName;
        console.log(`    - ${kind.scheme} on ${kind.network} (v${kind.x402Version})${isMatch ? ' MATCH' : ''}`);
        if (isMatch) networkSupported = true;
      }
      if (!networkSupported) {
        console.log(`\n  WARNING: Network '${networkName}' is NOT in the supported list!`);
        console.log(`  The facilitator may not be able to process payments for this network.`);
      }
    } else {
      console.log(`  Failed to get supported networks`);
    }
  } catch (error) {
    console.log(`  Error: ${error instanceof Error ? error.message : error}`);
  }

  // Step 2: Get enriched payment requirements via POST /accepts
  console.log('\n[Step 2] Getting enriched requirements (POST /accepts)...');
  let enrichedRequirements: any = null;
  const acceptsBody = {
    x402Version: 1,
    accepts: [{
      scheme: 'exact',
      network: networkName,
      maxAmountRequired: amount,
      resource: 'https://cloud.fx.land/test',
      description: 'Test payment',
      mimeType: 'application/octet-stream',
      payTo: receivingAddress,
      maxTimeoutSeconds: 300,
      asset: tokenAddress,
    }],
  };

  console.log('  Request body:');
  console.log(JSON.stringify(acceptsBody, null, 2).split('\n').map(l => '    ' + l).join('\n'));

  try {
    const acceptsResponse = await fetch(`${facilitatorUrl}/accepts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(acceptsBody),
    });
    console.log(`\n  Status: ${acceptsResponse.status}`);

    const acceptsText = await acceptsResponse.text();
    try {
      const acceptsJson = JSON.parse(acceptsText);
      console.log('  Response:');
      console.log(JSON.stringify(acceptsJson, null, 2).split('\n').map(l => '    ' + l).join('\n'));

      if (acceptsJson.accepts && acceptsJson.accepts[0]) {
        enrichedRequirements = acceptsJson.accepts[0];
        console.log('\n  Got enriched requirements from facilitator');
        if (enrichedRequirements.extra) {
          console.log(`    EIP-712 Domain: name=${enrichedRequirements.extra.name}, version=${enrichedRequirements.extra.version}, chainId=${enrichedRequirements.extra.chainId}`);
        }
      }
    } catch {
      console.log(`  Response (raw): ${acceptsText}`);
    }
  } catch (error) {
    console.log(`  Error: ${error instanceof Error ? error.message : error}`);
  }

  // Step 3: Create and sign a test payment
  console.log('\n[Step 3] Creating test payment...');

  // Use enriched requirements from /accepts if available, otherwise fall back to defaults
  const effectiveTokenName = enrichedRequirements?.extra?.name || tokenName;
  const effectiveTokenVersion = enrichedRequirements?.extra?.version || tokenVersion;
  const effectiveChainId = enrichedRequirements?.extra?.chainId || chainId;
  const effectiveVerifyingContract = enrichedRequirements?.extra?.verifyingContract || tokenAddress;

  console.log(`  Using EIP-712 domain:`);
  console.log(`    name: ${effectiveTokenName}`);
  console.log(`    version: ${effectiveTokenVersion}`);
  console.log(`    chainId: ${effectiveChainId}`);
  console.log(`    verifyingContract: ${effectiveVerifyingContract}`);

  const customChain = {
    id: effectiveChainId,
    name: `Chain ${effectiveChainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.placeholder.local'] } },
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
  // Use values from enriched requirements if available
  const domain = {
    name: effectiveTokenName,
    version: effectiveTokenVersion,
    chainId: effectiveChainId,
    verifyingContract: effectiveVerifyingContract as Hex,
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

  // Build v1 payment payload (no 'accepted' wrapper)
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

  console.log('  Payment created successfully');
  console.log(`  From: ${account.address}`);
  console.log(`  To: ${receivingAddress}`);
  console.log(`  Amount: ${amount} microUSDC`);

  console.log('\n  Payment Payload (decoded):');
  console.log(JSON.stringify(paymentPayload, null, 2).split('\n').map(l => '    ' + l).join('\n'));

  // Step 4: Call facilitator /verify endpoint (POST /verify)
  console.log('\n[Step 4] Validating payment (POST /verify)...');

  // Use enriched requirements if available, otherwise construct from params
  const paymentRequirements = enrichedRequirements || {
    scheme: 'exact',
    network: networkName,
    maxAmountRequired: amount,
    resource: 'https://cloud.fx.land/test',
    description: 'Test payment',
    mimeType: 'application/octet-stream',
    payTo: receivingAddress,
    maxTimeoutSeconds: 300,
    asset: tokenAddress,
    extra: {
      name: effectiveTokenName,
      version: effectiveTokenVersion,
      chainId: effectiveChainId,
      verifyingContract: effectiveVerifyingContract,
    },
  };

  // v1 format: paymentPayload as JSON object
  const verifyBody = {
    x402Version: 1,
    paymentPayload,
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
      const responseJson = JSON.parse(responseText) as { isValid?: boolean; invalidReason?: string };
      console.log(JSON.stringify(responseJson, null, 2).split('\n').map(l => '    ' + l).join('\n'));

      if (responseJson.isValid === true) {
        console.log('\n  Payment validation SUCCESSFUL!');
        console.log('  The payment proof is valid and would be accepted by the facilitator.');
      } else if (responseJson.isValid === false) {
        console.log('\n  Payment validation FAILED');
        console.log(`  Reason: ${responseJson.invalidReason || 'Unknown'}`);
      }
    } catch {
      console.log(`    ${responseText}`);
    }

    if (!response.ok) {
      console.log('\n[DIAGNOSIS] The facilitator returned an HTTP error.');
      console.log('  Possible causes:');
      console.log(`  1. Network '${networkName}' might not be supported by this facilitator`);
      console.log('  2. The token address might be incorrect for this network');
      console.log('  3. The payment format might not match what the facilitator expects');
      console.log('  4. Missing or incorrect EIP-712 domain parameters');

      console.log('\n  Suggested actions:');
      console.log('  - Check Step 1 output to see which networks are supported');
      console.log('  - Try testing with Base Sepolia (chain 84532) which is commonly supported');
      console.log('  - Verify the token contract supports EIP-3009 transferWithAuthorization');
      console.log('  - Check the x402 documentation: https://x402.org');
    }

  } catch (error) {
    console.error('\n  Fetch error:', error instanceof Error ? error.message : error);
  }

  console.log('\n' + '='.repeat(60));
}

main();
