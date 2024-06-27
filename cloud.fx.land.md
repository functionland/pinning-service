
<script src="./telemetry.js"></script>
# http://cloud.fx.land compliance:

Execution Date: 2024-06-27T04:01:59.223Z

Revision: [9c8c9e4](https://github.com/ipfs-shipyard/pinning-service-compliance/commit/9c8c9e4)

[Report History](https://github.com/ipfs-shipyard/pinning-service-compliance/commits/gh-pages/cloud.fx.land.md)

## Summary (9/9 successful)

  🟢 [Request with no authentication token](#request-with-no-authentication-token----success)

  🟢 [Request with invalid token](#request-with-invalid-token----success)

  🟢 [Pins post of CID 'bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m'](#pins-post-of-cid-bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m----success)

  🟢 [Can create and then delete a new pin](#can-create-and-then-delete-a-new-pin----success)

  🟢 [List pin objects (GET /pins) in all states](#list-pin-objects-get-pins-in-all-states----success)

  🟢 [Can create and replace a pin's CID](#can-create-and-replace-a-pins-cid----success)

  🟢 [Can create a pin with name='25bbc571-0150-4e71-b515-56dbf2ac558f'](#can-create-a-pin-with-name25bbc571-0150-4e71-b515-56dbf2ac558f----success)

  🟢 [Pagination: Get all pins, create new pins (optional), get first and second pages](#pagination-get-all-pins-create-new-pins-optional-get-first-and-second-pages----success)

  🟢 [Can delete all pins created during compliance checks](#can-delete-all-pins-created-during-compliance-checks----success)

## Request with no authentication token - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response object matches api spec schema (success)

  🟢 Response code is 401 (success)


### Errors during run

  ⚠️ Error: Invalid response caused unexpected error in pinning-service-client
    at file:///root/pinning-service-compliance/dist/src/ApiCall.js:63:29
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async run (file:///root/pinning-service-compliance/node_modules/p-queue/dist/index.js:115:36)


### Details

#### Request
```
GET http://cloud.fx.land/pins
```
##### Headers
```json
{}
```
##### Body
```json

```

#### Response
```
401 Unauthorized
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "81",
  "content-type": "application/json",
  "date": "Thu, 27 Jun 2024 04:01:18 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "error": {
    "reason": "UNAUTHORIZED",
    "details": "no authorization header provided"
  }
}
```

##### Body (as JSON)
```json
{
  "error": {
    "reason": "UNAUTHORIZED",
    "details": "no authorization header provided"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
null
```
## Request with invalid token - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response object matches api spec schema (success)

  🟢 Response code is 401 (success)


### Errors during run

  ⚠️ Error: Invalid response caused unexpected error in pinning-service-client
    at file:///root/pinning-service-compliance/dist/src/ApiCall.js:63:29
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async run (file:///root/pinning-service-compliance/node_modules/p-queue/dist/index.js:115:36)


### Details

#### Request
```
GET http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
401 Unauthorized
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "102",
  "content-type": "application/json",
  "date": "Thu, 27 Jun 2024 04:01:19 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "error": {
    "reason": "UNAUTHORIZED",
    "details": "invalid or expired session token: purposefullyInvalid"
  }
}
```

##### Body (as JSON)
```json
{
  "error": {
    "reason": "UNAUTHORIZED",
    "details": "invalid or expired session token: purposefullyInvalid"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
null
```
## Pins post of CID 'bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response object matches api spec schema (success)

  🟢 Pinning status is either queued, pinning, or pinned (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:20 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
  "status": "queued",
  "created": "2024-06-27T00:01:20.555923537-04:00",
  "pin": {
    "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
  "status": "queued",
  "created": "2024-06-27T00:01:20.555923537-04:00",
  "pin": {
    "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
  "status": "queued",
  "created": "2024-06-27T04:01:20.555Z",
  "pin": {
    "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## The newly created pin can be immediately deleted - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Response code is 202: The Pin was deleted successfully (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteNewPin.js:20:20)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/60e2a377-72f0-4f79-9169-840b1bade8e3
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:22 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can create and then delete a new pin - 🟢 SUCCESS

### Expectations (4/4 successful)

  🟢 Result is not null (success)

  🟢 Response code is 202 (success)

  🟢 Response is ok (success)

  🟢 Response code is 202: The Pin was deleted successfully (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteNewPin.js:20:20)


### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreifzpwtkl2jzxvoot2ijcvdfbscizc6rlxpk7ctqqwwugol6fi65n4","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:21 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "60e2a377-72f0-4f79-9169-840b1bade8e3",
  "status": "queued",
  "created": "2024-06-27T00:01:21.553702002-04:00",
  "pin": {
    "cid": "bafkreifzpwtkl2jzxvoot2ijcvdfbscizc6rlxpk7ctqqwwugol6fi65n4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "60e2a377-72f0-4f79-9169-840b1bade8e3",
  "status": "queued",
  "created": "2024-06-27T00:01:21.553702002-04:00",
  "pin": {
    "cid": "bafkreifzpwtkl2jzxvoot2ijcvdfbscizc6rlxpk7ctqqwwugol6fi65n4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "60e2a377-72f0-4f79-9169-840b1bade8e3",
  "status": "queued",
  "created": "2024-06-27T04:01:21.553Z",
  "pin": {
    "cid": "bafkreifzpwtkl2jzxvoot2ijcvdfbscizc6rlxpk7ctqqwwugol6fi65n4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## List pin objects (GET /pins) in all states - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Response code is 200 (success)





### Details

#### Request
```
GET http://cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "418",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:23 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 2,
  "results": [
    {
      "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
      "status": "queued",
      "created": "2024-06-27T04:01:20Z",
      "pin": {
        "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m"
      },
      "delegates": null
    },
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "queued",
      "created": "2024-06-27T02:33:09Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 2,
  "results": [
    {
      "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
      "status": "queued",
      "created": "2024-06-27T04:01:20Z",
      "pin": {
        "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m"
      },
      "delegates": null
    },
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "queued",
      "created": "2024-06-27T02:33:09Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 2,
  "results": {}
}
```
## Get original pin via requestid - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response code is 404: Original Pin's requestid cannot be found (success)


### Errors during run

  ⚠️ Error: Invalid response caused unexpected error in pinning-service-client
    at file:///root/pinning-service-compliance/dist/src/ApiCall.js:63:29
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async run (file:///root/pinning-service-compliance/node_modules/p-queue/dist/index.js:115:36)


### Details

#### Request
```
GET http://cloud.fx.land/pins/9b567f0c-7a0b-442d-a702-01cfd0327a4a
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
404 Not Found
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "21",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:26 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
"document not found"
```

##### Body (as JSON)
```json
"document not found"
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
null
```
## Get new pin via requestid - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response code is 200: New Pin's requestid can be found (success)





### Details

#### Request
```
GET http://cloud.fx.land/pins/e11d35cc-93b3-4dc6-a327-3545de2d98af
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "197",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:26 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
  "status": "queued",
  "created": "2024-06-27T04:01:25Z",
  "pin": {
    "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu"
  },
  "delegates": null
}
```

##### Body (as JSON)
```json
{
  "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
  "status": "queued",
  "created": "2024-06-27T04:01:25Z",
  "pin": {
    "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu"
  },
  "delegates": null
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
  "status": "queued",
  "created": "2024-06-27T04:01:25.000Z",
  "pin": {
    "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu"
  },
  "delegates": null
}
```
## Pin's with requestid '9b567f0c-7a0b-442d-a702-01cfd0327a4a' can have cid 'bafkreieklb4dvlky5mi6izpjupj2kvl6yhih5ur5pmign5dgjpy22kuxzu' replaced with 'bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response code is 404: Original Pin's requestid cannot be found (success)

  🟢 Response code is 200: New Pin's requestid can be found (success)


### Errors during run

  ⚠️ Error: Invalid response caused unexpected error in pinning-service-client
    at file:///root/pinning-service-compliance/dist/src/ApiCall.js:63:29
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async run (file:///root/pinning-service-compliance/node_modules/p-queue/dist/index.js:115:36)


### Details

#### Request
```
POST http://cloud.fx.land/pins/9b567f0c-7a0b-442d-a702-01cfd0327a4a
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:25 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
  "status": "queued",
  "created": "2024-06-27T00:01:25.732557245-04:00",
  "pin": {
    "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
  "status": "queued",
  "created": "2024-06-27T00:01:25.732557245-04:00",
  "pin": {
    "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
  "status": "queued",
  "created": "2024-06-27T04:01:25.732Z",
  "pin": {
    "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create and replace a pin's CID - 🟢 SUCCESS

### Expectations (7/7 successful)

  🟢 Pin exists (success)

  🟢 Could obtain requestid from new pin (9b567f0c-7a0b-442d-a702-01cfd0327a4a) (success)

  🟢 Response is ok (success)

  🟢 Replaced pin has the new & expected CID (success)

  🟢 Replaced pin has a different requestid (success)

  🟢 Response code is 404: Original Pin's requestid cannot be found (success)

  🟢 Response code is 200: New Pin's requestid can be found (success)


### Errors during run

  ⚠️ Error: Invalid response caused unexpected error in pinning-service-client
    at file:///root/pinning-service-compliance/dist/src/ApiCall.js:63:29
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async run (file:///root/pinning-service-compliance/node_modules/p-queue/dist/index.js:115:36)


### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreieklb4dvlky5mi6izpjupj2kvl6yhih5ur5pmign5dgjpy22kuxzu","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:24 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "9b567f0c-7a0b-442d-a702-01cfd0327a4a",
  "status": "queued",
  "created": "2024-06-27T00:01:24.267561448-04:00",
  "pin": {
    "cid": "bafkreieklb4dvlky5mi6izpjupj2kvl6yhih5ur5pmign5dgjpy22kuxzu",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "9b567f0c-7a0b-442d-a702-01cfd0327a4a",
  "status": "queued",
  "created": "2024-06-27T00:01:24.267561448-04:00",
  "pin": {
    "cid": "bafkreieklb4dvlky5mi6izpjupj2kvl6yhih5ur5pmign5dgjpy22kuxzu",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "9b567f0c-7a0b-442d-a702-01cfd0327a4a",
  "status": "queued",
  "created": "2024-06-27T04:01:24.267Z",
  "pin": {
    "cid": "bafkreieklb4dvlky5mi6izpjupj2kvl6yhih5ur5pmign5dgjpy22kuxzu",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can retrieve pin with name '25bbc571-0150-4e71-b515-56dbf2ac558f' via the 'exact' TextMatchingStrategy - 🟢 SUCCESS

### Expectations (4/4 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)





### Details

#### Request
```
GET http://cloud.fx.land/pins?name=25bbc571-0150-4e71-b515-56dbf2ac558f&match=exact
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "267",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:28 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 1,
  "results": {}
}
```
## Can retrieve pin with name '25BBC571-0150-4E71-B515-56DBF2AC558F' via the 'iexact' TextMatchingStrategy - 🟢 SUCCESS

### Expectations (4/4 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)





### Details

#### Request
```
GET http://cloud.fx.land/pins?name=25BBC571-0150-4E71-B515-56DBF2AC558F&match=iexact
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "267",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:29 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 1,
  "results": {}
}
```
## Can retrieve pin with name '0150-4e71-b515-56d' via the 'partial' TextMatchingStrategy - 🟢 SUCCESS

### Expectations (4/4 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)





### Details

#### Request
```
GET http://cloud.fx.land/pins?name=0150-4e71-b515-56d&match=partial
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "267",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:30 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 1,
  "results": {}
}
```
## Can retrieve pin with name '0150-4E71-B515-56D' via the 'ipartial' TextMatchingStrategy - 🟢 SUCCESS

### Expectations (4/4 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)





### Details

#### Request
```
GET http://cloud.fx.land/pins?name=0150-4E71-B515-56D&match=ipartial
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "267",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:31 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 1,
  "results": {}
}
```
## Can create a pin with name='25bbc571-0150-4e71-b515-56dbf2ac558f' - 🟢 SUCCESS

### Expectations (19/19 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Name matches name provided during creation (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa","name":"25bbc571-0150-4e71-b515-56dbf2ac558f","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:27 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
  "status": "queued",
  "created": "2024-06-27T00:01:27.460135533-04:00",
  "pin": {
    "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
    "name": "25bbc571-0150-4e71-b515-56dbf2ac558f",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
  "status": "queued",
  "created": "2024-06-27T00:01:27.460135533-04:00",
  "pin": {
    "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
    "name": "25bbc571-0150-4e71-b515-56dbf2ac558f",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
  "status": "queued",
  "created": "2024-06-27T04:01:27.460Z",
  "pin": {
    "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
    "name": "25bbc571-0150-4e71-b515-56dbf2ac558f",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreieiuf2tclce5tasoqypm6onfzpwicy6orpgloqinmpbhhafo3lufm' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreieiuf2tclce5tasoqypm6onfzpwicy6orpgloqinmpbhhafo3lufm","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:32 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "a0e6776f-97ba-42d9-bc22-c97f1f980d57",
  "status": "queued",
  "created": "2024-06-27T00:01:32.834910513-04:00",
  "pin": {
    "cid": "bafkreieiuf2tclce5tasoqypm6onfzpwicy6orpgloqinmpbhhafo3lufm",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "a0e6776f-97ba-42d9-bc22-c97f1f980d57",
  "status": "queued",
  "created": "2024-06-27T00:01:32.834910513-04:00",
  "pin": {
    "cid": "bafkreieiuf2tclce5tasoqypm6onfzpwicy6orpgloqinmpbhhafo3lufm",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "a0e6776f-97ba-42d9-bc22-c97f1f980d57",
  "status": "queued",
  "created": "2024-06-27T04:01:32.834Z",
  "pin": {
    "cid": "bafkreieiuf2tclce5tasoqypm6onfzpwicy6orpgloqinmpbhhafo3lufm",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreifeyibwbtxwpsqei3lbv5afedn4i3nt2tteclopdfza6liu24ztei' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreifeyibwbtxwpsqei3lbv5afedn4i3nt2tteclopdfza6liu24ztei","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:33 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "0deadb15-7f38-4e0a-bbfb-33657be8f215",
  "status": "queued",
  "created": "2024-06-27T00:01:33.795753654-04:00",
  "pin": {
    "cid": "bafkreifeyibwbtxwpsqei3lbv5afedn4i3nt2tteclopdfza6liu24ztei",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "0deadb15-7f38-4e0a-bbfb-33657be8f215",
  "status": "queued",
  "created": "2024-06-27T00:01:33.795753654-04:00",
  "pin": {
    "cid": "bafkreifeyibwbtxwpsqei3lbv5afedn4i3nt2tteclopdfza6liu24ztei",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "0deadb15-7f38-4e0a-bbfb-33657be8f215",
  "status": "queued",
  "created": "2024-06-27T04:01:33.795Z",
  "pin": {
    "cid": "bafkreifeyibwbtxwpsqei3lbv5afedn4i3nt2tteclopdfza6liu24ztei",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreihojkibe3x377gubiy7ox7awqstgv7wcbjup4c5p76fjlaj3qsxzi' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreihojkibe3x377gubiy7ox7awqstgv7wcbjup4c5p76fjlaj3qsxzi","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:34 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "7865b61a-38c2-44f4-b4ec-2dbc8f93e2ff",
  "status": "queued",
  "created": "2024-06-27T00:01:34.791955158-04:00",
  "pin": {
    "cid": "bafkreihojkibe3x377gubiy7ox7awqstgv7wcbjup4c5p76fjlaj3qsxzi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "7865b61a-38c2-44f4-b4ec-2dbc8f93e2ff",
  "status": "queued",
  "created": "2024-06-27T00:01:34.791955158-04:00",
  "pin": {
    "cid": "bafkreihojkibe3x377gubiy7ox7awqstgv7wcbjup4c5p76fjlaj3qsxzi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "7865b61a-38c2-44f4-b4ec-2dbc8f93e2ff",
  "status": "queued",
  "created": "2024-06-27T04:01:34.791Z",
  "pin": {
    "cid": "bafkreihojkibe3x377gubiy7ox7awqstgv7wcbjup4c5p76fjlaj3qsxzi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreidj5ifa6metuj3275swd4qyljj73b2zdkgtrpnwyituqy2ectunka' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreidj5ifa6metuj3275swd4qyljj73b2zdkgtrpnwyituqy2ectunka","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:35 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "8caf3d49-900b-450a-803c-f533fa805966",
  "status": "queued",
  "created": "2024-06-27T00:01:35.799308301-04:00",
  "pin": {
    "cid": "bafkreidj5ifa6metuj3275swd4qyljj73b2zdkgtrpnwyituqy2ectunka",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "8caf3d49-900b-450a-803c-f533fa805966",
  "status": "queued",
  "created": "2024-06-27T00:01:35.799308301-04:00",
  "pin": {
    "cid": "bafkreidj5ifa6metuj3275swd4qyljj73b2zdkgtrpnwyituqy2ectunka",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "8caf3d49-900b-450a-803c-f533fa805966",
  "status": "queued",
  "created": "2024-06-27T04:01:35.799Z",
  "pin": {
    "cid": "bafkreidj5ifa6metuj3275swd4qyljj73b2zdkgtrpnwyituqy2ectunka",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreighz6prnt3wfwtset5mkxaf25ewk65bljtaylxzkf7glx7w5wk4yi' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreighz6prnt3wfwtset5mkxaf25ewk65bljtaylxzkf7glx7w5wk4yi","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:36 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "4e6c48bc-1c97-460b-a3f2-a5684e4bc867",
  "status": "queued",
  "created": "2024-06-27T00:01:36.744096773-04:00",
  "pin": {
    "cid": "bafkreighz6prnt3wfwtset5mkxaf25ewk65bljtaylxzkf7glx7w5wk4yi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "4e6c48bc-1c97-460b-a3f2-a5684e4bc867",
  "status": "queued",
  "created": "2024-06-27T00:01:36.744096773-04:00",
  "pin": {
    "cid": "bafkreighz6prnt3wfwtset5mkxaf25ewk65bljtaylxzkf7glx7w5wk4yi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "4e6c48bc-1c97-460b-a3f2-a5684e4bc867",
  "status": "queued",
  "created": "2024-06-27T04:01:36.744Z",
  "pin": {
    "cid": "bafkreighz6prnt3wfwtset5mkxaf25ewk65bljtaylxzkf7glx7w5wk4yi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreihxvq5anyswkx6kaol3ac6kfx5psvsm3pisrera7xiw772jhxtypy' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreihxvq5anyswkx6kaol3ac6kfx5psvsm3pisrera7xiw772jhxtypy","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:37 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "0b1bbf33-baff-4950-a799-0914b6f7b446",
  "status": "queued",
  "created": "2024-06-27T00:01:37.68216294-04:00",
  "pin": {
    "cid": "bafkreihxvq5anyswkx6kaol3ac6kfx5psvsm3pisrera7xiw772jhxtypy",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "0b1bbf33-baff-4950-a799-0914b6f7b446",
  "status": "queued",
  "created": "2024-06-27T00:01:37.68216294-04:00",
  "pin": {
    "cid": "bafkreihxvq5anyswkx6kaol3ac6kfx5psvsm3pisrera7xiw772jhxtypy",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "0b1bbf33-baff-4950-a799-0914b6f7b446",
  "status": "queued",
  "created": "2024-06-27T04:01:37.682Z",
  "pin": {
    "cid": "bafkreihxvq5anyswkx6kaol3ac6kfx5psvsm3pisrera7xiw772jhxtypy",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreidwmm4gfwjozftkmkndtfw327obbpamisjwn7cydesczcpol7qjca' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreidwmm4gfwjozftkmkndtfw327obbpamisjwn7cydesczcpol7qjca","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:38 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "c93c7f2d-64a8-4647-a9ac-1528f4a5bfd2",
  "status": "queued",
  "created": "2024-06-27T00:01:38.647266543-04:00",
  "pin": {
    "cid": "bafkreidwmm4gfwjozftkmkndtfw327obbpamisjwn7cydesczcpol7qjca",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "c93c7f2d-64a8-4647-a9ac-1528f4a5bfd2",
  "status": "queued",
  "created": "2024-06-27T00:01:38.647266543-04:00",
  "pin": {
    "cid": "bafkreidwmm4gfwjozftkmkndtfw327obbpamisjwn7cydesczcpol7qjca",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "c93c7f2d-64a8-4647-a9ac-1528f4a5bfd2",
  "status": "queued",
  "created": "2024-06-27T04:01:38.647Z",
  "pin": {
    "cid": "bafkreidwmm4gfwjozftkmkndtfw327obbpamisjwn7cydesczcpol7qjca",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreic4qaixkadehni52jpegkwuu6243oa3owzsewrnalwxzkfvhlb6da' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreic4qaixkadehni52jpegkwuu6243oa3owzsewrnalwxzkfvhlb6da","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:39 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "b3550e5f-289b-440e-aec1-823cf3842be4",
  "status": "queued",
  "created": "2024-06-27T00:01:39.655865988-04:00",
  "pin": {
    "cid": "bafkreic4qaixkadehni52jpegkwuu6243oa3owzsewrnalwxzkfvhlb6da",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "b3550e5f-289b-440e-aec1-823cf3842be4",
  "status": "queued",
  "created": "2024-06-27T00:01:39.655865988-04:00",
  "pin": {
    "cid": "bafkreic4qaixkadehni52jpegkwuu6243oa3owzsewrnalwxzkfvhlb6da",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "b3550e5f-289b-440e-aec1-823cf3842be4",
  "status": "queued",
  "created": "2024-06-27T04:01:39.655Z",
  "pin": {
    "cid": "bafkreic4qaixkadehni52jpegkwuu6243oa3owzsewrnalwxzkfvhlb6da",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreicx7veunqauq74en7z2wxtjhvqkd5qeukpgtboieiz54gpu6u54g4' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreicx7veunqauq74en7z2wxtjhvqkd5qeukpgtboieiz54gpu6u54g4","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:40 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "6faf92ab-7f07-41fb-8e15-bc3643334f9b",
  "status": "queued",
  "created": "2024-06-27T00:01:40.68270398-04:00",
  "pin": {
    "cid": "bafkreicx7veunqauq74en7z2wxtjhvqkd5qeukpgtboieiz54gpu6u54g4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "6faf92ab-7f07-41fb-8e15-bc3643334f9b",
  "status": "queued",
  "created": "2024-06-27T00:01:40.68270398-04:00",
  "pin": {
    "cid": "bafkreicx7veunqauq74en7z2wxtjhvqkd5qeukpgtboieiz54gpu6u54g4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "6faf92ab-7f07-41fb-8e15-bc3643334f9b",
  "status": "queued",
  "created": "2024-06-27T04:01:40.682Z",
  "pin": {
    "cid": "bafkreicx7veunqauq74en7z2wxtjhvqkd5qeukpgtboieiz54gpu6u54g4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreieshy2pyvohmrmwfbs4qpjzwphobkxj6lflkky4vhbegd44a7i6qa' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreieshy2pyvohmrmwfbs4qpjzwphobkxj6lflkky4vhbegd44a7i6qa","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:41 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "a00d9f1b-aa5e-4947-a351-f6702348f2e7",
  "status": "queued",
  "created": "2024-06-27T00:01:41.631468026-04:00",
  "pin": {
    "cid": "bafkreieshy2pyvohmrmwfbs4qpjzwphobkxj6lflkky4vhbegd44a7i6qa",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "a00d9f1b-aa5e-4947-a351-f6702348f2e7",
  "status": "queued",
  "created": "2024-06-27T00:01:41.631468026-04:00",
  "pin": {
    "cid": "bafkreieshy2pyvohmrmwfbs4qpjzwphobkxj6lflkky4vhbegd44a7i6qa",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "a00d9f1b-aa5e-4947-a351-f6702348f2e7",
  "status": "queued",
  "created": "2024-06-27T04:01:41.631Z",
  "pin": {
    "cid": "bafkreieshy2pyvohmrmwfbs4qpjzwphobkxj6lflkky4vhbegd44a7i6qa",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreidiixkp6ojq6yrus5e4j3mhjygkggewkw2vofcutqnin7ehmgcsfm' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST http://cloud.fx.land/pins
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED",
  "content-type": "application/json"
}
```
##### Body
```json
{"cid":"bafkreidiixkp6ojq6yrus5e4j3mhjygkggewkw2vofcutqnin7ehmgcsfm","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:42 GMT",
  "server": "nginx/1.18.0 (Ubuntu)",
  "transfer-encoding": "chunked"
}
```
##### Body
```json
{
  "requestid": "d91d8de7-8ea3-4a98-bdc8-a3c4433b9a69",
  "status": "queued",
  "created": "2024-06-27T00:01:42.631537996-04:00",
  "pin": {
    "cid": "bafkreidiixkp6ojq6yrus5e4j3mhjygkggewkw2vofcutqnin7ehmgcsfm",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "d91d8de7-8ea3-4a98-bdc8-a3c4433b9a69",
  "status": "queued",
  "created": "2024-06-27T00:01:42.631537996-04:00",
  "pin": {
    "cid": "bafkreidiixkp6ojq6yrus5e4j3mhjygkggewkw2vofcutqnin7ehmgcsfm",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "d91d8de7-8ea3-4a98-bdc8-a3c4433b9a69",
  "status": "queued",
  "created": "2024-06-27T04:01:42.631Z",
  "pin": {
    "cid": "bafkreidiixkp6ojq6yrus5e4j3mhjygkggewkw2vofcutqnin7ehmgcsfm",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/157.90.32.77/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/157.90.32.77/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/tcp/4001/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/172.18.0.4/udp/4001/quic-v1/webtransport/certhash/uEiDL-K_cfvacl68FgoxUyTmbfwlA3UgDCLXPlrssiIYIqA/certhash/uEiC9rWMSJMYrjlhPLCuhGrYxGuTYFCo99IKo9zh7iw8GQA/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/tcp/4001/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic-v1/webtransport/certhash/uEiBmZzA6NEAdTqLayIljYa3m-RBi23iNclk4H5S7YyfRTQ/certhash/uEiBijqzzCL328A9_WUWPe5S3OkwyodBdZVHd2E2QroZ4Kw/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip4/192.3.161.187/udp/4001/quic/p2p/12D3KooWJVcsqHF8MzQVJhkUM4JSX19N2RQv5EBEyNPePXKN5sKo/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/tcp/4001/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk",
    "/ip6/2a01:4f8:251:566e::2/udp/4001/quic-v1/webtransport/certhash/uEiDVTQCfJJAfJeO_MZz65BKhJywK54eQd3yZRg04lHK6yA/certhash/uEiBtBFoVRvzp1kiF1CcZdqzm0ysLBE8xux7SjZpy3oCrqw/p2p/12D3KooWSvXamJJWN2iTxFwANV8jySie7NdmJyr5QtFNCjdXbU57/p2p-circuit/p2p/12D3KooWAhTbFa7Rsxcw3yyscTbTKHTbbwi6NzBj8H7opXmSnFgk"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Pagination: First page of pins - 🟢 SUCCESS

### Expectations (5/5 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is greater than or equal to 15 (success)

  🟢 Count is greater than the number of pins returned (success)

  🟢 Number of pins returned defaults to 10 (success)





### Details

#### Request
```
GET http://cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1995",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:43 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 15,
  "results": [
    {
      "requestid": "c93c7f2d-64a8-4647-a9ac-1528f4a5bfd2",
      "status": "queued",
      "created": "2024-06-27T04:01:38Z",
      "pin": {
        "cid": "bafkreidwmm4gfwjozftkmkndtfw327obbpamisjwn7cydesczcpol7qjca"
      },
      "delegates": null
    },
    {
      "requestid": "b3550e5f-289b-440e-aec1-823cf3842be4",
      "status": "queued",
      "created": "2024-06-27T04:01:39Z",
      "pin": {
        "cid": "bafkreic4qaixkadehni52jpegkwuu6243oa3owzsewrnalwxzkfvhlb6da"
      },
      "delegates": null
    },
    {
      "requestid": "6faf92ab-7f07-41fb-8e15-bc3643334f9b",
      "status": "queued",
      "created": "2024-06-27T04:01:40Z",
      "pin": {
        "cid": "bafkreicx7veunqauq74en7z2wxtjhvqkd5qeukpgtboieiz54gpu6u54g4"
      },
      "delegates": null
    },
    {
      "requestid": "8caf3d49-900b-450a-803c-f533fa805966",
      "status": "queued",
      "created": "2024-06-27T04:01:35Z",
      "pin": {
        "cid": "bafkreidj5ifa6metuj3275swd4qyljj73b2zdkgtrpnwyituqy2ectunka"
      },
      "delegates": null
    },
    {
      "requestid": "a00d9f1b-aa5e-4947-a351-f6702348f2e7",
      "status": "queued",
      "created": "2024-06-27T04:01:41Z",
      "pin": {
        "cid": "bafkreieshy2pyvohmrmwfbs4qpjzwphobkxj6lflkky4vhbegd44a7i6qa"
      },
      "delegates": null
    },
    {
      "requestid": "d91d8de7-8ea3-4a98-bdc8-a3c4433b9a69",
      "status": "queued",
      "created": "2024-06-27T04:01:42Z",
      "pin": {
        "cid": "bafkreidiixkp6ojq6yrus5e4j3mhjygkggewkw2vofcutqnin7ehmgcsfm"
      },
      "delegates": null
    },
    {
      "requestid": "4e6c48bc-1c97-460b-a3f2-a5684e4bc867",
      "status": "queued",
      "created": "2024-06-27T04:01:36Z",
      "pin": {
        "cid": "bafkreighz6prnt3wfwtset5mkxaf25ewk65bljtaylxzkf7glx7w5wk4yi"
      },
      "delegates": null
    },
    {
      "requestid": "0deadb15-7f38-4e0a-bbfb-33657be8f215",
      "status": "queued",
      "created": "2024-06-27T04:01:33Z",
      "pin": {
        "cid": "bafkreifeyibwbtxwpsqei3lbv5afedn4i3nt2tteclopdfza6liu24ztei"
      },
      "delegates": null
    },
    {
      "requestid": "7865b61a-38c2-44f4-b4ec-2dbc8f93e2ff",
      "status": "queued",
      "created": "2024-06-27T04:01:34Z",
      "pin": {
        "cid": "bafkreihojkibe3x377gubiy7ox7awqstgv7wcbjup4c5p76fjlaj3qsxzi"
      },
      "delegates": null
    },
    {
      "requestid": "0b1bbf33-baff-4950-a799-0914b6f7b446",
      "status": "queued",
      "created": "2024-06-27T04:01:37Z",
      "pin": {
        "cid": "bafkreihxvq5anyswkx6kaol3ac6kfx5psvsm3pisrera7xiw772jhxtypy"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 15,
  "results": [
    {
      "requestid": "c93c7f2d-64a8-4647-a9ac-1528f4a5bfd2",
      "status": "queued",
      "created": "2024-06-27T04:01:38Z",
      "pin": {
        "cid": "bafkreidwmm4gfwjozftkmkndtfw327obbpamisjwn7cydesczcpol7qjca"
      },
      "delegates": null
    },
    {
      "requestid": "b3550e5f-289b-440e-aec1-823cf3842be4",
      "status": "queued",
      "created": "2024-06-27T04:01:39Z",
      "pin": {
        "cid": "bafkreic4qaixkadehni52jpegkwuu6243oa3owzsewrnalwxzkfvhlb6da"
      },
      "delegates": null
    },
    {
      "requestid": "6faf92ab-7f07-41fb-8e15-bc3643334f9b",
      "status": "queued",
      "created": "2024-06-27T04:01:40Z",
      "pin": {
        "cid": "bafkreicx7veunqauq74en7z2wxtjhvqkd5qeukpgtboieiz54gpu6u54g4"
      },
      "delegates": null
    },
    {
      "requestid": "8caf3d49-900b-450a-803c-f533fa805966",
      "status": "queued",
      "created": "2024-06-27T04:01:35Z",
      "pin": {
        "cid": "bafkreidj5ifa6metuj3275swd4qyljj73b2zdkgtrpnwyituqy2ectunka"
      },
      "delegates": null
    },
    {
      "requestid": "a00d9f1b-aa5e-4947-a351-f6702348f2e7",
      "status": "queued",
      "created": "2024-06-27T04:01:41Z",
      "pin": {
        "cid": "bafkreieshy2pyvohmrmwfbs4qpjzwphobkxj6lflkky4vhbegd44a7i6qa"
      },
      "delegates": null
    },
    {
      "requestid": "d91d8de7-8ea3-4a98-bdc8-a3c4433b9a69",
      "status": "queued",
      "created": "2024-06-27T04:01:42Z",
      "pin": {
        "cid": "bafkreidiixkp6ojq6yrus5e4j3mhjygkggewkw2vofcutqnin7ehmgcsfm"
      },
      "delegates": null
    },
    {
      "requestid": "4e6c48bc-1c97-460b-a3f2-a5684e4bc867",
      "status": "queued",
      "created": "2024-06-27T04:01:36Z",
      "pin": {
        "cid": "bafkreighz6prnt3wfwtset5mkxaf25ewk65bljtaylxzkf7glx7w5wk4yi"
      },
      "delegates": null
    },
    {
      "requestid": "0deadb15-7f38-4e0a-bbfb-33657be8f215",
      "status": "queued",
      "created": "2024-06-27T04:01:33Z",
      "pin": {
        "cid": "bafkreifeyibwbtxwpsqei3lbv5afedn4i3nt2tteclopdfza6liu24ztei"
      },
      "delegates": null
    },
    {
      "requestid": "7865b61a-38c2-44f4-b4ec-2dbc8f93e2ff",
      "status": "queued",
      "created": "2024-06-27T04:01:34Z",
      "pin": {
        "cid": "bafkreihojkibe3x377gubiy7ox7awqstgv7wcbjup4c5p76fjlaj3qsxzi"
      },
      "delegates": null
    },
    {
      "requestid": "0b1bbf33-baff-4950-a799-0914b6f7b446",
      "status": "queued",
      "created": "2024-06-27T04:01:37Z",
      "pin": {
        "cid": "bafkreihxvq5anyswkx6kaol3ac6kfx5psvsm3pisrera7xiw772jhxtypy"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 15,
  "results": {}
}
```
## Pagination: Retrieve the next page of pins - 🟢 SUCCESS

### Expectations (3/3 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 The next page of pins doesn't contain any of previous pages pins (success)





### Details

#### Request
```
GET http://cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued&before=2024-06-27T04%3A01%3A33.000Z
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1055",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:43 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 5,
  "results": [
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    },
    {
      "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
      "status": "queued",
      "created": "2024-06-27T04:01:25Z",
      "pin": {
        "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu"
      },
      "delegates": null
    },
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "queued",
      "created": "2024-06-27T02:33:09Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "a0e6776f-97ba-42d9-bc22-c97f1f980d57",
      "status": "queued",
      "created": "2024-06-27T04:01:32Z",
      "pin": {
        "cid": "bafkreieiuf2tclce5tasoqypm6onfzpwicy6orpgloqinmpbhhafo3lufm"
      },
      "delegates": null
    },
    {
      "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
      "status": "queued",
      "created": "2024-06-27T04:01:20Z",
      "pin": {
        "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 5,
  "results": [
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    },
    {
      "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
      "status": "queued",
      "created": "2024-06-27T04:01:25Z",
      "pin": {
        "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu"
      },
      "delegates": null
    },
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "queued",
      "created": "2024-06-27T02:33:09Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "a0e6776f-97ba-42d9-bc22-c97f1f980d57",
      "status": "queued",
      "created": "2024-06-27T04:01:32Z",
      "pin": {
        "cid": "bafkreieiuf2tclce5tasoqypm6onfzpwicy6orpgloqinmpbhhafo3lufm"
      },
      "delegates": null
    },
    {
      "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
      "status": "queued",
      "created": "2024-06-27T04:01:20Z",
      "pin": {
        "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 5,
  "results": {}
}
```
## Pagination: Get all pins, create new pins (optional), get first and second pages - 🟢 SUCCESS

### Expectations (32/32 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is greater than or equal to 15 (success)

  🟢 Count is greater than the number of pins returned (success)

  🟢 Number of pins returned defaults to 10 (success)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 The next page of pins doesn't contain any of previous pages pins (success)





### Details

#### Request
```
GET http://cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "858",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:31 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 4,
  "results": [
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "queued",
      "created": "2024-06-27T02:33:09Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    },
    {
      "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
      "status": "queued",
      "created": "2024-06-27T04:01:20Z",
      "pin": {
        "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m"
      },
      "delegates": null
    },
    {
      "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
      "status": "queued",
      "created": "2024-06-27T04:01:25Z",
      "pin": {
        "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 4,
  "results": [
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "queued",
      "created": "2024-06-27T02:33:09Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "queued",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    },
    {
      "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
      "status": "queued",
      "created": "2024-06-27T04:01:20Z",
      "pin": {
        "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m"
      },
      "delegates": null
    },
    {
      "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
      "status": "queued",
      "created": "2024-06-27T04:01:25Z",
      "pin": {
        "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 4,
  "results": {}
}
```
## Can delete pin with requestid 'd91d8de7-8ea3-4a98-bdc8-a3c4433b9a69' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/d91d8de7-8ea3-4a98-bdc8-a3c4433b9a69
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:46 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid 'b3550e5f-289b-440e-aec1-823cf3842be4' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/b3550e5f-289b-440e-aec1-823cf3842be4
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:46 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid '0deadb15-7f38-4e0a-bbfb-33657be8f215' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/0deadb15-7f38-4e0a-bbfb-33657be8f215
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:47 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid '6faf92ab-7f07-41fb-8e15-bc3643334f9b' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/6faf92ab-7f07-41fb-8e15-bc3643334f9b
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:48 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid 'a00d9f1b-aa5e-4947-a351-f6702348f2e7' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/a00d9f1b-aa5e-4947-a351-f6702348f2e7
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:48 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid '7865b61a-38c2-44f4-b4ec-2dbc8f93e2ff' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/7865b61a-38c2-44f4-b4ec-2dbc8f93e2ff
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:50 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid 'c93c7f2d-64a8-4647-a9ac-1528f4a5bfd2' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/c93c7f2d-64a8-4647-a9ac-1528f4a5bfd2
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:51 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid '8caf3d49-900b-450a-803c-f533fa805966' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/8caf3d49-900b-450a-803c-f533fa805966
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:52 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid '0b1bbf33-baff-4950-a799-0914b6f7b446' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/0b1bbf33-baff-4950-a799-0914b6f7b446
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:53 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid '4e6c48bc-1c97-460b-a3f2-a5684e4bc867' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/4e6c48bc-1c97-460b-a3f2-a5684e4bc867
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:53 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid 'a0e6776f-97ba-42d9-bc22-c97f1f980d57' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/a0e6776f-97ba-42d9-bc22-c97f1f980d57
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:55 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid '5cabcbe2-140b-4d3f-bd38-232f6fe56626' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/5cabcbe2-140b-4d3f-bd38-232f6fe56626
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:56 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid 'e11d35cc-93b3-4dc6-a327-3545de2d98af' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/e11d35cc-93b3-4dc6-a327-3545de2d98af
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:57 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Can delete pin with requestid '669c9932-b129-463c-9a5e-944fee748e9a' - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)


### Details

#### Request
```
DELETE http://cloud.fx.land/pins/669c9932-b129-463c-9a5e-944fee748e9a
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "0",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:58 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json

```

##### Body (as JSON)
```json
null
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
undefined
```
## Get all Pins created before 'Wed Jun 26 2024 22:33:09 GMT-0400 (Eastern Daylight Time)' - 🟢 SUCCESS

### Expectations (0/0 successful)

  


### Errors during run

  ⚠️ Error: Invalid response caused unexpected error in pinning-service-client
    at file:///root/pinning-service-compliance/dist/src/ApiCall.js:63:29
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async run (file:///root/pinning-service-compliance/node_modules/p-queue/dist/index.js:115:36)


### Details

#### Request
```
GET http://cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued&before=2024-06-27T02%3A33%3A09.000Z
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
404 Not Found
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "59",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:59 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "error": {
    "reason": "NOT_FOUND",
    "details": "Pin not found"
  }
}
```

##### Body (as JSON)
```json
{
  "error": {
    "reason": "NOT_FOUND",
    "details": "Pin not found"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
null
```
## Get all Pins created before 'Thu Jun 27 2024 00:01:33 GMT-0400 (Eastern Daylight Time)' - 🟢 SUCCESS

### Expectations (4/4 successful)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ Error: Invalid response caused unexpected error in pinning-service-client
    at file:///root/pinning-service-compliance/dist/src/ApiCall.js:63:29
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async run (file:///root/pinning-service-compliance/node_modules/p-queue/dist/index.js:115:36)


### Details

#### Request
```
GET http://cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued&before=2024-06-27T04%3A01%3A33.000Z
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1059",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:54 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 5,
  "results": [
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "queued",
      "created": "2024-06-27T02:33:09Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "a0e6776f-97ba-42d9-bc22-c97f1f980d57",
      "status": "pinning",
      "created": "2024-06-27T04:01:32Z",
      "pin": {
        "cid": "bafkreieiuf2tclce5tasoqypm6onfzpwicy6orpgloqinmpbhhafo3lufm"
      },
      "delegates": null
    },
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "pinning",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    },
    {
      "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
      "status": "pinning",
      "created": "2024-06-27T04:01:25Z",
      "pin": {
        "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu"
      },
      "delegates": null
    },
    {
      "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
      "status": "pinning",
      "created": "2024-06-27T04:01:20Z",
      "pin": {
        "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 5,
  "results": [
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "queued",
      "created": "2024-06-27T02:33:09Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "a0e6776f-97ba-42d9-bc22-c97f1f980d57",
      "status": "pinning",
      "created": "2024-06-27T04:01:32Z",
      "pin": {
        "cid": "bafkreieiuf2tclce5tasoqypm6onfzpwicy6orpgloqinmpbhhafo3lufm"
      },
      "delegates": null
    },
    {
      "requestid": "5cabcbe2-140b-4d3f-bd38-232f6fe56626",
      "status": "pinning",
      "created": "2024-06-27T04:01:27Z",
      "pin": {
        "cid": "bafkreiexksr6ggtedypzsvdmtpcpze6hohvhb6m5aur6tqel4rnxacupsa",
        "name": "25bbc571-0150-4e71-b515-56dbf2ac558f"
      },
      "delegates": null
    },
    {
      "requestid": "e11d35cc-93b3-4dc6-a327-3545de2d98af",
      "status": "pinning",
      "created": "2024-06-27T04:01:25Z",
      "pin": {
        "cid": "bafkreicvffzey4rywjh5posslnrbdyajtr5vb5n722gdjm2soowzjeruhu"
      },
      "delegates": null
    },
    {
      "requestid": "669c9932-b129-463c-9a5e-944fee748e9a",
      "status": "pinning",
      "created": "2024-06-27T04:01:20Z",
      "pin": {
        "cid": "bafkreih62wz4bamwhxjkk6c3kgptnpil26scpe37trltjs4jm2hr4h2u4m"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 5,
  "results": {}
}
```
## Call pinsGet after deletions - 🟢 SUCCESS

### Expectations (1/1 successful)

  🟢 Final pinsGet call returns the same count as before all compliance checks: '1' (success)





### Details

#### Request
```
GET http://cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "222",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:59 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "pinning",
      "created": "2024-06-27T02:33:09Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "pinning",
      "created": "2024-06-27T02:33:09Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 1,
  "results": {}
}
```
## Can delete all pins created during compliance checks - 🟢 SUCCESS

### Expectations (15/15 successful)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Response is ok (success)

  🟢 Final pinsGet call returns the same count as before all compliance checks: '1' (success)


### Errors during run

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at getTextAndJson (file:///root/pinning-service-compliance/dist/src/utils/fetchSafe/getTextAndJson.js:10:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async ApiCall.saveResponse (file:///root/pinning-service-compliance/dist/src/ApiCall.js:253:44)
    at async Object.post (file:///root/pinning-service-compliance/dist/src/middleware/requestReponseLogger.js:89:21)
    at async BaseAPI.fetchApi (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:35:32)
    at async PinsApi.request (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/runtime.js:62:26)
    at async PinsApi.pinsRequestidDeleteRaw (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:126:26)
    at async PinsApi.pinsRequestidDelete (file:///root/pinning-service-compliance/node_modules/@ipfs-shipyard/pinning-service-client/dist/dist.generated/apis/PinsApi.js:139:9)
    at async fn (file:///root/pinning-service-compliance/dist/src/checks/delete/deleteAllPins.js:24:43)

  ⚠️ Error: Invalid response caused unexpected error in pinning-service-client
    at file:///root/pinning-service-compliance/dist/src/ApiCall.js:63:29
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async run (file:///root/pinning-service-compliance/node_modules/p-queue/dist/index.js:115:36)


### Details

#### Request
```
GET http://cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued
```
##### Headers
```json
{
  "authorization": "Bearer REDACTED"
}
```
##### Body
```json

```

#### Response
```
200 OK
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1995",
  "content-type": "application/json; charset=UTF-8",
  "date": "Thu, 27 Jun 2024 04:01:44 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 15,
  "results": [
    {
      "requestid": "d91d8de7-8ea3-4a98-bdc8-a3c4433b9a69",
      "status": "queued",
      "created": "2024-06-27T04:01:42Z",
      "pin": {
        "cid": "bafkreidiixkp6ojq6yrus5e4j3mhjygkggewkw2vofcutqnin7ehmgcsfm"
      },
      "delegates": null
    },
    {
      "requestid": "b3550e5f-289b-440e-aec1-823cf3842be4",
      "status": "queued",
      "created": "2024-06-27T04:01:39Z",
      "pin": {
        "cid": "bafkreic4qaixkadehni52jpegkwuu6243oa3owzsewrnalwxzkfvhlb6da"
      },
      "delegates": null
    },
    {
      "requestid": "0deadb15-7f38-4e0a-bbfb-33657be8f215",
      "status": "queued",
      "created": "2024-06-27T04:01:33Z",
      "pin": {
        "cid": "bafkreifeyibwbtxwpsqei3lbv5afedn4i3nt2tteclopdfza6liu24ztei"
      },
      "delegates": null
    },
    {
      "requestid": "6faf92ab-7f07-41fb-8e15-bc3643334f9b",
      "status": "queued",
      "created": "2024-06-27T04:01:40Z",
      "pin": {
        "cid": "bafkreicx7veunqauq74en7z2wxtjhvqkd5qeukpgtboieiz54gpu6u54g4"
      },
      "delegates": null
    },
    {
      "requestid": "a00d9f1b-aa5e-4947-a351-f6702348f2e7",
      "status": "queued",
      "created": "2024-06-27T04:01:41Z",
      "pin": {
        "cid": "bafkreieshy2pyvohmrmwfbs4qpjzwphobkxj6lflkky4vhbegd44a7i6qa"
      },
      "delegates": null
    },
    {
      "requestid": "7865b61a-38c2-44f4-b4ec-2dbc8f93e2ff",
      "status": "queued",
      "created": "2024-06-27T04:01:34Z",
      "pin": {
        "cid": "bafkreihojkibe3x377gubiy7ox7awqstgv7wcbjup4c5p76fjlaj3qsxzi"
      },
      "delegates": null
    },
    {
      "requestid": "c93c7f2d-64a8-4647-a9ac-1528f4a5bfd2",
      "status": "queued",
      "created": "2024-06-27T04:01:38Z",
      "pin": {
        "cid": "bafkreidwmm4gfwjozftkmkndtfw327obbpamisjwn7cydesczcpol7qjca"
      },
      "delegates": null
    },
    {
      "requestid": "8caf3d49-900b-450a-803c-f533fa805966",
      "status": "queued",
      "created": "2024-06-27T04:01:35Z",
      "pin": {
        "cid": "bafkreidj5ifa6metuj3275swd4qyljj73b2zdkgtrpnwyituqy2ectunka"
      },
      "delegates": null
    },
    {
      "requestid": "0b1bbf33-baff-4950-a799-0914b6f7b446",
      "status": "queued",
      "created": "2024-06-27T04:01:37Z",
      "pin": {
        "cid": "bafkreihxvq5anyswkx6kaol3ac6kfx5psvsm3pisrera7xiw772jhxtypy"
      },
      "delegates": null
    },
    {
      "requestid": "4e6c48bc-1c97-460b-a3f2-a5684e4bc867",
      "status": "queued",
      "created": "2024-06-27T04:01:36Z",
      "pin": {
        "cid": "bafkreighz6prnt3wfwtset5mkxaf25ewk65bljtaylxzkf7glx7w5wk4yi"
      },
      "delegates": null
    }
  ]
}
```

##### Body (as JSON)
```json
{
  "count": 15,
  "results": [
    {
      "requestid": "d91d8de7-8ea3-4a98-bdc8-a3c4433b9a69",
      "status": "queued",
      "created": "2024-06-27T04:01:42Z",
      "pin": {
        "cid": "bafkreidiixkp6ojq6yrus5e4j3mhjygkggewkw2vofcutqnin7ehmgcsfm"
      },
      "delegates": null
    },
    {
      "requestid": "b3550e5f-289b-440e-aec1-823cf3842be4",
      "status": "queued",
      "created": "2024-06-27T04:01:39Z",
      "pin": {
        "cid": "bafkreic4qaixkadehni52jpegkwuu6243oa3owzsewrnalwxzkfvhlb6da"
      },
      "delegates": null
    },
    {
      "requestid": "0deadb15-7f38-4e0a-bbfb-33657be8f215",
      "status": "queued",
      "created": "2024-06-27T04:01:33Z",
      "pin": {
        "cid": "bafkreifeyibwbtxwpsqei3lbv5afedn4i3nt2tteclopdfza6liu24ztei"
      },
      "delegates": null
    },
    {
      "requestid": "6faf92ab-7f07-41fb-8e15-bc3643334f9b",
      "status": "queued",
      "created": "2024-06-27T04:01:40Z",
      "pin": {
        "cid": "bafkreicx7veunqauq74en7z2wxtjhvqkd5qeukpgtboieiz54gpu6u54g4"
      },
      "delegates": null
    },
    {
      "requestid": "a00d9f1b-aa5e-4947-a351-f6702348f2e7",
      "status": "queued",
      "created": "2024-06-27T04:01:41Z",
      "pin": {
        "cid": "bafkreieshy2pyvohmrmwfbs4qpjzwphobkxj6lflkky4vhbegd44a7i6qa"
      },
      "delegates": null
    },
    {
      "requestid": "7865b61a-38c2-44f4-b4ec-2dbc8f93e2ff",
      "status": "queued",
      "created": "2024-06-27T04:01:34Z",
      "pin": {
        "cid": "bafkreihojkibe3x377gubiy7ox7awqstgv7wcbjup4c5p76fjlaj3qsxzi"
      },
      "delegates": null
    },
    {
      "requestid": "c93c7f2d-64a8-4647-a9ac-1528f4a5bfd2",
      "status": "queued",
      "created": "2024-06-27T04:01:38Z",
      "pin": {
        "cid": "bafkreidwmm4gfwjozftkmkndtfw327obbpamisjwn7cydesczcpol7qjca"
      },
      "delegates": null
    },
    {
      "requestid": "8caf3d49-900b-450a-803c-f533fa805966",
      "status": "queued",
      "created": "2024-06-27T04:01:35Z",
      "pin": {
        "cid": "bafkreidj5ifa6metuj3275swd4qyljj73b2zdkgtrpnwyituqy2ectunka"
      },
      "delegates": null
    },
    {
      "requestid": "0b1bbf33-baff-4950-a799-0914b6f7b446",
      "status": "queued",
      "created": "2024-06-27T04:01:37Z",
      "pin": {
        "cid": "bafkreihxvq5anyswkx6kaol3ac6kfx5psvsm3pisrera7xiw772jhxtypy"
      },
      "delegates": null
    },
    {
      "requestid": "4e6c48bc-1c97-460b-a3f2-a5684e4bc867",
      "status": "queued",
      "created": "2024-06-27T04:01:36Z",
      "pin": {
        "cid": "bafkreighz6prnt3wfwtset5mkxaf25ewk65bljtaylxzkf7glx7w5wk4yi"
      },
      "delegates": null
    }
  ]
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "count": 15,
  "results": {}
}
```
