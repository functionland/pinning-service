---
layout: default
title: FAQ
parent: Cloud Users
nav_order: 6
---

# Frequently Asked Questions
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Getting Started

### What is Fx.Land Cloud?

Fx.Land Cloud is a web-based dashboard for pinning content to IPFS. When you pin content, we store it on our infrastructure so it remains available on the IPFS network.

### Do I need to install anything?

No. The web dashboard works in your browser. For programmatic access, you can optionally use the IPFS CLI or our API.

### What's a CID?

A CID (Content Identifier) is a unique hash that identifies content on IPFS. It looks like `QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG` or `bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`.

### How do I get a CID?

1. Add your file to IPFS using [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) or a service like [web3.storage](https://web3.storage)
2. IPFS generates a unique CID for your content
3. Pin that CID on Fx.Land Cloud

---

## Account & Authentication

### How do I create an account?

Just sign in with Google at [cloud.fx.land](https://cloud.fx.land). Your account is created automatically on first sign-in.

### Why Google authentication only?

Google OAuth provides secure, reliable authentication without requiring you to create another password. We may add more options in the future.

### Can I use multiple Google accounts?

Yes, each Google account gets its own Fx.Land account with separate storage, credits, and pins.

### How do I delete my account?

Contact support to request account deletion. All your pins and data will be permanently removed.

---

## Storage & Pinning

### What does "pinning" mean?

Pinning tells IPFS nodes to keep content available. Without pinning, content may become unavailable when the original uploader goes offline.

### How long is content stored?

As long as you have it pinned and have sufficient credits. We don't delete content as long as you maintain your account.

### What happens if I delete a pin?

The content is unpinned from our servers. It may still exist on IPFS if pinned elsewhere, but we no longer guarantee its availability.

### Can I upload files directly?

Currently, you need to add files to IPFS first (via IPFS Desktop or another service) to get a CID, then pin that CID with us. Direct upload is on our roadmap.

### Why is my pin "queued" for a long time?

Possible reasons:
- High system load
- Large content taking time to fetch
- Content not found on the IPFS network

Wait a few minutes, or check if the CID is valid and available.

### Why did my pin fail?

Common reasons:
- The CID doesn't exist on any reachable IPFS node
- The content is only on an offline peer
- Invalid CID format
- Network timeout

---

## Billing & Credits

### Is there a free tier?

Yes! Every account gets **500 MB free** with no time limit or credit card required.

### How much does additional storage cost?

**3 FULA per GB per month**. FULA is a cryptocurrency token you can purchase or earn.

### What is FULA?

FULA is the native token of the Functionland ecosystem. It's used to pay for storage and other services.

### Where do I get FULA?

FULA is available on cryptocurrency exchanges. You can also earn it by contributing storage to the Fula network.

### Do credits expire?

No. FULA credits never expire and are only deducted when you use storage beyond the free tier.

### What happens if I run out of credits?

- Your existing pins remain active
- New pin requests are blocked
- Add credits or delete pins to continue

### Can I get a refund?

Credits are non-refundable but never expire.

---

## API & Integration

### What's the API URL?

`https://api.cloud.fx.land`

### Is it compatible with IPFS CLI?

Yes! Use the standard IPFS remote pinning commands:
```bash
ipfs pin remote service add fxland https://api.cloud.fx.land YOUR_API_KEY
```

### Where do I find my API key?

Go to **API Keys** in the dashboard to view or generate keys.

### What API specification do you follow?

We implement the [IPFS Pinning Service API Specification](https://ipfs.github.io/pinning-services-api-spec/) v1.0.0.

---

## Security & Privacy

### Is my content encrypted?

Content is stored as-is on IPFS. If you need privacy, encrypt your content before pinning.

### Who can see my content?

IPFS is a public network. Anyone with the CID can access the content. For private content, encrypt before uploading.

### How secure is my account?

We use Google OAuth for authentication, which provides industry-standard security. API keys are JWT tokens that can be revoked at any time.

### Do you store my Google password?

No. Google OAuth means you authenticate directly with Google. We only receive your email and basic profile.

---

## x402 & Advanced

### What is x402?

x402 is an HTTP payment protocol for pay-per-upload storage. Instead of maintaining credits, you pay for each upload with USDC cryptocurrency.

### Should I use x402 or FULA credits?

| Use FULA Credits When | Use x402 When |
|:----------------------|:--------------|
| Long-term storage | One-time uploads |
| Regular usage | No account wanted |
| Predictable billing | Wallet-based auth |

### What's the S3 backend?

Content is ultimately stored on our S3-compatible backend at `s3.cloud.fx.land`. This provides reliable, redundant storage. Documentation: [docs.fx.land/fula-api](https://docs.fx.land/fula-api)

---

## Troubleshooting

### I can't sign in

- Enable pop-ups for cloud.fx.land
- Enable cookies
- Try incognito mode
- Try a different browser

### My API key isn't working

- Check for extra spaces when copying
- Verify the key isn't revoked
- Use format `Authorization: Bearer YOUR_KEY`

### My deposit didn't arrive

- Wait 10-15 minutes for the block scanner
- Verify transaction is confirmed on-chain
- Use Manual Claim with the transaction hash
- Ensure you sent from a linked wallet to the correct vault

### Need more help?

Open an issue on [GitHub](https://github.com/functionland/pinning-service/issues) or contact support.
