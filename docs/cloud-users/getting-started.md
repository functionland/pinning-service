---
layout: default
title: Getting Started
parent: Cloud Users
nav_order: 1
---

# Getting Started with Fx.Land Cloud
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Prerequisites

- A Google account (for authentication)
- A web browser (Chrome, Firefox, Safari, or Edge)

---

## Step 1: Sign In

1. Go to [cloud.fx.land](https://cloud.fx.land)
2. Click **Sign in with Google**
3. Select your Google account
4. Authorize Fx.Land to access your basic profile info

{: .note }
> We only request access to your email and basic profile. We never access your files, contacts, or other Google data.

After signing in, you'll be redirected to your dashboard.

---

## Step 2: Explore the Dashboard

Your dashboard shows:

### Storage Overview

A visual indicator of your storage usage:
- **Used**: How much you've pinned
- **Free Tier**: 500 MB available to everyone
- **Credits**: Additional storage from FULA credits

### Recent Pins

Your most recently pinned content with:
- File name
- CID (Content Identifier)
- Status (queued, pinning, pinned, failed)
- Date created

### Quick Actions

- **Add Pin** - Pin new content
- **Get API Key** - For programmatic access
- **Add Credits** - Expand storage

---

## Step 3: Pin Your First Content

### Option A: Pin by CID

If you already have content on IPFS:

1. Click **Add Pin** or go to **My Pins**
2. Enter the CID (e.g., `QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG`)
3. Optionally add a name to remember it
4. Click **Pin**

### Option B: Upload via IPFS First

If you have a file on your computer:

1. Install [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) or use [web3.storage](https://web3.storage)
2. Add your file to IPFS to get a CID
3. Pin the CID on Fx.Land Cloud

{: .important }
> Fx.Land Cloud pins **existing** IPFS content by CID. To upload new files, first add them to IPFS, then pin the resulting CID.

---

## Step 4: Check Pin Status

After creating a pin, watch its status:

| Status | Icon | Meaning |
|:-------|:-----|:--------|
| **Queued** | ⏳ | Waiting in queue |
| **Pinning** | 🔄 | Fetching from IPFS network |
| **Pinned** | ✅ | Successfully stored |
| **Failed** | ❌ | Unable to pin (hover for details) |

Most pins complete within seconds to minutes, depending on:
- Content size
- Availability on the IPFS network
- Current queue length

---

## Step 5: Get an API Key (Optional)

For programmatic access or IPFS CLI integration:

1. Go to **API Keys** in the sidebar
2. Copy the default key, or
3. Click **Generate New Key** for a new one

Use with IPFS CLI:
```bash
ipfs pin remote service add fxland https://api.cloud.fx.land YOUR_API_KEY
ipfs pin remote add --service=fxland QmYourCID
```

---

## Understanding Your Free Tier

Every account includes **500 MB** of free storage:

- **No expiration** - Use it as long as you want
- **No credit card** - Completely free
- **Full features** - Same API access as paid users

### When You'll Need Credits

You need FULA credits when:
- Total pinned content exceeds 500 MB
- You want to ensure continued access

### What Happens at 500 MB

- Existing pins remain active
- New pin requests may return "Insufficient Funds"
- Delete pins to free space, or add credits

---

## Next Steps

<div class="service-cards">
  <div class="service-card">
    <h3><a href="{{ site.baseurl }}/cloud-users/pins/">Managing Pins</a></h3>
    <p>Learn to search, filter, and organize your pinned content.</p>
  </div>

  <div class="service-card">
    <h3><a href="{{ site.baseurl }}/cloud-users/api-keys/">API Keys</a></h3>
    <p>Set up programmatic access for your applications.</p>
  </div>

  <div class="service-card">
    <h3><a href="{{ site.baseurl }}/cloud-users/billing/">Billing & Credits</a></h3>
    <p>Understand pricing and add storage credits.</p>
  </div>
</div>

---

## Troubleshooting

### Can't Sign In

- **Pop-up blocked**: Allow pop-ups for cloud.fx.land
- **Cookies disabled**: Enable third-party cookies
- **Browser issue**: Try incognito mode or different browser

### Pin Stuck in Queued

- Normal during high load
- Check back in a few minutes
- Very large pins take longer

### Pin Failed

Common reasons:
- CID doesn't exist on IPFS
- Content only available on offline peer
- Invalid CID format

Try:
- Verify the CID is correct
- Ensure content is available on IPFS
- Check the error message for details
