---
layout: default
title: Getting Started - WebUI
---

# Getting Started

Set up your Fx.Land Cloud account and pin your first file.

## Step 1: Sign In

1. Go to [cloud.fx.land](https://cloud.fx.land)
2. Click **Sign in with Google**
3. Select your Google account
4. Authorize Fx.Land to access your basic profile

After signing in, you'll see your dashboard.

## Step 2: Explore the Dashboard

The dashboard shows:

- **Storage Usage**: Current usage vs. available space (500 MB free)
- **Recent Pins**: Your most recently created pins
- **Quick Actions**: Links to common operations

### Navigation

- **Pins**: View and manage all your pins
- **API Keys**: Generate and manage access tokens
- **Billing**: View credits and add funds
- **Settings**: Account preferences

## Step 3: Pin Content

### Option A: Pin by CID

If you have content already on IPFS:

1. Go to **Pins** section
2. Click **Add Pin**
3. Enter the CID (e.g., `QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG`)
4. Optionally add a name
5. Click **Pin**

### Option B: Use the API

Get your API key and pin programmatically:

```bash
curl -X POST "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cid": "QmYourCID", "name": "my-file"}'
```

## Step 4: Check Pin Status

After creating a pin, it goes through these stages:

| Status | Meaning | What to do |
|--------|---------|------------|
| **queued** | Waiting to process | Wait a moment |
| **pinning** | Fetching from IPFS | May take minutes depending on content availability |
| **pinned** | Successfully stored | Content is safe |
| **failed** | Could not pin | Check error message, verify CID exists |

## Step 5: Get an API Key

For programmatic access:

1. Go to **API Keys** section
2. Copy the default key or click **Generate New Key**
3. Store the key securely

See [API Keys guide](api-keys/) for more details.

## Understanding Storage

### Free Tier

Every account gets **500 MB** free:
- No expiration
- No credit card required
- Full API access

### Storage Usage

Storage is calculated as the sum of all your pinned content. View your usage:

- **Dashboard**: Shows usage bar at the top
- **Billing**: Detailed breakdown

### Exceeding Free Tier

If you exceed 500 MB without credits:
- Existing pins remain active
- New pin requests may be rejected (409 Insufficient Funds)
- Add FULA credits to continue pinning

## Common Issues

### Pin stuck in "queued"

- The service processes pins in order
- During high load, queue times may increase
- Check back in a few minutes

### Pin failed

Common reasons:
- CID doesn't exist on IPFS network
- Content is only available on an unreachable peer
- Network timeout while fetching

Try:
- Verify the CID is correct
- Ensure the content is available from at least one online peer
- Add `origins` multiaddrs if you know where the content is

### Can't sign in

- Ensure pop-ups are allowed for cloud.fx.land
- Try a different browser
- Clear cookies and try again

## Next Steps

- [Manage API Keys](api-keys/) - Create keys for your applications
- [Add Credits](credits/) - Expand beyond 500 MB
- [Link Wallets](wallets/) - Enable automatic credit deposits
