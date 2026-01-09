---
layout: default
title: Glossary
parent: Reference
nav_order: 3
---

# Glossary
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## A

### API Key
A JWT (JSON Web Token) used to authenticate requests to the Pinning API. Generated from the WebUI.

---

## B

### Bearer Token
Authentication method where the token is sent in the `Authorization` header: `Authorization: Bearer <token>`.

### Block Scanner
Background service that monitors blockchain for FULA transfers to vault addresses and automatically credits user accounts.

---

## C

### CAIP-2
Chain Agnostic Improvement Proposal for network identifiers. Format: `eip155:<chainId>`. Example: `eip155:324705682` for SKALE Europa.

### CAIP-19
Chain Agnostic Improvement Proposal for asset identifiers. Format: `eip155:<chainId>/erc20:<contract>`.

### CID (Content Identifier)
A unique hash identifying content on IPFS. Can be CIDv0 (starts with `Qm`) or CIDv1 (starts with `bafy`).

### Credits
FULA tokens deposited to pay for storage beyond the free tier.

---

## D

### Delegates
IPFS peers operated by the pinning service. Connecting to delegates speeds up content transfer.

### Deduction
Monthly removal of FULA credits based on storage usage beyond free tier.

---

## E

### EIP-712
Ethereum Improvement Proposal for typed structured data signing. Used by x402 for payment signatures.

### Ephemeral Object
Content stored via x402 with a time-to-live (TTL). Automatically deleted after expiration.

---

## F

### Facilitator
Third-party service that verifies and settles x402 payments on the SKALE network.

### Free Tier
500 MB of storage included with every account at no cost.

### FULA
Native token of the Functionland ecosystem. Used to pay for storage credits.

---

## G

### Gateway
HTTP endpoint for accessing IPFS content. Example: `https://ipfs.io/ipfs/<CID>`.

---

## I

### IPFS (InterPlanetary File System)
Peer-to-peer network for storing and sharing content using content addressing.

---

## J

### JWT (JSON Web Token)
Format used for API keys. Contains encoded claims (user identity, permissions) and a signature.

---

## M

### microUSDC
Smallest unit of USDC. 1 USDC = 1,000,000 microUSDC. Used in x402 payment calculations.

### Multiaddr
Multi-protocol address format used in IPFS. Example: `/ip4/192.168.1.1/tcp/4001/p2p/QmPeerId`.

---

## O

### Origins
List of IPFS peer addresses known to have content. Provided when creating a pin to speed up fetching.

---

## P

### Pin
Request to store content on the pinning service. Ensures content remains available on IPFS.

### Pin Status
Current state of a pin: `queued`, `pinning`, `pinned`, or `failed`.

### Pinning
Active process of fetching and storing content from the IPFS network.

---

## R

### Request ID
Unique identifier for a pin operation. Used to check status or delete pins.

---

## S

### Settlement
Final step in x402 payment where USDC is transferred from payer to recipient.

### SKALE
Layer 2 Ethereum scaling solution with zero gas fees. Used for x402 payments and FULA transfers.

---

## T

### TTL (Time-To-Live)
Duration for which x402-uploaded content is stored. Minimum 60 seconds, maximum 30 days.

---

## U

### USDC
USD Coin stablecoin. Used for x402 payments on SKALE network.

---

## V

### Vault Address
Blockchain address where FULA tokens are sent to add credits. Different per network.

### Verification
x402 step where the facilitator validates payment signature before content upload.

---

## W

### Wallet Linking
Connecting a blockchain wallet to your account to enable automatic credit deposits.

---

## X

### x402
HTTP payment protocol (HTTP 402 Payment Required). Enables pay-per-upload storage with cryptocurrency micropayments.

### X-PAYMENT
HTTP header containing the signed x402 payment payload.

### X-PAYMENT-REQUIRED
HTTP header in 402 responses containing payment requirements.

### X-PAYMENT-RESPONSE
HTTP header in success responses containing settlement confirmation.
