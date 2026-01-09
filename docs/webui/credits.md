---
layout: default
title: Credits & Billing - WebUI
---

# Credits & Billing

Understand storage costs and manage your FULA credits.

## Free Tier

Every account includes **500 MB** of free storage:

- No time limit
- No credit card required
- Full feature access

Check your usage in the dashboard or via API:

```bash
curl "https://cloud.fx.land/api/credits" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## FULA Credits

Storage beyond 500 MB requires FULA credits.

### Pricing

| Resource | Cost |
|----------|------|
| Storage | **3 FULA per GB per month** |

### How It Works

1. Link a blockchain wallet to your account
2. Transfer FULA tokens to the vault address
3. Credits are automatically applied to your account
4. Storage is deducted monthly from your balance

### Example

- You have 100 FULA credits
- You're storing 10 GB beyond the free tier
- Monthly cost: 10 GB × 3 FULA = 30 FULA
- After one month: 100 - 30 = 70 FULA remaining

## Adding Credits

### Method 1: Automatic Wallet Deposits

1. [Link your wallet](wallets/) to your account
2. Send FULA tokens to the vault address for your chain
3. The block scanner detects your transfer (within 10 minutes)
4. Credits are automatically added to your account

### Method 2: Manual Claim

If automatic detection doesn't work:

1. Go to **Billing** in the WebUI
2. Click **Claim Transaction**
3. Enter the transaction hash and chain ID
4. Submit to claim credits

### Supported Networks

| Network | Chain ID | Status |
|---------|----------|--------|
| Ethereum | 1 | Supported |
| Base | 8453 | Supported |
| SKALE Europa | 2046399126 | Supported |

Vault addresses are shown in the [Wallets](wallets/) section after linking.

## Viewing Balance

### In WebUI

1. Sign in at [cloud.fx.land](https://cloud.fx.land)
2. Go to **Billing** section
3. View your current balance and usage

### Via API

```bash
curl "https://cloud.fx.land/api/credits" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response:**
```json
{
  "email": "you@example.com",
  "balanceFula": 50.5,
  "totalDeposited": 100.0,
  "totalDeducted": 49.5,
  "isSuspended": false,
  "currentStorageBytes": 1073741824,
  "freeTierBytes": 524288000,
  "canUpload": true,
  "message": "Using paid storage. Balance: 50.50 FULA"
}
```

### Credit History

View all transactions:

```bash
curl "https://cloud.fx.land/api/credits/history?limit=20" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response:**
```json
[
  {
    "txType": "deposit",
    "amountFula": 50.0,
    "balanceAfter": 100.0,
    "referenceId": "0xabc123...",
    "createdAt": "2024-01-15T10:00:00.000Z"
  },
  {
    "txType": "deduction",
    "amountFula": -30.0,
    "balanceAfter": 70.0,
    "referenceId": "monthly-2024-02",
    "createdAt": "2024-02-01T00:00:00.000Z"
  }
]
```

## Account Status

### Active

- Balance > 0 or within free tier
- All features available

### Limited

- Balance = 0, exceeding free tier
- Existing pins remain active
- New uploads blocked

### Suspended

- Extended period with zero balance
- Contact support to resolve

## Storage Deductions

Storage costs are calculated monthly:

1. On the 1st of each month, usage is measured
2. Cost = (usage - free tier) × rate
3. Cost is deducted from your balance

If your balance goes negative, uploads are blocked until you add credits.

## Pricing API

Get current pricing information:

```bash
curl "https://cloud.fx.land/api/credits/pricing"
```

**Response:**
```json
{
  "freeTierBytes": 524288000,
  "freeTierMB": 500,
  "fulaPerGBMonth": 3,
  "supportedChains": [
    {
      "chainId": 1,
      "chainName": "Ethereum",
      "tokenAddress": "0x...",
      "vaultAddress": "0x..."
    }
  ]
}
```

## FAQ

### How long do credits last?

Credits don't expire. They're only deducted when you use storage beyond the free tier.

### What happens if I delete pins?

Deleted pins reduce your storage usage. Your next monthly deduction will be lower.

### Can I get a refund?

Credits are non-refundable but never expire.

### How do I check if my deposit was received?

1. Check transaction on blockchain explorer
2. Wait up to 10 minutes for block scanner
3. If not credited, use Manual Claim with transaction hash

### What if I run out of credits?

- Existing pins stay active
- New uploads are blocked
- Add credits to resume uploading
