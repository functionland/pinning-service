---
layout: default
title: Wallet Linking - WebUI
---

# Wallet Linking

Connect blockchain wallets to enable automatic credit deposits.

## Why Link a Wallet?

- **Automatic Credits**: Block scanner detects FULA transfers and credits your account
- **Easy Deposits**: Send tokens directly from your wallet
- **Multi-Chain Support**: Use Ethereum, Base, or SKALE

## Supported Networks

| Network | Chain ID | FULA Token |
|---------|----------|------------|
| Ethereum | 1 | 0x92217cCaEDBdbc54C76c15feA18823db1558fDc9 |
| Base | 8453 | 0x9e12735d77c72c5C3670636D428f2F3815d8A4cB |
| SKALE Europa | 2046399126 | 0x9e12735d77c72c5C3670636D428f2F3815d8A4cB |

## Linking a Wallet

### Via WebUI

1. Sign in at [cloud.fx.land](https://cloud.fx.land)
2. Go to **Billing** > **Wallets**
3. Click **Connect Wallet**
4. Select your wallet (MetaMask, WalletConnect, etc.)
5. Sign the verification message
6. Wallet is now linked

### Via API

```bash
curl -X POST "https://cloud.fx.land/api/wallets/connect" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "walletAddress": "0xYourWalletAddress",
    "chainId": 1,
    "signature": "0xYourSignature...",
    "message": "Link wallet 0xYourWalletAddress to you@example.com at 1705320000"
  }'
```

### Verification Message Format

The message you sign must follow this format:

```
Link wallet {address} to {email} at {timestamp}
```

- `{address}`: Your wallet address (checksummed)
- `{email}`: Your account email
- `{timestamp}`: Unix timestamp (seconds)

Sign using EIP-191 personal sign.

## Viewing Linked Wallets

### In WebUI

Go to **Billing** > **Wallets** to see all linked wallets.

### Via API

```bash
curl "https://cloud.fx.land/api/wallets" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response:**
```json
[
  {
    "address": "0x1234567890abcdef1234567890abcdef12345678",
    "chainId": 1,
    "isVerified": true,
    "connectedAt": "2024-01-15T10:30:00.000Z"
  }
]
```

## Depositing FULA

### Step 1: Get Vault Address

After linking your wallet, view the vault address for your network:

- In WebUI: **Billing** > **Wallets** > Click on your wallet
- Via API: Use `/api/credits/pricing` endpoint

### Step 2: Send FULA

Transfer FULA tokens to the vault address from your linked wallet.

### Step 3: Wait for Detection

The block scanner checks for new transfers approximately every 10 minutes:

- Scans blockchain explorers for transfers to vault
- Matches sender address to linked wallets
- Credits the corresponding account

### Step 4: Verify Credit

Check your balance in the WebUI or via API:

```bash
curl "https://cloud.fx.land/api/credits" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Manual Claiming

If automatic detection doesn't work (e.g., scanner delay, network issues):

### Via WebUI

1. Go to **Billing**
2. Click **Claim Transaction**
3. Enter:
   - Transaction hash
   - Chain ID
4. Submit

### Via API

```bash
curl -X POST "https://cloud.fx.land/api/credits/claim" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "txHash": "0xTransactionHash...",
    "chainId": 1
  }'
```

Requirements:
- Transaction must be confirmed on-chain
- Sender must be a wallet linked to your account
- Receiver must be the vault address
- Transaction must not have been claimed already

## Unlinking a Wallet

### Via WebUI

1. Go to **Billing** > **Wallets**
2. Find the wallet to remove
3. Click **Disconnect**

### Via API

```bash
curl -X DELETE "https://cloud.fx.land/api/wallets/0xYourWalletAddress" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

After unlinking:
- Future deposits from this wallet won't be credited
- Existing credits remain in your account

## Multiple Wallets

You can link multiple wallets:
- Different wallets on the same network
- Wallets on different networks
- All deposits credit the same account

## Troubleshooting

### "Signature verification failed"

- Ensure you're signing with the correct wallet
- Message format must match exactly
- Timestamp should be recent (within 5 minutes)

### Deposit not credited

1. Verify transaction is confirmed on-chain
2. Wait 10+ minutes for block scanner
3. Use Manual Claim with transaction hash

### "Wallet already linked"

Each wallet can only be linked to one account. If you need to move it:
1. Unlink from the other account
2. Link to this account

### "Transaction already claimed"

Each transaction can only be credited once. This error means the deposit was already processed.
