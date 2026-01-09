---
layout: default
title: Home
nav_order: 1
permalink: /
---

<div class="hero">
  <h1>Fx.Land Cloud Documentation</h1>
  <p>Decentralized storage infrastructure for IPFS pinning, pay-per-upload storage, and file management.</p>
</div>

## Choose Your Path

<div class="service-cards">
  <div class="service-card">
    <div class="card-icon">👤</div>
    <h3><a href="{{ site.baseurl }}/cloud-users/">Cloud Users</a></h3>
    <p>Using cloud.fx.land to manage your files, API keys, and billing. No coding required.</p>
    <a href="{{ site.baseurl }}/cloud-users/" class="card-link">Get Started →</a>
  </div>

  <div class="service-card">
    <div class="card-icon">📌</div>
    <h3><a href="{{ site.baseurl }}/pinning-api/">Pinning API Developers</a></h3>
    <p>Building apps with the IPFS Pinning Service API at api.cloud.fx.land.</p>
    <a href="{{ site.baseurl }}/pinning-api/" class="card-link">View API Docs →</a>
  </div>

  <div class="service-card">
    <div class="card-icon">💳</div>
    <h3><a href="{{ site.baseurl }}/x402-developers/">x402 Developers</a></h3>
    <p>Integrating pay-per-upload storage with USDC micropayments on SKALE.</p>
    <a href="{{ site.baseurl }}/x402-developers/" class="card-link">Learn x402 →</a>
  </div>
</div>

---

## Services Overview

| Service | URL | Description |
|:--------|:----|:------------|
| **Cloud Dashboard** | [cloud.fx.land](https://cloud.fx.land) | Web interface for managing pins, keys, and billing |
| **Pinning API** | [api.cloud.fx.land](https://api.cloud.fx.land) | OpenAPI-compliant IPFS pinning service |
| **x402 Gateway** | [x402.api.cloud.fx.land](https://x402.api.cloud.fx.land) | Pay-per-upload with HTTP 402 payments |
| **S3 Backend** | [s3.cloud.fx.land](https://s3.cloud.fx.land) | Object storage backend ([docs](https://docs.fx.land/fula-api)) |

---

## Quick Start

### For Cloud Users
{: .text-purple-000}

1. Go to [cloud.fx.land](https://cloud.fx.land)
2. Sign in with Google
3. Start pinning files - you get **500 MB free**

[Cloud User Guide]({{ site.baseurl }}/cloud-users/){: .btn .btn-purple }

### For Pinning API Developers
{: .text-blue-000}

```bash
curl -X POST "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cid": "QmYourCID", "name": "my-file"}'
```

[API Reference]({{ site.baseurl }}/pinning-api/endpoints/){: .btn .btn-blue }

### For x402 Developers
{: .text-yellow-000}

```bash
# First request returns 402 with payment requirements
curl -X PUT "https://x402.api.cloud.fx.land/bucket/file.txt" \
  -H "Content-Length: 1024" \
  -H "X-Fula-TTL: 3600"
```

[x402 Integration Guide]({{ site.baseurl }}/x402-developers/payment-flow/){: .btn }

---

## Key Features

- **500 MB Free** - Every account includes free storage, no credit card required
- **IPFS Compatible** - Standard Pinning Service API, works with IPFS CLI
- **Pay-as-you-go** - x402 payments or FULA credits, your choice
- **Multi-chain** - Support for Ethereum, Base, and SKALE networks
- **Zero Gas** - x402 uses SKALE for gas-free USDC payments

---

## Pricing

| Model | Rate | Best For |
|:------|:-----|:---------|
| **Free Tier** | 500 MB included | Getting started |
| **FULA Credits** | 3 FULA / GB / month | Long-term storage |
| **x402 Pay-per-upload** | $0.01 / MB / hour | One-time uploads |

[Learn more about pricing]({{ site.baseurl }}/cloud-users/billing/){: .btn .btn-outline }
