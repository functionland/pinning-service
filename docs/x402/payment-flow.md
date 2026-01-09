---
layout: default
title: Payment Flow - x402 Gateway
---

# x402 Payment Flow

Complete walkthrough of the x402 payment protocol.

## Flow Overview

```
Client                          x402 Gateway              Facilitator
  |                                  |                         |
  |--PUT /:bucket/:key-------------->|                         |
  |  (no payment header)             |                         |
  |                                  |                         |
  |<--402 Payment Required-----------|                         |
  |  X-PAYMENT-REQUIRED header       |                         |
  |                                  |                         |
  |--Sign payment with wallet--------|                         |
  |                                  |                         |
  |--PUT /:bucket/:key-------------->|                         |
  |  X-PAYMENT header                |                         |
  |                                  |--POST /verify---------->|
  |                                  |<--valid-----------------|
  |                                  |                         |
  |                                  |--Upload to S3---------->|
  |                                  |<--Success---------------|
  |                                  |                         |
  |                                  |--POST /settle---------->|
  |                                  |<--Transaction hash------|
  |                                  |                         |
  |<--200 OK---------------------|                         |
  |  X-PAYMENT-RESPONSE header       |                         |
```

## Step 1: Initial Request

Send your upload request without payment to get the requirements:

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/myfile.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 1024" \
  -H "X-Fula-TTL: 3600" \
  -d "File content here"
```

## Step 2: Receive 402 Payment Required

The server responds with status 402 and payment requirements:

### Headers

```
HTTP/1.1 402 Payment Required
X-PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MSwi...
```

### Body

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:324705682",
      "maxAmountRequired": "10000",
      "payTo": "0xRecipientAddress...",
      "asset": "eip155:324705682/erc20:0xTokenAddress...",
      "description": "Storage: 0.01 MB for 1 hour",
      "mimeType": "application/octet-stream",
      "maxTimeoutSeconds": 300,
      "resource": "https://x402.api.cloud.fx.land/mybucket/myfile.txt",
      "extra": {
        "facilitatorUrl": "https://facilitator.dirtroad.dev",
        "name": "Bridged USDC (SKALE Bridge)",
        "version": "1"
      }
    }
  ],
  "error": "Payment Required"
}
```

### Payment Requirements Explained

| Field | Description |
|-------|-------------|
| `x402Version` | Protocol version (always 1) |
| `scheme` | Payment type (`exact` = exact amount required) |
| `network` | CAIP-2 network identifier |
| `maxAmountRequired` | Amount in smallest unit (microUSDC) |
| `payTo` | Recipient wallet address |
| `asset` | CAIP-19 asset identifier |
| `maxTimeoutSeconds` | Time to complete payment (300 = 5 minutes) |
| `extra.facilitatorUrl` | URL for payment verification/settlement |

## Step 3: Construct Payment

Create a payment payload following the x402 specification:

### Payment Structure

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "eip155:324705682",
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0xPayerAddress...",
      "to": "0xRecipientAddress...",
      "value": "10000",
      "validAfter": "0",
      "validBefore": "1705320300",
      "nonce": "0x..."
    }
  }
}
```

### Signing Requirements

The payment must be signed using EIP-712 typed data signing with:
- Domain separator for the USDC token contract
- Authorization struct fields

## Step 4: Send Payment

Retry your request with the signed payment:

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/myfile.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 1024" \
  -H "X-Fula-TTL: 3600" \
  -H "X-PAYMENT: eyJ4NDAyVmVyc2lvbiI6MSwi..." \
  -d "File content here"
```

### Alternative Header

You can also use:
```
Payment-Authorization: x402 eyJ4NDAyVmVyc2lvbiI6MSwi...
```

## Step 5: Verification

The gateway verifies your payment with the facilitator:

```
POST https://facilitator.dirtroad.dev/verify
{
  "paymentPayload": "<base64-payment>",
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:324705682",
    "maxAmountRequired": "10000",
    ...
  }
}
```

Verification checks:
- Signature is valid
- Amount meets requirement
- Payment hasn't expired
- Nonce hasn't been used

## Step 6: Upload Processing

If verification succeeds:
1. Content is uploaded to S3 backend
2. Ephemeral record created with TTL
3. CID computed for IPFS addressing

## Step 7: Settlement

After successful upload, payment is settled:

```
POST https://facilitator.dirtroad.dev/settle
{
  "paymentPayload": "<base64-payment>",
  "paymentRequirements": {...}
}
```

Settlement transfers USDC from payer to recipient on SKALE.

## Step 8: Success Response

### Headers

```
HTTP/1.1 200 OK
X-PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLC...
```

### Body

```json
{
  "success": true,
  "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  "bucket": "mybucket",
  "key": "myfile.txt",
  "size_bytes": 1024,
  "expires_at": "2024-01-15T11:30:00.000Z",
  "tx_hash": "0xabc123...",
  "gateway_url": "https://ipfs.cloud.fx.land/ipfs/QmYwAP..."
}
```

### X-PAYMENT-RESPONSE Decoded

```json
{
  "success": true,
  "transaction": "0xabc123...",
  "network": "eip155:324705682"
}
```

## Timeout Handling

Payment must complete within `maxTimeoutSeconds` (300 seconds = 5 minutes):

1. Receive 402 response
2. Sign payment
3. Submit payment
4. Wait for verification
5. Wait for upload
6. Wait for settlement

If any step takes too long, the payment may be rejected.

## Idempotency

Each payment has a unique nonce. If you need to retry:
- Same nonce = same payment (safe to retry)
- Different nonce = new payment (will charge again)

## Error Recovery

### Payment Rejected

If verification fails, you'll receive a 402 with error details. Common issues:
- Insufficient balance
- Invalid signature
- Expired payment
- Nonce already used

### Upload Failed After Payment

If upload fails after payment verification:
- Payment is NOT settled
- Your funds are not transferred
- Retry with a new payment

### Settlement Failed

If settlement fails after successful upload:
- Content is still uploaded
- Payment status is logged
- Support can investigate the transaction

## Implementation Notes

### JavaScript Example

```javascript
import { createPayment } from '@x402/client';

// 1. Get payment requirements
const response = await fetch(url, { method: 'PUT', body: content });
if (response.status !== 402) throw new Error('Expected 402');

const requirements = await response.json();

// 2. Create payment
const payment = await createPayment({
  requirements: requirements.accepts[0],
  wallet: yourWallet,
});

// 3. Retry with payment
const result = await fetch(url, {
  method: 'PUT',
  headers: {
    'X-PAYMENT': payment.encoded,
    'X-Fula-TTL': '3600',
  },
  body: content,
});
```

### Manual Signing

If not using an x402 library, you need to:
1. Parse the EIP-712 domain from the token contract
2. Construct the authorization struct
3. Sign using `eth_signTypedData_v4`
4. Encode the result as base64
