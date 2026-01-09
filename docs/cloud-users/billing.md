---
layout: default
title: Billing & Credits
parent: Cloud Users
nav_order: 4
---

# Billing & Credits
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Free Tier

Every account includes **500 MB** of free storage.

| Feature | Free Tier |
|:--------|:----------|
| Storage | 500 MB |
| Time Limit | None |
| API Access | Full |
| Performance | Standard |
| Credit Card | Not required |

---

## FULA Credits

Storage beyond 500 MB requires FULA credits.

### Pricing

| Storage | Cost |
|:--------|:-----|
| 1 GB / month | 3 FULA |

### How It Works

1. **Link a wallet** to your account
2. **Send FULA** tokens to the vault address
3. **Credits applied** automatically (within 10 minutes)
4. **Storage deducted** monthly from your balance

### Example

- You have 100 FULA credits
- You're storing 10 GB beyond free tier
- Monthly cost: 10 GB × 3 FULA = 30 FULA
- After one month: 100 - 30 = 70 FULA remaining

---

## Adding Credits

### Method 1: Automatic Wallet Deposits

The easiest way to add credits:

1. Go to **Billing** > **Wallets**
2. [Link your wallet]({{ site.baseurl }}/cloud-users/wallets/)
3. Send FULA tokens to the vault address
4. Wait ~10 minutes for automatic detection

The **block scanner** monitors the blockchain and credits your account when it sees your transfer.

### Method 2: Manual Claim

If automatic detection doesn't work:

1. Go to **Billing**
2. Click **Claim Transaction**
3. Enter:
   - Transaction hash
   - Chain ID
4. Click **Submit**

### Supported Networks

| Network | Chain ID | FULA Token Contract |
|:--------|:---------|:--------------------|
| Ethereum | 1 | `0x92217cCaEDBdbc54C76c15feA18823db1558fDc9` |
| Base | 8453 | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |
| SKALE Europa | 2046399126 | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |

---

## Viewing Your Balance

### In Dashboard

Go to **Billing** to see:
- **Current Balance**: FULA credits available
- **Storage Used**: Current usage
- **Free Tier**: 500 MB included
- **Status**: Active, Limited, or Suspended

### Via API

```bash
curl "https://cloud.fx.land/api/credits" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Response:
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

---

## Credit History

View all your transactions:

1. Go to **Billing**
2. Scroll to **Transaction History**

Each entry shows:
- **Type**: Deposit, Deduction, or Adjustment
- **Amount**: FULA added or removed
- **Balance After**: Running balance
- **Date**: When it happened
- **Reference**: Transaction hash or description

### Via API

```bash
curl "https://cloud.fx.land/api/credits/history?limit=20" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

---

## Monthly Deductions

Storage is billed monthly:

1. On the **1st of each month**, your usage is measured
2. **Cost calculated**: (Usage - Free Tier) × 3 FULA/GB
3. **Deducted** from your balance

### Example Monthly Calculation

| Item | Value |
|:-----|:------|
| Total Storage | 2.5 GB |
| Free Tier | 0.5 GB |
| Billable | 2.0 GB |
| Rate | 3 FULA/GB |
| **Monthly Cost** | **6 FULA** |

---

## Account Status

### Active

- Balance > 0 or within free tier
- All features available
- Normal operation

### Limited

- Balance = 0
- Exceeding free tier
- **Existing pins remain active**
- **New uploads blocked**

### Suspended

- Extended period at zero balance
- May require support contact

---

## What Happens at Zero Balance?

If your balance reaches zero and you exceed 500 MB:

1. **Existing pins stay safe** - We don't delete your content
2. **New pins blocked** - Returns "Insufficient Funds" error
3. **Add credits** to resume uploading
4. **Or delete pins** to get under 500 MB

---

## FAQ

### Do credits expire?

No. FULA credits never expire. They're only deducted when you use storage beyond the free tier.

### What if I delete pins?

Deleted pins reduce your storage usage. Your next monthly deduction will be lower.

### Can I get a refund?

Credits are non-refundable but never expire. Reduce usage to stop deductions.

### How do I know if my deposit worked?

1. Check the **Transaction History** in Billing
2. Balance should increase within 10 minutes
3. If not, use **Manual Claim** with the transaction hash

### Why was I charged more than expected?

Monthly deductions are based on average storage for the month. If you stored 10 GB for half the month and 5 GB for the other half, you're charged for ~7.5 GB.

---

## Comparing Pricing Options

| Option | Cost | Best For |
|:-------|:-----|:---------|
| Free Tier | $0 | Getting started, small projects |
| FULA Credits | 3 FULA/GB/month | Long-term, predictable storage |
| [x402 Pay-per-upload]({{ site.baseurl }}/x402-developers/) | $0.01/MB/hour | One-time uploads, temporary storage |
