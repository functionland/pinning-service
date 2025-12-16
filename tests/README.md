# IPFS Pinning Service Tests

This directory contains test utilities and mock servers for testing the IPFS Pinning Service.

## Test Structure

### Unit Tests
Located in `openapi/go/`:
- `api_pins_service_test.go` - Tests for CID validation, pin validation, type conversions
- `api_pins_controller_test.go` - Tests for API endpoints with mock service
- `middleware_test.go` - Tests for authentication middleware and request handling

### Integration Tests
Located in `openapi/go/integration_test.go`:
- Full pin lifecycle tests
- Concurrent user simulation
- Rate limiting behavior
- Large metadata handling
- Meta filtering

### Mock Server
`main.go` - Mock blockchain server for testing without real Fula network

## Running Tests

### Unit Tests
```bash
cd openapi/go
go test -v ./...
```

### Run with Coverage
```bash
cd openapi/go
go test -v -cover -coverprofile=coverage.out ./...
go tool cover -html=coverage.out -o coverage.html
```

### Run Benchmarks
```bash
cd openapi/go
go test -bench=. -benchmem ./...
```

### Run Integration Tests
First, start the mock blockchain server:
```bash
cd tests
go run main.go
```

Then in another terminal:
```bash
cd openapi/go
RUN_INTEGRATION_TESTS=true PINNING_SERVICE_URL=http://localhost:6000 TEST_AUTH_TOKEN=your-token go test -tags=integration -v ./...
```

## Mock Blockchain Server

The mock server (`main.go`) provides these endpoints:
- `POST /account/seeded` - Returns account from seed
- `GET /account/balance` - Returns mock balance
- `POST /account/set_balance` - Mock balance setting
- `POST /fula/manifest/batch_upload` - Mock manifest creation
- `POST /fula/manifest/available_batch` - Check manifest existence
- `POST /fula/manifest/remove` - Mock manifest removal

Start it with:
```bash
go run main.go
```

Server runs on port 4000 by default.

## Test Categories

| Category | File | Description |
|----------|------|-------------|
| CID Validation | api_pins_service_test.go | Valid/invalid CID formats |
| Pin Validation | api_pins_service_test.go | Name length, origins count, meta entries |
| Type Safety | api_pins_service_test.go | Safe type assertions |
| Status Mapping | api_pins_service_test.go | IPFS cluster to spec status |
| Error Handling | api_pins_service_test.go | IPFS standard error format |
| Endpoints | api_pins_controller_test.go | All REST API endpoints |
| Concurrency | api_pins_controller_test.go | Parallel request handling |
| Middleware | middleware_test.go | Auth, context injection |
| Integration | integration_test.go | End-to-end workflows |

## Expected Test Coverage

Target: >80% code coverage for production code

Key areas covered:
- All API endpoints (GET, POST, DELETE /pins)
- Input validation (CID, name, origins, meta)
- Error responses (IPFS standard Failure format)
- Authentication middleware
- Concurrent request handling
- Edge cases (empty results, large payloads)
