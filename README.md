This is the repository for the code that runs on the api endpoint at https://api1.cloud.fx.land and serves the pinning service. The requests are distributed to this server through https://api.cloud.fx.land which runs the code inside `pool-server`

## Set as service

1. Build:
```
go build -o ./ipfs-pinning main.go
```

2. copy `ipfs-pinning.service` to `/etc/systemd/system/`

3. `sudo systemctl daemon-reload`

4. `sudo systemctl start fula-upload-server`

5. `sudo systemctl enable fula-upload-server`

6. If needed you can also follow the readme for ipfs-server to setup and ipfs endpoint