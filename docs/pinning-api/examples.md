---
layout: default
title: Examples
parent: Pinning API
nav_order: 5
---

# Code Examples
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## curl Examples

### Pin Content

```bash
curl -X POST "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer $FXLAND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "name": "my-file"
  }'
```

### List All Pins

```bash
curl "https://api.cloud.fx.land/pins?status=queued,pinning,pinned,failed" \
  -H "Authorization: Bearer $FXLAND_API_KEY"
```

### Get Pin Status

```bash
curl "https://api.cloud.fx.land/pins/$REQUEST_ID" \
  -H "Authorization: Bearer $FXLAND_API_KEY"
```

### Delete Pin

```bash
curl -X DELETE "https://api.cloud.fx.land/pins/$REQUEST_ID" \
  -H "Authorization: Bearer $FXLAND_API_KEY"
```

---

## JavaScript / Node.js

### Setup

```javascript
const API_KEY = process.env.FXLAND_API_KEY;
const BASE_URL = 'https://api.cloud.fx.land';

async function apiRequest(endpoint, options = {}) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.details || `HTTP ${response.status}`);
  }

  return response.status === 202 && !options.method?.includes('DELETE')
    ? response.json()
    : response;
}
```

### Pin Content

```javascript
async function createPin(cid, name = null, meta = {}) {
  return apiRequest('/pins', {
    method: 'POST',
    body: JSON.stringify({ cid, name, meta }),
  });
}

// Usage
const pin = await createPin(
  'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  'my-website',
  { version: '1.0' }
);
console.log(`Created pin: ${pin.requestid}`);
```

### List Pins with Filtering

```javascript
async function listPins({ status, name, match, limit } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status.join(','));
  if (name) params.set('name', name);
  if (match) params.set('match', match);
  if (limit) params.set('limit', limit);

  return apiRequest(`/pins?${params}`);
}

// Usage
const pins = await listPins({
  status: ['pinned'],
  name: 'website',
  match: 'ipartial',
  limit: 50
});
console.log(`Found ${pins.count} pins`);
```

### Wait for Pin to Complete

```javascript
async function waitForPin(requestid, timeout = 60000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const pin = await apiRequest(`/pins/${requestid}`);

    if (pin.status === 'pinned') return pin;
    if (pin.status === 'failed') {
      throw new Error(`Pin failed: ${pin.info?.status_details}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  throw new Error('Timeout waiting for pin');
}

// Usage
const pin = await createPin('QmCID', 'my-file');
const completed = await waitForPin(pin.requestid);
console.log('Pin completed!');
```

### Delete Pin

```javascript
async function deletePin(requestid) {
  await apiRequest(`/pins/${requestid}`, { method: 'DELETE' });
  return true;
}
```

---

## Python

### Setup

```python
import os
import requests
from typing import Optional, List, Dict, Any

API_KEY = os.environ['FXLAND_API_KEY']
BASE_URL = 'https://api.cloud.fx.land'

def api_request(endpoint: str, method: str = 'GET', json: dict = None) -> dict:
    response = requests.request(
        method,
        f'{BASE_URL}{endpoint}',
        headers={
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json',
        },
        json=json,
    )

    if not response.ok:
        error = response.json().get('error', {})
        raise Exception(f"{error.get('reason')}: {error.get('details')}")

    if response.status_code == 202 and method == 'DELETE':
        return {}
    return response.json() if response.content else {}
```

### Pin Content

```python
def create_pin(cid: str, name: str = None, meta: dict = None) -> dict:
    data = {'cid': cid}
    if name:
        data['name'] = name
    if meta:
        data['meta'] = meta

    return api_request('/pins', method='POST', json=data)

# Usage
pin = create_pin(
    'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    name='my-website',
    meta={'version': '1.0'}
)
print(f"Created pin: {pin['requestid']}")
```

### List Pins

```python
def list_pins(
    status: List[str] = None,
    name: str = None,
    match: str = None,
    limit: int = None,
) -> dict:
    params = []
    if status:
        params.append(f"status={','.join(status)}")
    if name:
        params.append(f"name={name}")
    if match:
        params.append(f"match={match}")
    if limit:
        params.append(f"limit={limit}")

    query = '&'.join(params)
    return api_request(f'/pins?{query}' if query else '/pins')

# Usage
pins = list_pins(status=['pinned'], name='backup', match='ipartial')
print(f"Found {pins['count']} pins")
```

### Wait for Pin

```python
import time

def wait_for_pin(requestid: str, timeout: int = 60) -> dict:
    start = time.time()

    while time.time() - start < timeout:
        pin = api_request(f'/pins/{requestid}')

        if pin['status'] == 'pinned':
            return pin
        if pin['status'] == 'failed':
            raise Exception(f"Pin failed: {pin.get('info', {}).get('status_details')}")

        time.sleep(2)

    raise Exception('Timeout waiting for pin')

# Usage
pin = create_pin('QmCID', 'my-file')
completed = wait_for_pin(pin['requestid'])
print('Pin completed!')
```

---

## IPFS CLI

### Add Remote Service

```bash
ipfs pin remote service add fxland https://api.cloud.fx.land $FXLAND_API_KEY
```

### Pin Content

```bash
# Pin by CID
ipfs pin remote add --service=fxland QmYourCID

# Pin with name
ipfs pin remote add --service=fxland --name="my-file" QmYourCID

# Pin local content (add + pin)
CID=$(ipfs add -Q myfile.txt)
ipfs pin remote add --service=fxland --name="myfile.txt" $CID
```

### List Remote Pins

```bash
# List all
ipfs pin remote ls --service=fxland

# Filter by status
ipfs pin remote ls --service=fxland --status=pinned

# Filter by CID
ipfs pin remote ls --service=fxland --cid=QmYourCID
```

### Remove Remote Pins

```bash
# Remove by CID
ipfs pin remote rm --service=fxland --cid=QmYourCID

# Remove all failed
ipfs pin remote rm --service=fxland --status=failed --force
```

### Check Service Status

```bash
ipfs pin remote service ls
```

---

## Go

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "os"
)

const baseURL = "https://api.cloud.fx.land"

type Pin struct {
    CID  string            `json:"cid"`
    Name string            `json:"name,omitempty"`
    Meta map[string]string `json:"meta,omitempty"`
}

type PinStatus struct {
    RequestID string `json:"requestid"`
    Status    string `json:"status"`
    Created   string `json:"created"`
    Pin       Pin    `json:"pin"`
}

func apiRequest(method, endpoint string, body interface{}) ([]byte, error) {
    apiKey := os.Getenv("FXLAND_API_KEY")

    var reqBody io.Reader
    if body != nil {
        jsonBody, _ := json.Marshal(body)
        reqBody = bytes.NewBuffer(jsonBody)
    }

    req, _ := http.NewRequest(method, baseURL+endpoint, reqBody)
    req.Header.Set("Authorization", "Bearer "+apiKey)
    req.Header.Set("Content-Type", "application/json")

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    return io.ReadAll(resp.Body)
}

func createPin(cid, name string) (*PinStatus, error) {
    body := Pin{CID: cid, Name: name}
    data, err := apiRequest("POST", "/pins", body)
    if err != nil {
        return nil, err
    }

    var pin PinStatus
    json.Unmarshal(data, &pin)
    return &pin, nil
}

func main() {
    pin, err := createPin("QmYourCID", "my-file")
    if err != nil {
        panic(err)
    }
    fmt.Printf("Created pin: %s\n", pin.RequestID)
}
```
