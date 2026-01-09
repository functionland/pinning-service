---
layout: default
title: Examples
parent: x402 Developers
nav_order: 6
---

# x402 Code Examples
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## curl Examples

### Get Payment Requirements

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/file.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 11" \
  -d "Hello World"
```

### Upload with Payment

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/file.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 11" \
  -H "X-Fula-TTL: 3600" \
  -H "X-PAYMENT: $PAYMENT_HEADER" \
  -d "Hello World"
```

### Download Content

```bash
curl "https://x402.api.cloud.fx.land/mybucket/file.txt" -o file.txt
```

### Check Pricing

```bash
curl "https://x402.api.cloud.fx.land/health/pricing" | jq
```

---

## JavaScript with @x402/client

Using the official x402 client library:

```javascript
import { x402 } from '@x402/client';
import { ethers } from 'ethers';

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

async function uploadFile(bucket, key, content) {
  const url = `https://x402.api.cloud.fx.land/${bucket}/${key}`;

  // x402 client handles the 402 flow automatically
  const response = await x402.fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Fula-TTL': '3600',
    },
    body: content,
    wallet: signer,
  });

  return response.json();
}

// Usage
const result = await uploadFile('mybucket', 'myfile.txt', 'Hello World');
console.log(`Uploaded: ${result.cid}`);
```

---

## JavaScript Manual Implementation

Without using the x402 client library:

```javascript
import { ethers } from 'ethers';

const BASE_URL = 'https://x402.api.cloud.fx.land';

async function getPaymentRequirements(bucket, key, content) {
  const response = await fetch(`${BASE_URL}/${bucket}/${key}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': content.length.toString(),
      'X-Fula-TTL': '3600',
    },
    body: content,
  });

  if (response.status !== 402) {
    throw new Error(`Expected 402, got ${response.status}`);
  }

  return response.json();
}

async function signPayment(requirements, signer) {
  const option = requirements.accepts[0];

  // Build EIP-712 typed data for USDC authorization
  const domain = {
    name: option.extra.name,
    version: option.extra.version,
    chainId: parseInt(option.network.split(':')[1]),
    verifyingContract: option.asset.split('/')[1].split(':')[1],
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const value = {
    from: await signer.getAddress(),
    to: option.payTo,
    value: option.maxAmountRequired,
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 300,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };

  const signature = await signer.signTypedData(domain, types, value);

  // Encode payment payload
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: option.network,
    payload: {
      signature,
      authorization: value,
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

async function uploadWithPayment(bucket, key, content, signer) {
  // Step 1: Get requirements
  const requirements = await getPaymentRequirements(bucket, key, content);

  // Step 2: Sign payment
  const payment = await signPayment(requirements, signer);

  // Step 3: Upload with payment
  const response = await fetch(`${BASE_URL}/${bucket}/${key}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': content.length.toString(),
      'X-Fula-TTL': '3600',
      'X-PAYMENT': payment,
    },
    body: content,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `Upload failed: ${response.status}`);
  }

  return response.json();
}

// Usage
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

const result = await uploadWithPayment(
  'mybucket',
  'myfile.txt',
  new TextEncoder().encode('Hello World'),
  signer
);

console.log(`CID: ${result.cid}`);
console.log(`Expires: ${result.expires_at}`);
console.log(`TX: ${result.tx_hash}`);
```

---

## Python Example

```python
import json
import base64
import requests
from eth_account import Account
from eth_account.messages import encode_typed_data

BASE_URL = 'https://x402.api.cloud.fx.land'

def get_payment_requirements(bucket: str, key: str, content: bytes) -> dict:
    response = requests.put(
        f'{BASE_URL}/{bucket}/{key}',
        headers={
            'Content-Type': 'application/octet-stream',
            'Content-Length': str(len(content)),
            'X-Fula-TTL': '3600',
        },
        data=content,
    )

    if response.status_code != 402:
        raise Exception(f'Expected 402, got {response.status_code}')

    return response.json()


def sign_payment(requirements: dict, private_key: str) -> str:
    option = requirements['accepts'][0]
    account = Account.from_key(private_key)

    chain_id = int(option['network'].split(':')[1])
    token_address = option['asset'].split('/')[1].split(':')[1]

    import secrets
    nonce = '0x' + secrets.token_hex(32)
    valid_before = int(__import__('time').time()) + 300

    # EIP-712 typed data
    typed_data = {
        'types': {
            'EIP712Domain': [
                {'name': 'name', 'type': 'string'},
                {'name': 'version', 'type': 'string'},
                {'name': 'chainId', 'type': 'uint256'},
                {'name': 'verifyingContract', 'type': 'address'},
            ],
            'TransferWithAuthorization': [
                {'name': 'from', 'type': 'address'},
                {'name': 'to', 'type': 'address'},
                {'name': 'value', 'type': 'uint256'},
                {'name': 'validAfter', 'type': 'uint256'},
                {'name': 'validBefore', 'type': 'uint256'},
                {'name': 'nonce', 'type': 'bytes32'},
            ],
        },
        'primaryType': 'TransferWithAuthorization',
        'domain': {
            'name': option['extra']['name'],
            'version': option['extra']['version'],
            'chainId': chain_id,
            'verifyingContract': token_address,
        },
        'message': {
            'from': account.address,
            'to': option['payTo'],
            'value': int(option['maxAmountRequired']),
            'validAfter': 0,
            'validBefore': valid_before,
            'nonce': nonce,
        },
    }

    signable = encode_typed_data(full_message=typed_data)
    signed = account.sign_message(signable)

    payload = {
        'x402Version': 1,
        'scheme': 'exact',
        'network': option['network'],
        'payload': {
            'signature': signed.signature.hex(),
            'authorization': typed_data['message'],
        },
    }

    return base64.b64encode(json.dumps(payload).encode()).decode()


def upload_with_payment(bucket: str, key: str, content: bytes, private_key: str) -> dict:
    # Get requirements
    requirements = get_payment_requirements(bucket, key, content)

    # Sign payment
    payment = sign_payment(requirements, private_key)

    # Upload
    response = requests.put(
        f'{BASE_URL}/{bucket}/{key}',
        headers={
            'Content-Type': 'application/octet-stream',
            'Content-Length': str(len(content)),
            'X-Fula-TTL': '3600',
            'X-PAYMENT': payment,
        },
        data=content,
    )

    response.raise_for_status()
    return response.json()


# Usage
import os

result = upload_with_payment(
    'mybucket',
    'myfile.txt',
    b'Hello World',
    os.environ['PRIVATE_KEY']
)

print(f"CID: {result['cid']}")
print(f"Expires: {result['expires_at']}")
```

---

## Health Check

### Check Service Status

```bash
curl https://x402.api.cloud.fx.land/health
```

### Check Pricing

```javascript
async function getPricing() {
  const response = await fetch(
    'https://x402.api.cloud.fx.land/health/pricing'
  );
  return response.json();
}

const pricing = await getPricing();
console.log(`Base rate: ${pricing.basePricePerMbHour}`);
console.log(`Network: ${pricing.network}`);
```
