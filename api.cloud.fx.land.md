
<script src="./telemetry.js"></script>
# https://api.cloud.fx.land compliance:

Execution Date: 2024-06-28T15:26:44.948Z

Revision: [9c8c9e4](https://github.com/ipfs-shipyard/pinning-service-compliance/commit/9c8c9e4)

[Report History](https://github.com/ipfs-shipyard/pinning-service-compliance/commits/gh-pages/api.cloud.fx.land.md)

## Summary (9/9 successful)

  🟢 [Request with no authentication token](#request-with-no-authentication-token----success)

  🟢 [Request with invalid token](#request-with-invalid-token----success)

  🟢 [Pins post of CID 'bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy'](#pins-post-of-cid-bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy----success)

  🟢 [Can create and then delete a new pin](#can-create-and-then-delete-a-new-pin----success)

  🟢 [List pin objects (GET /pins) in all states](#list-pin-objects-get-pins-in-all-states----success)

  🟢 [Can create and replace a pin's CID](#can-create-and-replace-a-pins-cid----success)

  🟢 [Can create a pin with name='429b3b92-56bf-4325-86d8-2710b0d71ac9'](#can-create-a-pin-with-name429b3b92-56bf-4325-86d8-2710b0d71ac9----success)

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
GET https://api.cloud.fx.land/pins
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
  "date": "Fri, 28 Jun 2024 15:18:10 GMT",
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
GET https://api.cloud.fx.land/pins
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
  "content-length": "140",
  "content-type": "application/json",
  "date": "Fri, 28 Jun 2024 15:18:11 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "error": {
    "reason": "UNAUTHORIZED",
    "details": "GetUserIDFromToken: no documents found for session token in middleware: purposefullyInvalid"
  }
}
```

##### Body (as JSON)
```json
{
  "error": {
    "reason": "UNAUTHORIZED",
    "details": "GetUserIDFromToken: no documents found for session token in middleware: purposefullyInvalid"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
null
```
## Pins post of CID 'bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response object matches api spec schema (success)

  🟢 Pinning status is either queued, pinning, or pinned (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:18:32 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
  "status": "queued",
  "created": "2024-06-28T15:18:32.931412925Z",
  "pin": {
    "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
  "status": "queued",
  "created": "2024-06-28T15:18:32.931412925Z",
  "pin": {
    "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
  "status": "queued",
  "created": "2024-06-28T15:18:32.931Z",
  "pin": {
    "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
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
DELETE https://api.cloud.fx.land/pins/23a4b5b1-d36c-45ab-8364-072edbff45d9
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
  "date": "Fri, 28 Jun 2024 15:19:00 GMT",
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
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreig45ipvb5finrkw2a6dg5qdd75ayjljifda22lmz46ujfwzsuigqe","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:18:53 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "23a4b5b1-d36c-45ab-8364-072edbff45d9",
  "status": "queued",
  "created": "2024-06-28T15:18:53.579375363Z",
  "pin": {
    "cid": "bafkreig45ipvb5finrkw2a6dg5qdd75ayjljifda22lmz46ujfwzsuigqe",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "23a4b5b1-d36c-45ab-8364-072edbff45d9",
  "status": "queued",
  "created": "2024-06-28T15:18:53.579375363Z",
  "pin": {
    "cid": "bafkreig45ipvb5finrkw2a6dg5qdd75ayjljifda22lmz46ujfwzsuigqe",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "23a4b5b1-d36c-45ab-8364-072edbff45d9",
  "status": "queued",
  "created": "2024-06-28T15:18:53.579Z",
  "pin": {
    "cid": "bafkreig45ipvb5finrkw2a6dg5qdd75ayjljifda22lmz46ujfwzsuigqe",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
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
GET https://api.cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued
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
  "content-length": "428",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:19:07 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 2,
  "results": [
    {
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "failed",
      "created": "2024-06-28T15:19:01.231044652Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
      "status": "queued",
      "created": "2024-06-28T15:18:32Z",
      "pin": {
        "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy"
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
      "requestid": "84cac532-8409-4cef-9200-5e2f3c06cd6b",
      "status": "failed",
      "created": "2024-06-28T15:19:01.231044652Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
      "status": "queued",
      "created": "2024-06-28T15:18:32Z",
      "pin": {
        "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy"
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
GET https://api.cloud.fx.land/pins/0688d986-de9a-4988-87c4-e02381ac7956
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
  "date": "Fri, 28 Jun 2024 15:19:55 GMT",
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
GET https://api.cloud.fx.land/pins/32f8c08a-8fb3-4e26-961d-04aaa01297be
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
  "date": "Fri, 28 Jun 2024 15:20:02 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
  "status": "queued",
  "created": "2024-06-28T15:19:54Z",
  "pin": {
    "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi"
  },
  "delegates": null
}
```

##### Body (as JSON)
```json
{
  "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
  "status": "queued",
  "created": "2024-06-28T15:19:54Z",
  "pin": {
    "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi"
  },
  "delegates": null
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
  "status": "queued",
  "created": "2024-06-28T15:19:54.000Z",
  "pin": {
    "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi"
  },
  "delegates": null
}
```
## Pin's with requestid '0688d986-de9a-4988-87c4-e02381ac7956' can have cid 'bafkreid7t3cryvw2xtc4v4muwsxlewyk6fyks3vbyet3le7ommswacyn6u' replaced with 'bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi' - 🟢 SUCCESS

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
POST https://api.cloud.fx.land/pins/0688d986-de9a-4988-87c4-e02381ac7956
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
{"cid":"bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:19:54 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
  "status": "queued",
  "created": "2024-06-28T15:19:54.764166323Z",
  "pin": {
    "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
  "status": "queued",
  "created": "2024-06-28T15:19:54.764166323Z",
  "pin": {
    "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
  "status": "queued",
  "created": "2024-06-28T15:19:54.764Z",
  "pin": {
    "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create and replace a pin's CID - 🟢 SUCCESS

### Expectations (7/7 successful)

  🟢 Pin exists (success)

  🟢 Could obtain requestid from new pin (0688d986-de9a-4988-87c4-e02381ac7956) (success)

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
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreid7t3cryvw2xtc4v4muwsxlewyk6fyks3vbyet3le7ommswacyn6u","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:19:27 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "0688d986-de9a-4988-87c4-e02381ac7956",
  "status": "queued",
  "created": "2024-06-28T15:19:27.781481085Z",
  "pin": {
    "cid": "bafkreid7t3cryvw2xtc4v4muwsxlewyk6fyks3vbyet3le7ommswacyn6u",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "0688d986-de9a-4988-87c4-e02381ac7956",
  "status": "queued",
  "created": "2024-06-28T15:19:27.781481085Z",
  "pin": {
    "cid": "bafkreid7t3cryvw2xtc4v4muwsxlewyk6fyks3vbyet3le7ommswacyn6u",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "0688d986-de9a-4988-87c4-e02381ac7956",
  "status": "queued",
  "created": "2024-06-28T15:19:27.781Z",
  "pin": {
    "cid": "bafkreid7t3cryvw2xtc4v4muwsxlewyk6fyks3vbyet3le7ommswacyn6u",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can retrieve pin with name '429b3b92-56bf-4325-86d8-2710b0d71ac9' via the 'exact' TextMatchingStrategy - 🟢 SUCCESS

### Expectations (4/4 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)





### Details

#### Request
```
GET https://api.cloud.fx.land/pins?name=429b3b92-56bf-4325-86d8-2710b0d71ac9&match=exact
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
  "date": "Fri, 28 Jun 2024 15:20:29 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
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
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
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
## Can retrieve pin with name '429B3B92-56BF-4325-86D8-2710B0D71AC9' via the 'iexact' TextMatchingStrategy - 🟢 SUCCESS

### Expectations (4/4 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)





### Details

#### Request
```
GET https://api.cloud.fx.land/pins?name=429B3B92-56BF-4325-86D8-2710B0D71AC9&match=iexact
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
  "date": "Fri, 28 Jun 2024 15:20:36 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
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
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
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
## Can retrieve pin with name '56bf-4325-86d8-271' via the 'partial' TextMatchingStrategy - 🟢 SUCCESS

### Expectations (4/4 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)





### Details

#### Request
```
GET https://api.cloud.fx.land/pins?name=56bf-4325-86d8-271&match=partial
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
  "date": "Fri, 28 Jun 2024 15:20:42 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
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
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
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
## Can retrieve pin with name '56BF-4325-86D8-271' via the 'ipartial' TextMatchingStrategy - 🟢 SUCCESS

### Expectations (4/4 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)

  🟢 Count is equal to 1 (success)

  🟢 Name matches name provided during creation (success)





### Details

#### Request
```
GET https://api.cloud.fx.land/pins?name=56BF-4325-86D8-271&match=ipartial
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
  "date": "Fri, 28 Jun 2024 15:20:49 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 1,
  "results": [
    {
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
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
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
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
## Can create a pin with name='429b3b92-56bf-4325-86d8-2710b0d71ac9' - 🟢 SUCCESS

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
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4","name":"429b3b92-56bf-4325-86d8-2710b0d71ac9","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1165",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:20:22 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
  "status": "queued",
  "created": "2024-06-28T15:20:22.887183405Z",
  "pin": {
    "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
    "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
  "status": "queued",
  "created": "2024-06-28T15:20:22.887183405Z",
  "pin": {
    "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
    "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
  "status": "queued",
  "created": "2024-06-28T15:20:22.887Z",
  "pin": {
    "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
    "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreie7wfw45aej7nq6sedwawzfjzcxoh3adu6efkwc7kevdcpmpk6pwq' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreie7wfw45aej7nq6sedwawzfjzcxoh3adu6efkwc7kevdcpmpk6pwq","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1118",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:21:16 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "abb9c9a3-48c4-4d4b-aeb3-130379395de7",
  "status": "queued",
  "created": "2024-06-28T15:21:16.76308536Z",
  "pin": {
    "cid": "bafkreie7wfw45aej7nq6sedwawzfjzcxoh3adu6efkwc7kevdcpmpk6pwq",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "abb9c9a3-48c4-4d4b-aeb3-130379395de7",
  "status": "queued",
  "created": "2024-06-28T15:21:16.76308536Z",
  "pin": {
    "cid": "bafkreie7wfw45aej7nq6sedwawzfjzcxoh3adu6efkwc7kevdcpmpk6pwq",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "abb9c9a3-48c4-4d4b-aeb3-130379395de7",
  "status": "queued",
  "created": "2024-06-28T15:21:16.763Z",
  "pin": {
    "cid": "bafkreie7wfw45aej7nq6sedwawzfjzcxoh3adu6efkwc7kevdcpmpk6pwq",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreia6imamkshsuxjt5mxl52cqsextmdfmmco5kyrxknrigavetnvcbu' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreia6imamkshsuxjt5mxl52cqsextmdfmmco5kyrxknrigavetnvcbu","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:21:37 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "9405986a-328f-461c-8451-429e42698884",
  "status": "queued",
  "created": "2024-06-28T15:21:37.294514687Z",
  "pin": {
    "cid": "bafkreia6imamkshsuxjt5mxl52cqsextmdfmmco5kyrxknrigavetnvcbu",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "9405986a-328f-461c-8451-429e42698884",
  "status": "queued",
  "created": "2024-06-28T15:21:37.294514687Z",
  "pin": {
    "cid": "bafkreia6imamkshsuxjt5mxl52cqsextmdfmmco5kyrxknrigavetnvcbu",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "9405986a-328f-461c-8451-429e42698884",
  "status": "queued",
  "created": "2024-06-28T15:21:37.294Z",
  "pin": {
    "cid": "bafkreia6imamkshsuxjt5mxl52cqsextmdfmmco5kyrxknrigavetnvcbu",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreiaac7vbduiiqpuhaxlwwutr7t4xftqhbxnfjiw6ybzaoyif7yaajy' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreiaac7vbduiiqpuhaxlwwutr7t4xftqhbxnfjiw6ybzaoyif7yaajy","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:21:57 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "ca378d7d-b20c-46ec-8f7b-f1d08646e547",
  "status": "queued",
  "created": "2024-06-28T15:21:57.804991296Z",
  "pin": {
    "cid": "bafkreiaac7vbduiiqpuhaxlwwutr7t4xftqhbxnfjiw6ybzaoyif7yaajy",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "ca378d7d-b20c-46ec-8f7b-f1d08646e547",
  "status": "queued",
  "created": "2024-06-28T15:21:57.804991296Z",
  "pin": {
    "cid": "bafkreiaac7vbduiiqpuhaxlwwutr7t4xftqhbxnfjiw6ybzaoyif7yaajy",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "ca378d7d-b20c-46ec-8f7b-f1d08646e547",
  "status": "queued",
  "created": "2024-06-28T15:21:57.804Z",
  "pin": {
    "cid": "bafkreiaac7vbduiiqpuhaxlwwutr7t4xftqhbxnfjiw6ybzaoyif7yaajy",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreid23lu3cvwgzspcq5fdfw3tth3irsctdlrva35t2ptfieu4ueoxje' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreid23lu3cvwgzspcq5fdfw3tth3irsctdlrva35t2ptfieu4ueoxje","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:22:18 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "b5bc943f-051d-4de4-9af9-79b2fe0a33a9",
  "status": "queued",
  "created": "2024-06-28T15:22:18.410156199Z",
  "pin": {
    "cid": "bafkreid23lu3cvwgzspcq5fdfw3tth3irsctdlrva35t2ptfieu4ueoxje",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "b5bc943f-051d-4de4-9af9-79b2fe0a33a9",
  "status": "queued",
  "created": "2024-06-28T15:22:18.410156199Z",
  "pin": {
    "cid": "bafkreid23lu3cvwgzspcq5fdfw3tth3irsctdlrva35t2ptfieu4ueoxje",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "b5bc943f-051d-4de4-9af9-79b2fe0a33a9",
  "status": "queued",
  "created": "2024-06-28T15:22:18.410Z",
  "pin": {
    "cid": "bafkreid23lu3cvwgzspcq5fdfw3tth3irsctdlrva35t2ptfieu4ueoxje",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreibcbb3ghbf7tnnfgec2fyhzf5mhufdbyzlqtbwaqop7t5hwa4tu7e' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreibcbb3ghbf7tnnfgec2fyhzf5mhufdbyzlqtbwaqop7t5hwa4tu7e","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:22:38 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "9a85b099-9bc8-4daf-bb30-afafadd21133",
  "status": "queued",
  "created": "2024-06-28T15:22:38.980382696Z",
  "pin": {
    "cid": "bafkreibcbb3ghbf7tnnfgec2fyhzf5mhufdbyzlqtbwaqop7t5hwa4tu7e",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "9a85b099-9bc8-4daf-bb30-afafadd21133",
  "status": "queued",
  "created": "2024-06-28T15:22:38.980382696Z",
  "pin": {
    "cid": "bafkreibcbb3ghbf7tnnfgec2fyhzf5mhufdbyzlqtbwaqop7t5hwa4tu7e",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "9a85b099-9bc8-4daf-bb30-afafadd21133",
  "status": "queued",
  "created": "2024-06-28T15:22:38.980Z",
  "pin": {
    "cid": "bafkreibcbb3ghbf7tnnfgec2fyhzf5mhufdbyzlqtbwaqop7t5hwa4tu7e",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreia52ks5r5iejjztvduahavtn4naur7kz2kfabp4m65cslgsruqhmi' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreia52ks5r5iejjztvduahavtn4naur7kz2kfabp4m65cslgsruqhmi","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:22:59 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "7ddbf56c-2c58-4b79-b85f-1a29eb195d8d",
  "status": "queued",
  "created": "2024-06-28T15:22:59.630147947Z",
  "pin": {
    "cid": "bafkreia52ks5r5iejjztvduahavtn4naur7kz2kfabp4m65cslgsruqhmi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "7ddbf56c-2c58-4b79-b85f-1a29eb195d8d",
  "status": "queued",
  "created": "2024-06-28T15:22:59.630147947Z",
  "pin": {
    "cid": "bafkreia52ks5r5iejjztvduahavtn4naur7kz2kfabp4m65cslgsruqhmi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "7ddbf56c-2c58-4b79-b85f-1a29eb195d8d",
  "status": "queued",
  "created": "2024-06-28T15:22:59.630Z",
  "pin": {
    "cid": "bafkreia52ks5r5iejjztvduahavtn4naur7kz2kfabp4m65cslgsruqhmi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreigavlgigmx7acxsabjcg7ly3ohufdlan2qh43lrunqiul7vmocvmq' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreigavlgigmx7acxsabjcg7ly3ohufdlan2qh43lrunqiul7vmocvmq","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:23:20 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "16553601-869d-4cb7-811c-a643eb695aff",
  "status": "queued",
  "created": "2024-06-28T15:23:20.216342973Z",
  "pin": {
    "cid": "bafkreigavlgigmx7acxsabjcg7ly3ohufdlan2qh43lrunqiul7vmocvmq",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "16553601-869d-4cb7-811c-a643eb695aff",
  "status": "queued",
  "created": "2024-06-28T15:23:20.216342973Z",
  "pin": {
    "cid": "bafkreigavlgigmx7acxsabjcg7ly3ohufdlan2qh43lrunqiul7vmocvmq",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "16553601-869d-4cb7-811c-a643eb695aff",
  "status": "queued",
  "created": "2024-06-28T15:23:20.216Z",
  "pin": {
    "cid": "bafkreigavlgigmx7acxsabjcg7ly3ohufdlan2qh43lrunqiul7vmocvmq",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreie5wjethx55sshlttnxwmykto5cdhb5dhacp2nhknwewa2wmvygoi' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreie5wjethx55sshlttnxwmykto5cdhb5dhacp2nhknwewa2wmvygoi","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:23:40 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "79fc282d-01b5-4c24-954e-999500fc8ed4",
  "status": "queued",
  "created": "2024-06-28T15:23:40.799110957Z",
  "pin": {
    "cid": "bafkreie5wjethx55sshlttnxwmykto5cdhb5dhacp2nhknwewa2wmvygoi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "79fc282d-01b5-4c24-954e-999500fc8ed4",
  "status": "queued",
  "created": "2024-06-28T15:23:40.799110957Z",
  "pin": {
    "cid": "bafkreie5wjethx55sshlttnxwmykto5cdhb5dhacp2nhknwewa2wmvygoi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "79fc282d-01b5-4c24-954e-999500fc8ed4",
  "status": "queued",
  "created": "2024-06-28T15:23:40.799Z",
  "pin": {
    "cid": "bafkreie5wjethx55sshlttnxwmykto5cdhb5dhacp2nhknwewa2wmvygoi",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreifl5aaizoicrclpkvytoeajrvp5zligdobazewcp2nemkks6a523e' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreifl5aaizoicrclpkvytoeajrvp5zligdobazewcp2nemkks6a523e","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:24:01 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "7d02de9b-1d53-4294-a379-1581522c0e13",
  "status": "queued",
  "created": "2024-06-28T15:24:01.337862192Z",
  "pin": {
    "cid": "bafkreifl5aaizoicrclpkvytoeajrvp5zligdobazewcp2nemkks6a523e",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "7d02de9b-1d53-4294-a379-1581522c0e13",
  "status": "queued",
  "created": "2024-06-28T15:24:01.337862192Z",
  "pin": {
    "cid": "bafkreifl5aaizoicrclpkvytoeajrvp5zligdobazewcp2nemkks6a523e",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "7d02de9b-1d53-4294-a379-1581522c0e13",
  "status": "queued",
  "created": "2024-06-28T15:24:01.337Z",
  "pin": {
    "cid": "bafkreifl5aaizoicrclpkvytoeajrvp5zligdobazewcp2nemkks6a523e",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreicujjp575no2nc6c62vflclbi5d523r2kxi26zc6ymaxnzpk3efz4' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreicujjp575no2nc6c62vflclbi5d523r2kxi26zc6ymaxnzpk3efz4","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:24:21 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "80d9a276-bdb9-436a-99ec-97552724e78b",
  "status": "queued",
  "created": "2024-06-28T15:24:21.965519005Z",
  "pin": {
    "cid": "bafkreicujjp575no2nc6c62vflclbi5d523r2kxi26zc6ymaxnzpk3efz4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "80d9a276-bdb9-436a-99ec-97552724e78b",
  "status": "queued",
  "created": "2024-06-28T15:24:21.965519005Z",
  "pin": {
    "cid": "bafkreicujjp575no2nc6c62vflclbi5d523r2kxi26zc6ymaxnzpk3efz4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "80d9a276-bdb9-436a-99ec-97552724e78b",
  "status": "queued",
  "created": "2024-06-28T15:24:21.965Z",
  "pin": {
    "cid": "bafkreicujjp575no2nc6c62vflclbi5d523r2kxi26zc6ymaxnzpk3efz4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
## Can create new pin for testing pagination cid='bafkreibezxi4zffuxiw3fnj6nw7kzvt7prndsryhnq3fvn76v3j6liy6b4' - 🟢 SUCCESS

### Expectations (2/2 successful)

  🟢 Response is ok (success)

  🟢 Result is not null (success)





### Details

#### Request
```
POST https://api.cloud.fx.land/pins
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
{"cid":"bafkreibezxi4zffuxiw3fnj6nw7kzvt7prndsryhnq3fvn76v3j6liy6b4","meta":{"createdBy":"@ipfs-shipyard/pinning-service-compliance"}}
```

#### Response
```
202 Accepted
```
##### Headers
```json
{
  "connection": "keep-alive",
  "content-length": "1119",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:24:42 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "requestid": "6d376497-b6f0-40cb-aea4-759245a4f52d",
  "status": "queued",
  "created": "2024-06-28T15:24:42.579801421Z",
  "pin": {
    "cid": "bafkreibezxi4zffuxiw3fnj6nw7kzvt7prndsryhnq3fvn76v3j6liy6b4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```

##### Body (as JSON)
```json
{
  "requestid": "6d376497-b6f0-40cb-aea4-759245a4f52d",
  "status": "queued",
  "created": "2024-06-28T15:24:42.579801421Z",
  "pin": {
    "cid": "bafkreibezxi4zffuxiw3fnj6nw7kzvt7prndsryhnq3fvn76v3j6liy6b4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
  ],
  "info": {
    "status_details": "Queue position: 0 of 0"
  }
}
```
##### Body (parsed by [pinning-service-client](https://www.npmjs.com/package/@ipfs-shipyard/pinning-service-client))
```json
{
  "requestid": "6d376497-b6f0-40cb-aea4-759245a4f52d",
  "status": "queued",
  "created": "2024-06-28T15:24:42.579Z",
  "pin": {
    "cid": "bafkreibezxi4zffuxiw3fnj6nw7kzvt7prndsryhnq3fvn76v3j6liy6b4",
    "meta": {
      "createdBy": "@ipfs-shipyard/pinning-service-compliance"
    }
  },
  "delegates": [
    "/ip4/10.0.0.227/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/10.0.0.227/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/tcp/4001/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj",
    "/ip4/18.119.248.24/udp/4001/quic-v1/webtransport/certhash/uEiCkk8y-13v8TVsP02soYoq66cd8kWqs8slLEoj7V9JMQA/certhash/uEiBzOZh9siL2pdzzdjOvhMuAJBqh17NYy2hw8aTAVym8AA/p2p/12D3KooWS79EhkPU7ESUwgG4vyHHzW9FDNZLoWVth9b5N5NSrvaj"
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
GET https://api.cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued
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
  "date": "Fri, 28 Jun 2024 15:24:49 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 15,
  "results": [
    {
      "requestid": "b5bc943f-051d-4de4-9af9-79b2fe0a33a9",
      "status": "queued",
      "created": "2024-06-28T15:22:18Z",
      "pin": {
        "cid": "bafkreid23lu3cvwgzspcq5fdfw3tth3irsctdlrva35t2ptfieu4ueoxje"
      },
      "delegates": null
    },
    {
      "requestid": "80d9a276-bdb9-436a-99ec-97552724e78b",
      "status": "queued",
      "created": "2024-06-28T15:24:21Z",
      "pin": {
        "cid": "bafkreicujjp575no2nc6c62vflclbi5d523r2kxi26zc6ymaxnzpk3efz4"
      },
      "delegates": null
    },
    {
      "requestid": "7ddbf56c-2c58-4b79-b85f-1a29eb195d8d",
      "status": "queued",
      "created": "2024-06-28T15:22:59Z",
      "pin": {
        "cid": "bafkreia52ks5r5iejjztvduahavtn4naur7kz2kfabp4m65cslgsruqhmi"
      },
      "delegates": null
    },
    {
      "requestid": "7d02de9b-1d53-4294-a379-1581522c0e13",
      "status": "queued",
      "created": "2024-06-28T15:24:01Z",
      "pin": {
        "cid": "bafkreifl5aaizoicrclpkvytoeajrvp5zligdobazewcp2nemkks6a523e"
      },
      "delegates": null
    },
    {
      "requestid": "6d376497-b6f0-40cb-aea4-759245a4f52d",
      "status": "queued",
      "created": "2024-06-28T15:24:42Z",
      "pin": {
        "cid": "bafkreibezxi4zffuxiw3fnj6nw7kzvt7prndsryhnq3fvn76v3j6liy6b4"
      },
      "delegates": null
    },
    {
      "requestid": "ca378d7d-b20c-46ec-8f7b-f1d08646e547",
      "status": "queued",
      "created": "2024-06-28T15:21:57Z",
      "pin": {
        "cid": "bafkreiaac7vbduiiqpuhaxlwwutr7t4xftqhbxnfjiw6ybzaoyif7yaajy"
      },
      "delegates": null
    },
    {
      "requestid": "16553601-869d-4cb7-811c-a643eb695aff",
      "status": "queued",
      "created": "2024-06-28T15:23:20Z",
      "pin": {
        "cid": "bafkreigavlgigmx7acxsabjcg7ly3ohufdlan2qh43lrunqiul7vmocvmq"
      },
      "delegates": null
    },
    {
      "requestid": "9405986a-328f-461c-8451-429e42698884",
      "status": "queued",
      "created": "2024-06-28T15:21:37Z",
      "pin": {
        "cid": "bafkreia6imamkshsuxjt5mxl52cqsextmdfmmco5kyrxknrigavetnvcbu"
      },
      "delegates": null
    },
    {
      "requestid": "9a85b099-9bc8-4daf-bb30-afafadd21133",
      "status": "queued",
      "created": "2024-06-28T15:22:38Z",
      "pin": {
        "cid": "bafkreibcbb3ghbf7tnnfgec2fyhzf5mhufdbyzlqtbwaqop7t5hwa4tu7e"
      },
      "delegates": null
    },
    {
      "requestid": "79fc282d-01b5-4c24-954e-999500fc8ed4",
      "status": "queued",
      "created": "2024-06-28T15:23:40Z",
      "pin": {
        "cid": "bafkreie5wjethx55sshlttnxwmykto5cdhb5dhacp2nhknwewa2wmvygoi"
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
      "requestid": "b5bc943f-051d-4de4-9af9-79b2fe0a33a9",
      "status": "queued",
      "created": "2024-06-28T15:22:18Z",
      "pin": {
        "cid": "bafkreid23lu3cvwgzspcq5fdfw3tth3irsctdlrva35t2ptfieu4ueoxje"
      },
      "delegates": null
    },
    {
      "requestid": "80d9a276-bdb9-436a-99ec-97552724e78b",
      "status": "queued",
      "created": "2024-06-28T15:24:21Z",
      "pin": {
        "cid": "bafkreicujjp575no2nc6c62vflclbi5d523r2kxi26zc6ymaxnzpk3efz4"
      },
      "delegates": null
    },
    {
      "requestid": "7ddbf56c-2c58-4b79-b85f-1a29eb195d8d",
      "status": "queued",
      "created": "2024-06-28T15:22:59Z",
      "pin": {
        "cid": "bafkreia52ks5r5iejjztvduahavtn4naur7kz2kfabp4m65cslgsruqhmi"
      },
      "delegates": null
    },
    {
      "requestid": "7d02de9b-1d53-4294-a379-1581522c0e13",
      "status": "queued",
      "created": "2024-06-28T15:24:01Z",
      "pin": {
        "cid": "bafkreifl5aaizoicrclpkvytoeajrvp5zligdobazewcp2nemkks6a523e"
      },
      "delegates": null
    },
    {
      "requestid": "6d376497-b6f0-40cb-aea4-759245a4f52d",
      "status": "queued",
      "created": "2024-06-28T15:24:42Z",
      "pin": {
        "cid": "bafkreibezxi4zffuxiw3fnj6nw7kzvt7prndsryhnq3fvn76v3j6liy6b4"
      },
      "delegates": null
    },
    {
      "requestid": "ca378d7d-b20c-46ec-8f7b-f1d08646e547",
      "status": "queued",
      "created": "2024-06-28T15:21:57Z",
      "pin": {
        "cid": "bafkreiaac7vbduiiqpuhaxlwwutr7t4xftqhbxnfjiw6ybzaoyif7yaajy"
      },
      "delegates": null
    },
    {
      "requestid": "16553601-869d-4cb7-811c-a643eb695aff",
      "status": "queued",
      "created": "2024-06-28T15:23:20Z",
      "pin": {
        "cid": "bafkreigavlgigmx7acxsabjcg7ly3ohufdlan2qh43lrunqiul7vmocvmq"
      },
      "delegates": null
    },
    {
      "requestid": "9405986a-328f-461c-8451-429e42698884",
      "status": "queued",
      "created": "2024-06-28T15:21:37Z",
      "pin": {
        "cid": "bafkreia6imamkshsuxjt5mxl52cqsextmdfmmco5kyrxknrigavetnvcbu"
      },
      "delegates": null
    },
    {
      "requestid": "9a85b099-9bc8-4daf-bb30-afafadd21133",
      "status": "queued",
      "created": "2024-06-28T15:22:38Z",
      "pin": {
        "cid": "bafkreibcbb3ghbf7tnnfgec2fyhzf5mhufdbyzlqtbwaqop7t5hwa4tu7e"
      },
      "delegates": null
    },
    {
      "requestid": "79fc282d-01b5-4c24-954e-999500fc8ed4",
      "status": "queued",
      "created": "2024-06-28T15:23:40Z",
      "pin": {
        "cid": "bafkreie5wjethx55sshlttnxwmykto5cdhb5dhacp2nhknwewa2wmvygoi"
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
GET https://api.cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued&before=2024-06-28T15%3A21%3A37.000Z
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
  "content-length": "1065",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:24:56 GMT",
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
      "status": "failed",
      "created": "2024-06-28T15:24:50.058561891Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "abb9c9a3-48c4-4d4b-aeb3-130379395de7",
      "status": "queued",
      "created": "2024-06-28T15:21:16Z",
      "pin": {
        "cid": "bafkreie7wfw45aej7nq6sedwawzfjzcxoh3adu6efkwc7kevdcpmpk6pwq"
      },
      "delegates": null
    },
    {
      "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
      "status": "queued",
      "created": "2024-06-28T15:19:54Z",
      "pin": {
        "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi"
      },
      "delegates": null
    },
    {
      "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
      "status": "queued",
      "created": "2024-06-28T15:18:32Z",
      "pin": {
        "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy"
      },
      "delegates": null
    },
    {
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
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
      "status": "failed",
      "created": "2024-06-28T15:24:50.058561891Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "abb9c9a3-48c4-4d4b-aeb3-130379395de7",
      "status": "queued",
      "created": "2024-06-28T15:21:16Z",
      "pin": {
        "cid": "bafkreie7wfw45aej7nq6sedwawzfjzcxoh3adu6efkwc7kevdcpmpk6pwq"
      },
      "delegates": null
    },
    {
      "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
      "status": "queued",
      "created": "2024-06-28T15:19:54Z",
      "pin": {
        "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi"
      },
      "delegates": null
    },
    {
      "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
      "status": "queued",
      "created": "2024-06-28T15:18:32Z",
      "pin": {
        "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy"
      },
      "delegates": null
    },
    {
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
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
GET https://api.cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued
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
  "content-length": "868",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:20:56 GMT",
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
      "status": "failed",
      "created": "2024-06-28T15:20:50.058662442Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
      },
      "delegates": null
    },
    {
      "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
      "status": "queued",
      "created": "2024-06-28T15:18:32Z",
      "pin": {
        "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy"
      },
      "delegates": null
    },
    {
      "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
      "status": "queued",
      "created": "2024-06-28T15:19:54Z",
      "pin": {
        "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi"
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
      "status": "failed",
      "created": "2024-06-28T15:20:50.058662442Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
      },
      "delegates": null
    },
    {
      "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
      "status": "queued",
      "created": "2024-06-28T15:18:32Z",
      "pin": {
        "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy"
      },
      "delegates": null
    },
    {
      "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
      "status": "queued",
      "created": "2024-06-28T15:19:54Z",
      "pin": {
        "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi"
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
## Can delete pin with requestid '80d9a276-bdb9-436a-99ec-97552724e78b' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/80d9a276-bdb9-436a-99ec-97552724e78b
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
  "date": "Fri, 28 Jun 2024 15:25:09 GMT",
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
## Can delete pin with requestid '7ddbf56c-2c58-4b79-b85f-1a29eb195d8d' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/7ddbf56c-2c58-4b79-b85f-1a29eb195d8d
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
  "date": "Fri, 28 Jun 2024 15:25:16 GMT",
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
## Can delete pin with requestid '16553601-869d-4cb7-811c-a643eb695aff' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/16553601-869d-4cb7-811c-a643eb695aff
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
  "date": "Fri, 28 Jun 2024 15:25:23 GMT",
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
## Can delete pin with requestid '79fc282d-01b5-4c24-954e-999500fc8ed4' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/79fc282d-01b5-4c24-954e-999500fc8ed4
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
  "date": "Fri, 28 Jun 2024 15:25:30 GMT",
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
## Can delete pin with requestid '9a85b099-9bc8-4daf-bb30-afafadd21133' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/9a85b099-9bc8-4daf-bb30-afafadd21133
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
  "date": "Fri, 28 Jun 2024 15:25:37 GMT",
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
## Can delete pin with requestid '7d02de9b-1d53-4294-a379-1581522c0e13' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/7d02de9b-1d53-4294-a379-1581522c0e13
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
  "date": "Fri, 28 Jun 2024 15:25:43 GMT",
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
## Can delete pin with requestid 'ca378d7d-b20c-46ec-8f7b-f1d08646e547' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/ca378d7d-b20c-46ec-8f7b-f1d08646e547
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
  "date": "Fri, 28 Jun 2024 15:25:50 GMT",
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
## Can delete pin with requestid '6d376497-b6f0-40cb-aea4-759245a4f52d' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/6d376497-b6f0-40cb-aea4-759245a4f52d
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
  "date": "Fri, 28 Jun 2024 15:25:57 GMT",
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
## Can delete pin with requestid 'b5bc943f-051d-4de4-9af9-79b2fe0a33a9' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/b5bc943f-051d-4de4-9af9-79b2fe0a33a9
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
  "date": "Fri, 28 Jun 2024 15:26:04 GMT",
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
## Can delete pin with requestid '9405986a-328f-461c-8451-429e42698884' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/9405986a-328f-461c-8451-429e42698884
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
  "date": "Fri, 28 Jun 2024 15:26:11 GMT",
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
## Can delete pin with requestid '32f8c08a-8fb3-4e26-961d-04aaa01297be' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/32f8c08a-8fb3-4e26-961d-04aaa01297be
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
  "date": "Fri, 28 Jun 2024 15:26:24 GMT",
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
## Can delete pin with requestid '385ce1d6-e03c-4158-8ee2-854af047c5a4' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/385ce1d6-e03c-4158-8ee2-854af047c5a4
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
  "date": "Fri, 28 Jun 2024 15:26:31 GMT",
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
## Can delete pin with requestid 'c725b503-5dc3-4418-85b1-c46ec48e53ee' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/c725b503-5dc3-4418-85b1-c46ec48e53ee
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
  "date": "Fri, 28 Jun 2024 15:26:37 GMT",
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
## Can delete pin with requestid 'abb9c9a3-48c4-4d4b-aeb3-130379395de7' - 🟢 SUCCESS

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
DELETE https://api.cloud.fx.land/pins/abb9c9a3-48c4-4d4b-aeb3-130379395de7
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
  "date": "Fri, 28 Jun 2024 15:26:44 GMT",
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
## Get all Pins created before 'Fri Jun 28 2024 11:18:32 GMT-0400 (Eastern Daylight Time)' - 🟢 SUCCESS

### Expectations (0/0 successful)

  





### Details

#### Request
```
GET https://api.cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued&before=2024-06-28T15%3A18%3A32.000Z
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
  "content-length": "231",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:26:45 GMT",
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
      "status": "failed",
      "created": "2024-06-28T15:26:45.015685171Z",
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
      "status": "failed",
      "created": "2024-06-28T15:26:45.015685171Z",
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
## Get all Pins created before 'Fri Jun 28 2024 11:21:37 GMT-0400 (Eastern Daylight Time)' - 🟢 SUCCESS

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


### Details

#### Request
```
GET https://api.cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued&before=2024-06-28T15%3A21%3A37.000Z
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
  "content-length": "1065",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:26:17 GMT",
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
      "status": "failed",
      "created": "2024-06-28T15:26:11.597769794Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
      "status": "queued",
      "created": "2024-06-28T15:19:54Z",
      "pin": {
        "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi"
      },
      "delegates": null
    },
    {
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
      },
      "delegates": null
    },
    {
      "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
      "status": "queued",
      "created": "2024-06-28T15:18:32Z",
      "pin": {
        "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy"
      },
      "delegates": null
    },
    {
      "requestid": "abb9c9a3-48c4-4d4b-aeb3-130379395de7",
      "status": "queued",
      "created": "2024-06-28T15:21:16Z",
      "pin": {
        "cid": "bafkreie7wfw45aej7nq6sedwawzfjzcxoh3adu6efkwc7kevdcpmpk6pwq"
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
      "status": "failed",
      "created": "2024-06-28T15:26:11.597769794Z",
      "pin": {
        "cid": "bafkreic34xn4giidwaiwyzd32rdrn3dbpagdwqo6p7nuxj62jqz6zhibti"
      },
      "delegates": null
    },
    {
      "requestid": "32f8c08a-8fb3-4e26-961d-04aaa01297be",
      "status": "queued",
      "created": "2024-06-28T15:19:54Z",
      "pin": {
        "cid": "bafkreienopsxve7erhiojeuf6t5zhh46plfdne2qpbg4rvrtkufkivy3pi"
      },
      "delegates": null
    },
    {
      "requestid": "385ce1d6-e03c-4158-8ee2-854af047c5a4",
      "status": "queued",
      "created": "2024-06-28T15:20:22Z",
      "pin": {
        "cid": "bafkreickesvvstgogzqjkakjedhr257lb2tkb7c23ht2ul3wql7422g6l4",
        "name": "429b3b92-56bf-4325-86d8-2710b0d71ac9"
      },
      "delegates": null
    },
    {
      "requestid": "c725b503-5dc3-4418-85b1-c46ec48e53ee",
      "status": "queued",
      "created": "2024-06-28T15:18:32Z",
      "pin": {
        "cid": "bafkreia3h37obpnjd2w5omyjpwdtb7hdujxof2woorht5sixdgpwtp7gqy"
      },
      "delegates": null
    },
    {
      "requestid": "abb9c9a3-48c4-4d4b-aeb3-130379395de7",
      "status": "queued",
      "created": "2024-06-28T15:21:16Z",
      "pin": {
        "cid": "bafkreie7wfw45aej7nq6sedwawzfjzcxoh3adu6efkwc7kevdcpmpk6pwq"
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
GET https://api.cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued
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
  "content-length": "231",
  "content-type": "application/json; charset=UTF-8",
  "date": "Fri, 28 Jun 2024 15:26:45 GMT",
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
      "status": "failed",
      "created": "2024-06-28T15:26:45.599186034Z",
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
      "status": "failed",
      "created": "2024-06-28T15:26:45.599186034Z",
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


### Details

#### Request
```
GET https://api.cloud.fx.land/pins?status=failed%2Cpinned%2Cpinning%2Cqueued
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
  "date": "Fri, 28 Jun 2024 15:25:02 GMT",
  "server": "nginx/1.18.0 (Ubuntu)"
}
```
##### Body
```json
{
  "count": 15,
  "results": [
    {
      "requestid": "80d9a276-bdb9-436a-99ec-97552724e78b",
      "status": "queued",
      "created": "2024-06-28T15:24:21Z",
      "pin": {
        "cid": "bafkreicujjp575no2nc6c62vflclbi5d523r2kxi26zc6ymaxnzpk3efz4"
      },
      "delegates": null
    },
    {
      "requestid": "7ddbf56c-2c58-4b79-b85f-1a29eb195d8d",
      "status": "queued",
      "created": "2024-06-28T15:22:59Z",
      "pin": {
        "cid": "bafkreia52ks5r5iejjztvduahavtn4naur7kz2kfabp4m65cslgsruqhmi"
      },
      "delegates": null
    },
    {
      "requestid": "16553601-869d-4cb7-811c-a643eb695aff",
      "status": "queued",
      "created": "2024-06-28T15:23:20Z",
      "pin": {
        "cid": "bafkreigavlgigmx7acxsabjcg7ly3ohufdlan2qh43lrunqiul7vmocvmq"
      },
      "delegates": null
    },
    {
      "requestid": "79fc282d-01b5-4c24-954e-999500fc8ed4",
      "status": "queued",
      "created": "2024-06-28T15:23:40Z",
      "pin": {
        "cid": "bafkreie5wjethx55sshlttnxwmykto5cdhb5dhacp2nhknwewa2wmvygoi"
      },
      "delegates": null
    },
    {
      "requestid": "9a85b099-9bc8-4daf-bb30-afafadd21133",
      "status": "queued",
      "created": "2024-06-28T15:22:38Z",
      "pin": {
        "cid": "bafkreibcbb3ghbf7tnnfgec2fyhzf5mhufdbyzlqtbwaqop7t5hwa4tu7e"
      },
      "delegates": null
    },
    {
      "requestid": "7d02de9b-1d53-4294-a379-1581522c0e13",
      "status": "queued",
      "created": "2024-06-28T15:24:01Z",
      "pin": {
        "cid": "bafkreifl5aaizoicrclpkvytoeajrvp5zligdobazewcp2nemkks6a523e"
      },
      "delegates": null
    },
    {
      "requestid": "ca378d7d-b20c-46ec-8f7b-f1d08646e547",
      "status": "queued",
      "created": "2024-06-28T15:21:57Z",
      "pin": {
        "cid": "bafkreiaac7vbduiiqpuhaxlwwutr7t4xftqhbxnfjiw6ybzaoyif7yaajy"
      },
      "delegates": null
    },
    {
      "requestid": "6d376497-b6f0-40cb-aea4-759245a4f52d",
      "status": "queued",
      "created": "2024-06-28T15:24:42Z",
      "pin": {
        "cid": "bafkreibezxi4zffuxiw3fnj6nw7kzvt7prndsryhnq3fvn76v3j6liy6b4"
      },
      "delegates": null
    },
    {
      "requestid": "b5bc943f-051d-4de4-9af9-79b2fe0a33a9",
      "status": "queued",
      "created": "2024-06-28T15:22:18Z",
      "pin": {
        "cid": "bafkreid23lu3cvwgzspcq5fdfw3tth3irsctdlrva35t2ptfieu4ueoxje"
      },
      "delegates": null
    },
    {
      "requestid": "9405986a-328f-461c-8451-429e42698884",
      "status": "queued",
      "created": "2024-06-28T15:21:37Z",
      "pin": {
        "cid": "bafkreia6imamkshsuxjt5mxl52cqsextmdfmmco5kyrxknrigavetnvcbu"
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
      "requestid": "80d9a276-bdb9-436a-99ec-97552724e78b",
      "status": "queued",
      "created": "2024-06-28T15:24:21Z",
      "pin": {
        "cid": "bafkreicujjp575no2nc6c62vflclbi5d523r2kxi26zc6ymaxnzpk3efz4"
      },
      "delegates": null
    },
    {
      "requestid": "7ddbf56c-2c58-4b79-b85f-1a29eb195d8d",
      "status": "queued",
      "created": "2024-06-28T15:22:59Z",
      "pin": {
        "cid": "bafkreia52ks5r5iejjztvduahavtn4naur7kz2kfabp4m65cslgsruqhmi"
      },
      "delegates": null
    },
    {
      "requestid": "16553601-869d-4cb7-811c-a643eb695aff",
      "status": "queued",
      "created": "2024-06-28T15:23:20Z",
      "pin": {
        "cid": "bafkreigavlgigmx7acxsabjcg7ly3ohufdlan2qh43lrunqiul7vmocvmq"
      },
      "delegates": null
    },
    {
      "requestid": "79fc282d-01b5-4c24-954e-999500fc8ed4",
      "status": "queued",
      "created": "2024-06-28T15:23:40Z",
      "pin": {
        "cid": "bafkreie5wjethx55sshlttnxwmykto5cdhb5dhacp2nhknwewa2wmvygoi"
      },
      "delegates": null
    },
    {
      "requestid": "9a85b099-9bc8-4daf-bb30-afafadd21133",
      "status": "queued",
      "created": "2024-06-28T15:22:38Z",
      "pin": {
        "cid": "bafkreibcbb3ghbf7tnnfgec2fyhzf5mhufdbyzlqtbwaqop7t5hwa4tu7e"
      },
      "delegates": null
    },
    {
      "requestid": "7d02de9b-1d53-4294-a379-1581522c0e13",
      "status": "queued",
      "created": "2024-06-28T15:24:01Z",
      "pin": {
        "cid": "bafkreifl5aaizoicrclpkvytoeajrvp5zligdobazewcp2nemkks6a523e"
      },
      "delegates": null
    },
    {
      "requestid": "ca378d7d-b20c-46ec-8f7b-f1d08646e547",
      "status": "queued",
      "created": "2024-06-28T15:21:57Z",
      "pin": {
        "cid": "bafkreiaac7vbduiiqpuhaxlwwutr7t4xftqhbxnfjiw6ybzaoyif7yaajy"
      },
      "delegates": null
    },
    {
      "requestid": "6d376497-b6f0-40cb-aea4-759245a4f52d",
      "status": "queued",
      "created": "2024-06-28T15:24:42Z",
      "pin": {
        "cid": "bafkreibezxi4zffuxiw3fnj6nw7kzvt7prndsryhnq3fvn76v3j6liy6b4"
      },
      "delegates": null
    },
    {
      "requestid": "b5bc943f-051d-4de4-9af9-79b2fe0a33a9",
      "status": "queued",
      "created": "2024-06-28T15:22:18Z",
      "pin": {
        "cid": "bafkreid23lu3cvwgzspcq5fdfw3tth3irsctdlrva35t2ptfieu4ueoxje"
      },
      "delegates": null
    },
    {
      "requestid": "9405986a-328f-461c-8451-429e42698884",
      "status": "queued",
      "created": "2024-06-28T15:21:37Z",
      "pin": {
        "cid": "bafkreia6imamkshsuxjt5mxl52cqsextmdfmmco5kyrxknrigavetnvcbu"
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
