This folder contains the server to run a temporary ipfs receiving endpoint that just receives a file, authenticate the request and uploads to kubo server and returns cid v1

## Set as service

1. copy the `fula-upload-server.service` to `/etc/systemd/system/`

2. On a computer with node installed:
```
npm install -g pkg
pkg server.js --targets node18-linux-x64 -o ipfs-gateway
```
