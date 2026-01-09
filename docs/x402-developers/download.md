---
layout: default
title: Download Reference
parent: x402 Developers
nav_order: 3
---

# Download Endpoints (GET/HEAD)
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## GET - Download Content

`GET /:bucket/:key`

Retrieve uploaded content. **No payment required.**

### Request

```bash
curl "https://x402.api.cloud.fx.land/mybucket/myfile.txt"
```

### Response

Returns the file content with appropriate headers:

```
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 1024
ETag: "abc123..."

[file content]
```

### Response Headers

| Header | Description |
|:-------|:------------|
| `Content-Type` | MIME type of content |
| `Content-Length` | Size in bytes |
| `ETag` | Content hash |
| `Last-Modified` | Upload timestamp |

---

## HEAD - Check Existence

`HEAD /:bucket/:key`

Check if content exists without downloading. **No payment required.**

### Request

```bash
curl -I "https://x402.api.cloud.fx.land/mybucket/myfile.txt"
```

### Response (Exists)

```
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 1024
ETag: "abc123..."
```

### Response (Not Found)

```
HTTP/1.1 404 Not Found
```

---

## Examples

### Download Text File

```bash
curl "https://x402.api.cloud.fx.land/mybucket/document.txt" \
  -o document.txt
```

### Download Binary File

```bash
curl "https://x402.api.cloud.fx.land/mybucket/image.png" \
  --output image.png
```

### Check If File Exists

```bash
curl -I "https://x402.api.cloud.fx.land/mybucket/file.txt"
# Check HTTP status: 200 = exists, 404 = not found
```

### Conditional Download

```bash
# Only download if changed
curl "https://x402.api.cloud.fx.land/mybucket/file.txt" \
  -H "If-None-Match: \"abc123...\"" \
  -o file.txt
# Returns 304 Not Modified if unchanged
```

---

## Error Responses

### 404 Not Found

Content doesn't exist or has expired:

```json
{
  "error": "NOT_FOUND",
  "message": "Object not found"
}
```

### 410 Gone

Content existed but has expired:

```json
{
  "error": "GONE",
  "message": "Object has expired"
}
```

---

## Alternative Access Methods

### Via IPFS Gateway

If you have the CID from upload:

```bash
curl "https://ipfs.io/ipfs/QmYourCID"
curl "https://dweb.link/ipfs/QmYourCID"
```

### Via S3 Backend

```bash
curl "https://s3.cloud.fx.land/mybucket/myfile.txt"
```

---

## Programmatic Examples

### JavaScript

```javascript
async function downloadFile(bucket, key) {
  const response = await fetch(
    `https://x402.api.cloud.fx.land/${bucket}/${key}`
  );

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  return response.blob();
}

async function fileExists(bucket, key) {
  const response = await fetch(
    `https://x402.api.cloud.fx.land/${bucket}/${key}`,
    { method: 'HEAD' }
  );

  return response.ok;
}
```

### Python

```python
import requests

def download_file(bucket: str, key: str, output_path: str):
    url = f'https://x402.api.cloud.fx.land/{bucket}/{key}'
    response = requests.get(url)
    response.raise_for_status()

    with open(output_path, 'wb') as f:
        f.write(response.content)

def file_exists(bucket: str, key: str) -> bool:
    url = f'https://x402.api.cloud.fx.land/{bucket}/{key}'
    response = requests.head(url)
    return response.ok
```

---

## Notes

- Downloads are free (no payment required)
- Content is available until TTL expires
- CID-based access works on any IPFS gateway
- Large files may benefit from range requests
