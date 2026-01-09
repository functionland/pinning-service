---
layout: default
title: Networks
parent: Reference
nav_order: 2
---

# Supported Networks
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## FULA Token Networks

For adding credits via wallet deposits.

### Ethereum Mainnet

| Property | Value |
|:---------|:------|
| Chain ID | 1 |
| FULA Contract | `0x92217cCaEDBdbc54C76c15feA18823db1558fDc9` |
| Explorer | [etherscan.io](https://etherscan.io) |

### Base

| Property | Value |
|:---------|:------|
| Chain ID | 8453 |
| FULA Contract | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |
| Explorer | [basescan.org](https://basescan.org) |

### SKALE Europa

| Property | Value |
|:---------|:------|
| Chain ID | 2046399126 |
| FULA Contract | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |
| Explorer | [elated-tan-skat.explorer.mainnet.skalenodes.com](https://elated-tan-skat.explorer.mainnet.skalenodes.com) |

---

## x402 Payment Network

For pay-per-upload storage.

### SKALE Europa

| Property | Value |
|:---------|:------|
| Chain ID | 324705682 |
| Network ID (CAIP-2) | `eip155:324705682` |
| USDC Contract | Query `/health/pricing` endpoint |
| Gas Fees | **Zero** (gas-free network) |

### Why SKALE?

- **Zero gas fees** for token transfers
- Fast finality (~1 second)
- EVM compatible
- Decentralized

### Getting USDC on SKALE

1. Visit [bridge.skale.network](https://bridge.skale.network)
2. Connect your wallet
3. Select SKALE Europa as destination
4. Bridge USDC from Ethereum

---

## Network Configuration

### MetaMask - SKALE Europa

Add network manually:

| Field | Value |
|:------|:------|
| Network Name | SKALE Europa |
| RPC URL | `https://mainnet.skalenodes.com/v1/elated-tan-skat` |
| Chain ID | 2046399126 |
| Currency | sFUEL |
| Explorer | `https://elated-tan-skat.explorer.mainnet.skalenodes.com` |

### MetaMask - x402 SKALE Network

For x402 payments:

| Field | Value |
|:------|:------|
| Network Name | SKALE (x402) |
| RPC URL | Check with x402 gateway |
| Chain ID | 324705682 |

---

## Verifying Contracts

Always verify token contracts before sending:

### FULA Token

```javascript
// Ethereum
const FULA_ETH = '0x92217cCaEDBdbc54C76c15feA18823db1558fDc9';

// Base & SKALE Europa
const FULA_OTHER = '0x9e12735d77c72c5C3670636D428f2F3815d8A4cB';
```

### Vault Addresses

Get current vault addresses from the WebUI:
1. Go to Billing > Wallets
2. Link your wallet
3. View vault address for your network

---

## Chain ID Quick Reference

| Network | Chain ID | Use |
|:--------|:---------|:----|
| Ethereum | 1 | FULA deposits |
| Base | 8453 | FULA deposits |
| SKALE Europa (FULA) | 2046399126 | FULA deposits |
| SKALE Europa (x402) | 324705682 | x402 USDC payments |
