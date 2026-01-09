---
layout: default
title: Managing Pins
parent: Cloud Users
nav_order: 2
---

# Managing Pins
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Viewing Your Pins

Go to **My Pins** in the sidebar to see all your pinned content.

### Pin List View

Each pin shows:
- **Name**: Human-readable name (if set)
- **CID**: Content Identifier (truncated, click to copy full)
- **Status**: Current state (queued, pinning, pinned, failed)
- **Size**: Content size (when known)
- **Created**: When you created the pin

### Sorting

Click column headers to sort by:
- Name (alphabetical)
- Created date (newest/oldest)
- Status
- Size

---

## Adding Pins

### Via Dashboard

1. Click **Add Pin** button
2. Enter the **CID** (required)
3. Enter a **Name** (optional but recommended)
4. Click **Pin**

### Pin Options

| Field | Required | Description |
|:------|:---------|:------------|
| CID | Yes | IPFS Content Identifier |
| Name | No | Human-readable label (max 255 chars) |

### What Happens Next

1. Pin enters **queued** status
2. Service fetches content from IPFS network
3. Once found, enters **pinning** status
4. When complete, shows **pinned** status

---

## Pin Status Explained

### Queued

Your pin request is received and waiting to be processed.

- **Normal wait time**: Seconds to a few minutes
- **During high load**: May take longer
- **Action needed**: None, just wait

### Pinning

The service is actively fetching your content from the IPFS network.

- **Duration**: Depends on content size and availability
- **Small files**: Usually seconds
- **Large files or rare content**: May take minutes

### Pinned

Content is successfully stored and available.

- Your content is safe
- Accessible via any IPFS gateway
- Will persist until you delete it (or run out of credits)

### Failed

The service couldn't pin your content.

**Common reasons:**
- CID doesn't exist on any reachable IPFS node
- Content only available on an offline peer
- Network timeout while fetching
- Invalid CID format

**What to do:**
- Hover over the status to see the error message
- Verify the CID is correct
- Ensure the content is available somewhere on IPFS
- Try again later if it's a network issue

---

## Searching and Filtering

### Search by Name

Use the search box to find pins by name:
- Type part of the name
- Results filter as you type
- Case-insensitive

### Filter by Status

Click status filter buttons:
- **All** - Show everything
- **Pinned** - Only successful pins
- **Pending** - Queued and pinning
- **Failed** - Pins that couldn't complete

---

## Deleting Pins

### Single Pin

1. Find the pin in your list
2. Click the **trash icon** or **Delete** button
3. Confirm deletion

### Bulk Delete

1. Select multiple pins using checkboxes
2. Click **Delete Selected**
3. Confirm deletion

{: .warning }
> Deleting a pin removes it from your account. The content may still exist on IPFS if pinned elsewhere, but you won't have guaranteed access.

---

## Pin Details

Click on a pin to see full details:

### Basic Info
- Full CID (click to copy)
- Name
- Status
- Created timestamp

### Metadata
- Custom metadata (if set via API)
- Size information
- Delegates (IPFS peers)

### Actions
- Copy CID
- Copy gateway URL
- Delete pin

---

## Accessing Pinned Content

### Via IPFS Gateway

Your pinned content is accessible via IPFS gateways:

```
https://ipfs.io/ipfs/YOUR_CID
https://cloudflare-ipfs.com/ipfs/YOUR_CID
https://dweb.link/ipfs/YOUR_CID
```

### Via IPFS CLI

If you have IPFS installed:

```bash
ipfs cat YOUR_CID
ipfs get YOUR_CID
```

### Via Fx.Land Gateway

```
https://ipfs.cloud.fx.land/ipfs/YOUR_CID
```

---

## Best Practices

### Naming Convention

Use descriptive names to find content later:
- `website-v1.2.3` instead of `QmAbc123`
- `backup-2024-01-15` instead of just `backup`
- Include version numbers if relevant

### Regular Cleanup

- Delete pins you no longer need
- Frees up your storage quota
- Keeps your list manageable

### Monitor Failed Pins

- Check failed pins periodically
- Some may succeed on retry
- Remove ones that consistently fail
