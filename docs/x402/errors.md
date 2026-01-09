---
layout: default
title: Error Handling - x402 Gateway
---

# x402 Error Handling

Understanding and handling x402 payment errors.

## 402 Payment Required

The expected response when no payment is provided.

### Initial 402 (Get Requirements)

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:324705682",
    "maxAmountRequired": "10000",
    "payTo": "0x...",
    "asset": "eip155:324705682/erc20:0x..."
  }],
  "error": "Payment Required"
}
```

This is NOT an error - it's how you get payment requirements.

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
|-------|-------|----------|
| Invalid signature | Wrong signing method | Use EIP-712 typed data |
| Insufficient balance | Not enough USDC | Add USDC to your wallet |
| Nonce already used | Replay attack detected | Generate new nonce |
| Payment expired | Took too long | Create fresh payment |
| Wrong network | Different chain | Use SKALE Europa |
| Amount too low | Underpayment | Pay full `maxAmountRequired` |

## 400 Bad Request

Invalid request format.

### Missing Content-Length

```json
{
  "error": "BAD_REQUEST",
  "message": "Content-Length header required"
}
```

**Solution**: Always include `Content-Length` header.

### Invalid TTL

```json
{
  "error": "BAD_REQUEST",
  "message": "Invalid X-Fula-TTL value"
}
```

**Solution**: TTL must be a number between 60 and 2592000.

### Invalid Path

```json
{
  "error": "BAD_REQUEST",
  "message": "Invalid bucket or key"
}
```

**Solution**: Use valid bucket/key names (alphanumeric, hyphens, underscores).

## 413 Payload Too Large

Content exceeds size limits.

```json
{
  "error": "PAYLOAD_TOO_LARGE",
  "message": "Request body too large"
}
```

**Solution**: Reduce file size or use chunked upload.

## 500 Internal Server Error

Server-side issue.

```json
{
  "error": "INTERNAL_ERROR",
  "message": "An unexpected error occurred"
}
```

**What to do**:
1. Retry after a few seconds
2. Check service status
3. Contact support if persistent

## 503 Service Unavailable

Service temporarily down.

```json
{
  "error": "SERVICE_UNAVAILABLE",
  "message": "Service temporarily unavailable"
}
```

**What to do**: Wait and retry with exponential backoff.

## Error Handling Best Practices

### 1. Expect 402 on First Request

```javascript
async function uploadWithPayment(url, content) {
  // First request - get requirements
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': content.length,
    },
    body: content,
  });

  if (response.status !== 402) {
    throw new Error(`Unexpected status: ${response.status}`);
  }

  const requirements = await response.json();
  // ... sign and retry
}
```

### 2. Validate Payment Requirements

```javascript
function validateRequirements(requirements) {
  if (requirements.x402Version !== 1) {
    throw new Error('Unsupported x402 version');
  }

  if (!requirements.accepts?.length) {
    throw new Error('No payment options available');
  }

  const option = requirements.accepts[0];
  if (option.network !== 'eip155:324705682') {
    throw new Error('Unsupported network');
  }

  return option;
}
```

### 3. Handle Payment Rejection

```javascript
async function retryWithPayment(url, content, payment) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': content.length,
      'X-PAYMENT': payment.encoded,
    },
    body: content,
  });

  if (response.status === 402) {
    const error = await response.json();
    if (error.error === 'PAYMENT_INVALID') {
      throw new PaymentError('Payment rejected', error);
    }
    // Might need to pay more (price changed)
    throw new Error('Unexpected 402 after payment');
  }

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }

  return response.json();
}
```

### 4. Implement Retry Logic

```javascript
async function uploadWithRetry(url, content, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await uploadWithPayment(url, content);
    } catch (error) {
      if (error.status === 500 || error.status === 503) {
        // Retry server errors
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      throw error; // Don't retry client errors
    }
  }
  throw new Error('Max retries exceeded');
}
```

## Debugging Tips

### Check Payment Header Format

```bash
# Decode X-PAYMENT header
echo "YOUR_PAYMENT_HEADER" | base64 -d | jq .
```

### Verify Network Configuration

```bash
curl https://x402.api.cloud.fx.land/health/pricing | jq .network
# Should return "eip155:324705682"
```

### Test Without Payment

```bash
curl -v -X PUT "https://x402.api.cloud.fx.land/test/debug.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 4" \
  -d "test"
# Should return 402 with requirements
```

### Check Wallet Balance

Ensure your wallet has USDC on SKALE Europa before attempting payment.

## Support

If you encounter persistent errors:

1. Note the error message and code
2. Record the timestamp
3. Include request details (without sensitive data)
4. Contact support via GitHub issues
