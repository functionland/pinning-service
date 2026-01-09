---
layout: default
title: Error Handling
parent: x402 Developers
nav_order: 5
---

# x402 Error Handling
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## 402 Payment Required

### Initial 402 (Normal)

This is the expected response when no payment is provided:

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:324705682",
    "maxAmountRequired": "10000",
    "payTo": "0x..."
  }],
  "error": "Payment Required"
}
```

{: .note }
> This is NOT an error - it's how you get payment requirements.

### Payment Rejected 402

When your payment is invalid:

```json
{
  "error": "PAYMENT_INVALID",
  "message": "Invalid payment signature"
}
```

Or:

```json
{
  "error": "PAYMENT_VERIFICATION_FAILED",
  "message": "Facilitator verify failed: 400 Invalid signature"
}
```

### Common Payment Errors

| Error | Cause | Solution |
|:------|:------|:---------|
| Invalid signature | Wrong signing method | Use EIP-712 typed data |
| Insufficient balance | Not enough USDC | Add USDC to wallet |
| Nonce already used | Replay attack | Generate new nonce |
| Payment expired | Took too long | Create fresh payment |
| Wrong network | Different chain | Use SKALE Europa |
| Amount too low | Underpayment | Pay full amount |

---

## 400 Bad Request

### Missing Content-Length

```json
{
  "error": "BAD_REQUEST",
  "message": "Content-Length header required"
}
```

**Solution:** Always include `Content-Length` header.

### Invalid TTL

```json
{
  "error": "BAD_REQUEST",
  "message": "Invalid X-Fula-TTL value"
}
```

**Solution:** TTL must be between 60 and 2592000.

### Invalid Path

```json
{
  "error": "BAD_REQUEST",
  "message": "Invalid bucket or key"
}
```

**Solution:** Use valid bucket/key (alphanumeric, hyphens, underscores).

---

## 413 Payload Too Large

```json
{
  "error": "PAYLOAD_TOO_LARGE",
  "message": "Request body too large"
}
```

**Solution:** Reduce file size or use chunked upload.

---

## 500 Internal Server Error

```json
{
  "error": "INTERNAL_ERROR",
  "message": "An unexpected error occurred"
}
```

**Action:** Retry after a few seconds. Contact support if persistent.

---

## 503 Service Unavailable

```json
{
  "error": "SERVICE_UNAVAILABLE",
  "message": "Service temporarily unavailable"
}
```

**Action:** Wait and retry with exponential backoff.

---

## Handling Errors

### JavaScript Example

```javascript
async function uploadWithPayment(url, content, payment) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': content.length.toString(),
      'X-PAYMENT': payment,
    },
    body: content,
  });

  if (response.status === 402) {
    const error = await response.json();
    if (error.error === 'PAYMENT_INVALID') {
      throw new PaymentError('Payment rejected', error);
    }
    // Initial 402 - need to pay
    return { needsPayment: true, requirements: error };
  }

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}
```

### Retry Logic

```javascript
async function uploadWithRetry(url, content, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Get requirements
      const req1 = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': content.length.toString(),
        },
        body: content,
      });

      if (req1.status !== 402) {
        throw new Error('Expected 402');
      }

      const requirements = await req1.json();

      // Sign payment
      const payment = await signPayment(requirements);

      // Upload with payment
      const req2 = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': content.length.toString(),
          'X-PAYMENT': payment,
        },
        body: content,
      });

      if (req2.ok) {
        return req2.json();
      }

      if (req2.status >= 500) {
        // Retry on server errors
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }

      // Client error - don't retry
      throw new Error(`Upload failed: ${req2.status}`);

    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
    }
  }
}
```

---

## Debugging Tips

### Check Payment Header

```bash
# Decode X-PAYMENT to inspect
echo "YOUR_PAYMENT_HEADER" | base64 -d | jq .
```

### Verify Network

```bash
curl https://x402.api.cloud.fx.land/health/pricing | jq .network
# Should be "eip155:324705682"
```

### Test Without Payment

```bash
curl -v -X PUT "https://x402.api.cloud.fx.land/test/debug.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 4" \
  -d "test"
# Should return 402 with requirements
```

### Check Wallet

Ensure USDC balance on SKALE Europa before attempting payment.

---

## Support

For persistent errors:

1. Note the error message and code
2. Record the timestamp
3. Include request details (without signatures)
4. Open issue on [GitHub](https://github.com/functionland/pinning-service/issues)
