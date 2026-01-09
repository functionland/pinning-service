---
layout: default
title: Wallet Linking
parent: Cloud Users
nav_order: 5
---

# Wallet Linking
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Why Link a Wallet?

Linking a blockchain wallet enables:
- **Automatic credit deposits** when you send FULA
- **Easy payments** directly from your wallet
- **Multi-chain support** (Ethereum, Base, SKALE)

---

## Supported Networks

| Network | Chain ID | FULA Token |
|:--------|:---------|:-----------|
| Ethereum Mainnet | 1 | `0x92217cCaEDBdbc54C76c15feA18823db1558fDc9` |
| Base | 8453 | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |
| SKALE Europa | 2046399126 | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |

---

## Linking Your Wallet

### Step 1: Go to Wallets

1. Sign in at [cloud.fx.land](https://cloud.fx.land)
2. Go to **Billing** > **Wallets**
3. Click **Connect Wallet**

### Step 2: Connect

1. Select your wallet (MetaMask, WalletConnect, etc.)
2. Approve the connection in your wallet

### Step 3: Sign Verification

1. A message will appear to sign
2. This proves you own the wallet
3. Sign the message in your wallet

The message format is:
```
Link wallet 0xYourAddress to you@example.com at 1705320000
```

### Step 4: Done!

Your wallet is now linked. You'll see:
- Wallet address
- Connected chain
- Vault address for deposits

---

## Sending FULA Credits

### Step 1: Get Vault Address

After linking your wallet:
1. View the **vault address** for your network
2. This is where you send FULA tokens

### Step 2: Send FULA

In your wallet:
1. Go to Send/Transfer
2. Select FULA token
3. Enter the vault address as recipient
4. Enter amount to deposit
5. Confirm transaction

### Step 3: Wait for Detection

The **block scanner** checks for new transfers every ~10 minutes:
1. Your transaction is confirmed on-chain
2. Scanner detects the transfer
3. Credits applied to your account

{: .note }
> Credits usually appear within 10-15 minutes. If not, use Manual Claim.

---

## Manual Claim

If automatic detection doesn't work:

### Via Dashboard

1. Go to **Billing**
2. Click **Claim Transaction**
3. Enter:
   - **Transaction Hash**: The tx hash from your wallet
   - **Chain ID**: The network you sent from
4. Click **Submit**

### Requirements

- Transaction must be confirmed on-chain
- Sender must be a wallet linked to your account
- Recipient must be the correct vault address
- Transaction not already claimed

---

## Viewing Linked Wallets

Go to **Billing** > **Wallets** to see:

| Column | Description |
|:-------|:------------|
| Address | Wallet address (truncated) |
| Network | Chain name |
| Vault | Where to send FULA |
| Linked | When you connected |

---

## Unlinking a Wallet

1. Go to **Billing** > **Wallets**
2. Find the wallet to remove
3. Click **Disconnect**
4. Confirm

{: .warning }
> After unlinking, deposits from that wallet won't be credited to your account.

---

## Multiple Wallets

You can link multiple wallets:
- Same wallet on different networks
- Different wallets on the same network
- All deposits credit the same account

---

## Troubleshooting

### "Signature Verification Failed"

- Make sure you're signing with the correct wallet
- The message must match exactly
- Timestamp must be recent (within 5 minutes)
- Try disconnecting and reconnecting

### Deposit Not Credited

1. **Check transaction**: Verify it's confirmed on-chain
2. **Wait 10+ minutes**: Block scanner runs periodically
3. **Use Manual Claim**: Enter transaction hash manually
4. **Verify wallet is linked**: Must be linked before deposit

### "Wallet Already Linked"

Each wallet can only be linked to one account. If you need to move it:
1. Sign in to the account it's linked to
2. Unlink the wallet
3. Sign in to your account
4. Link the wallet

### "Transaction Already Claimed"

This transaction was already credited. Check your balance - it should be there.

### Wrong Vault Address

If you sent to the wrong address:
- **Your funds may be lost**
- Contact support with transaction details
- Always double-check the vault address before sending

---

## Security Tips

### Do

- Verify the vault address matches what's shown in the dashboard
- Start with a small test amount
- Keep your wallet secure

### Don't

- Send from an exchange (use a personal wallet)
- Share your private keys
- Send large amounts without testing first
