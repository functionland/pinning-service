---
layout: default
title: Filtering & Pagination
parent: Pinning API
nav_order: 3
---

# Filtering & Pagination
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

The `GET /pins` endpoint supports powerful filtering and pagination to help you find specific pins.

---

## Filtering by CID

Find pins for specific CID(s):

```bash
# Single CID
curl "https://api.cloud.fx.land/pins?cid=QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" \
  -H "Authorization: Bearer YOUR_API_KEY"

# Multiple CIDs (comma-separated)
curl "https://api.cloud.fx.land/pins?cid=QmCid1,QmCid2,QmCid3" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

{: .note }
> Maximum 10 CIDs per request due to URL length limits.

---

## Filtering by Name

### Exact Match (default)

```bash
curl "https://api.cloud.fx.land/pins?name=my-website" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Match Strategies

| Strategy | Example | Matches |
|:---------|:--------|:--------|
| `exact` | `name=MyFile` | "MyFile" only |
| `iexact` | `name=MyFile&match=iexact` | "MyFile", "myfile", "MYFILE" |
| `partial` | `name=File&match=partial` | "MyFile", "FileBackup", "OldFile" |
| `ipartial` | `name=file&match=ipartial` | "MyFile", "FILECOPY", "file123" |

### Examples

**Case-insensitive search:**
```bash
curl "https://api.cloud.fx.land/pins?name=website&match=iexact" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Partial match:**
```bash
curl "https://api.cloud.fx.land/pins?name=backup&match=ipartial" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

---

## Filtering by Status

Filter by pin status:

```bash
# Single status
curl "https://api.cloud.fx.land/pins?status=pinned" \
  -H "Authorization: Bearer YOUR_API_KEY"

# Multiple statuses
curl "https://api.cloud.fx.land/pins?status=queued,pinning" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Available Statuses

| Status | Description |
|:-------|:------------|
| `queued` | Waiting to process |
| `pinning` | Currently fetching |
| `pinned` | Successfully stored |
| `failed` | Could not complete |

{: .important }
> Default filter is `status=pinned`. To see all pins, specify all statuses: `status=queued,pinning,pinned,failed`

---

## Filtering by Time

### Before (older than)

```bash
curl "https://api.cloud.fx.land/pins?before=2024-01-15T00:00:00.000Z" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### After (newer than)

```bash
curl "https://api.cloud.fx.land/pins?after=2024-01-01T00:00:00.000Z" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Date Range

```bash
curl "https://api.cloud.fx.land/pins?after=2024-01-01T00:00:00.000Z&before=2024-01-31T23:59:59.999Z" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Use ISO 8601 format with timezone (Z for UTC).

---

## Filtering by Metadata

Filter pins by custom metadata:

```bash
# URL-encode the JSON: {"app_id":"my-app"}
curl "https://api.cloud.fx.land/pins?meta=%7B%22app_id%22%3A%22my-app%22%7D" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Metadata Matching Rules

- All specified keys must match (AND logic)
- Pins may have additional keys not in query
- Values must match exactly

### Example

If you created pins with:
```json
{"meta": {"app_id": "app1", "env": "prod", "version": "1.0"}}
```

Query `meta={"app_id":"app1"}` matches (extra keys OK).
Query `meta={"app_id":"app1","env":"dev"}` does NOT match (env differs).

### URL Encoding

In JavaScript:
```javascript
const meta = JSON.stringify({app_id: 'my-app'});
const url = `https://api.cloud.fx.land/pins?meta=${encodeURIComponent(meta)}`;
```

In Python:
```python
import json
import urllib.parse

meta = json.dumps({'app_id': 'my-app'})
url = f'https://api.cloud.fx.land/pins?meta={urllib.parse.quote(meta)}'
```

---

## Pagination

### Default Behavior

- Returns **10 results** by default
- Sorted by creation time (newest first)

### Setting Limit

```bash
# Get 50 results
curl "https://api.cloud.fx.land/pins?limit=50" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Maximum: 1000 results per request.

### Paginating Results

Use `before` with the oldest result's `created` timestamp:

```bash
# First page
curl "https://api.cloud.fx.land/pins?limit=20" \
  -H "Authorization: Bearer YOUR_API_KEY"

# Response includes: "created": "2024-01-15T10:30:00.000Z" (oldest)

# Next page
curl "https://api.cloud.fx.land/pins?limit=20&before=2024-01-15T10:30:00.000Z" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Checking for More Results

Compare `count` with `results.length`:

```json
{
  "count": 150,
  "results": [/* 20 items */]
}
```

If `count` > `results.length`, there are more pages.

### Pagination Example (JavaScript)

```javascript
async function getAllPins(apiKey) {
  const allPins = [];
  let before = null;

  while (true) {
    const url = before
      ? `https://api.cloud.fx.land/pins?limit=100&before=${before}`
      : 'https://api.cloud.fx.land/pins?limit=100&status=queued,pinning,pinned,failed';

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const data = await response.json();

    allPins.push(...data.results);

    if (data.results.length < 100) break;
    before = data.results[data.results.length - 1].created;
  }

  return allPins;
}
```

---

## Combining Filters

All filters can be combined:

```bash
curl "https://api.cloud.fx.land/pins?\
status=pinned&\
name=backup&\
match=ipartial&\
after=2024-01-01T00:00:00.000Z&\
limit=50" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

This finds:
- Successfully pinned content
- With "backup" in the name (case-insensitive)
- Created in 2024
- Up to 50 results
