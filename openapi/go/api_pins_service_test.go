package openapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// MockFirestoreService implements a mock for testing
type MockFirestoreService struct {
	pins     map[string]PinStatus
	sessions map[string]string // token -> username
	mu       sync.RWMutex
}

func NewMockFirestoreService() *MockFirestoreService {
	return &MockFirestoreService{
		pins:     make(map[string]PinStatus),
		sessions: make(map[string]string),
	}
}

func (m *MockFirestoreService) AddPin(ctx context.Context, username string, pin Pin, uploadStatus string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	requestId := fmt.Sprintf("req-%d", time.Now().UnixNano())
	m.pins[requestId] = PinStatus{
		Requestid: requestId,
		Status:    QUEUED,
		Created:   time.Now(),
		Pin:       pin,
		Delegates: []string{},
		Info:      map[string]string{},
	}
	return requestId, nil
}

func (m *MockFirestoreService) GetPinByRequestID(ctx context.Context, requestID string) (PinStatus, string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if pin, ok := m.pins[requestID]; ok {
		return pin, "testuser", nil
	}
	return PinStatus{}, "", fmt.Errorf("pin not found")
}

func (m *MockFirestoreService) SetSession(token, username string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[token] = username
}

// TestValidateCID tests CID validation
func TestValidateCID(t *testing.T) {
	tests := []struct {
		name    string
		cid     string
		wantErr bool
	}{
		{
			name:    "valid CIDv0",
			cid:     "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
			wantErr: false,
		},
		{
			name:    "valid CIDv1",
			cid:     "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
			wantErr: false,
		},
		{
			name:    "empty CID",
			cid:     "",
			wantErr: true,
		},
		{
			name:    "invalid CID format",
			cid:     "invalid-cid-string",
			wantErr: true,
		},
		{
			name:    "CID with special characters",
			cid:     "Qm<script>alert('xss')</script>",
			wantErr: true,
		},
		{
			name:    "very long invalid string",
			cid:     strings.Repeat("a", 1000),
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateCID(tt.cid)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateCID() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// TestValidatePin tests pin validation
func TestValidatePin(t *testing.T) {
	tests := []struct {
		name    string
		pin     Pin
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid pin with all fields",
			pin: Pin{
				Cid:     "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
				Name:    "test-file.txt",
				Origins: []string{"/ip4/192.168.1.1/tcp/4001/p2p/QmPeer1"},
				Meta:    map[string]string{"app_id": "test-app"},
			},
			wantErr: false,
		},
		{
			name: "valid pin with only CID",
			pin: Pin{
				Cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
			},
			wantErr: false,
		},
		{
			name: "invalid - empty CID",
			pin: Pin{
				Cid:  "",
				Name: "test",
			},
			wantErr: true,
			errMsg:  "CID cannot be empty",
		},
		{
			name: "invalid - name too long",
			pin: Pin{
				Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
				Name: strings.Repeat("a", 256), // Max is 255
			},
			wantErr: true,
			errMsg:  "name exceeds maximum length",
		},
		{
			name: "valid - name at max length",
			pin: Pin{
				Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
				Name: strings.Repeat("a", 255), // Exactly max
			},
			wantErr: false,
		},
		{
			name: "invalid - too many origins",
			pin: Pin{
				Cid:     "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
				Origins: make([]string, 21), // Max is 20
			},
			wantErr: true,
			errMsg:  "origins exceeds maximum count",
		},
		{
			name: "valid - origins at max count",
			pin: Pin{
				Cid:     "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
				Origins: make([]string, 20), // Exactly max
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePin(tt.pin)
			if (err != nil) != tt.wantErr {
				t.Errorf("validatePin() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr && tt.errMsg != "" && err != nil {
				if !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("validatePin() error = %v, should contain %v", err, tt.errMsg)
				}
			}
		})
	}
}

// TestToStringSlice tests safe type conversion
func TestToStringSlice(t *testing.T) {
	tests := []struct {
		name     string
		input    interface{}
		expected []string
	}{
		{
			name:     "nil input",
			input:    nil,
			expected: nil,
		},
		{
			name:     "valid string slice",
			input:    []interface{}{"a", "b", "c"},
			expected: []string{"a", "b", "c"},
		},
		{
			name:     "mixed types - only strings returned",
			input:    []interface{}{"a", 123, "b", true},
			expected: []string{"a", "b"},
		},
		{
			name:     "wrong type - not a slice",
			input:    "not a slice",
			expected: nil,
		},
		{
			name:     "empty slice",
			input:    []interface{}{},
			expected: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := toStringSlice(tt.input)
			if tt.expected == nil {
				if result != nil {
					t.Errorf("toStringSlice() = %v, expected nil", result)
				}
				return
			}
			if len(result) != len(tt.expected) {
				t.Errorf("toStringSlice() length = %d, expected %d", len(result), len(tt.expected))
				return
			}
			for i, v := range result {
				if v != tt.expected[i] {
					t.Errorf("toStringSlice()[%d] = %v, expected %v", i, v, tt.expected[i])
				}
			}
		})
	}
}

// TestToStringMap tests safe map type conversion
func TestToStringMap(t *testing.T) {
	tests := []struct {
		name     string
		input    interface{}
		expected map[string]string
	}{
		{
			name:     "nil input",
			input:    nil,
			expected: nil,
		},
		{
			name:     "valid string map",
			input:    map[string]interface{}{"key1": "value1", "key2": "value2"},
			expected: map[string]string{"key1": "value1", "key2": "value2"},
		},
		{
			name:     "mixed types - only strings returned",
			input:    map[string]interface{}{"str": "value", "num": 123, "bool": true},
			expected: map[string]string{"str": "value"},
		},
		{
			name:     "wrong type - not a map",
			input:    "not a map",
			expected: nil,
		},
		{
			name:     "empty map",
			input:    map[string]interface{}{},
			expected: map[string]string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := toStringMap(tt.input)
			if tt.expected == nil {
				if result != nil {
					t.Errorf("toStringMap() = %v, expected nil", result)
				}
				return
			}
			if len(result) != len(tt.expected) {
				t.Errorf("toStringMap() length = %d, expected %d", len(result), len(tt.expected))
				return
			}
			for k, v := range tt.expected {
				if result[k] != v {
					t.Errorf("toStringMap()[%s] = %v, expected %v", k, result[k], v)
				}
			}
		})
	}
}

// TestStatusMapping tests IPFS cluster status to IPFS spec status mapping
func TestMapStatus(t *testing.T) {
	tests := []struct {
		name           string
		ipfsStatus     string
		expectedStatus Status
	}{
		{"pin_error maps to failed", "pin_error", FAILED},
		{"unpinned maps to failed", "unpinned", FAILED},
		{"pin_queued maps to queued", "pin_queued", QUEUED},
		{"remote maps to queued", "remote", QUEUED},
		{"pinned stays pinned", "pinned", PINNED},
		{"pinning stays pinning", "pinning", PINNING},
		{"queued stays queued", "queued", QUEUED},
		{"failed stays failed", "failed", FAILED},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := mapStatus(tt.ipfsStatus)
			if result != tt.expectedStatus {
				t.Errorf("mapStatus(%s) = %v, expected %v", tt.ipfsStatus, result, tt.expectedStatus)
			}
		})
	}
}

// TestStatusEnum tests Status enum validation
func TestStatusEnum(t *testing.T) {
	tests := []struct {
		name  string
		value string
		valid bool
	}{
		{"queued is valid", "queued", true},
		{"pinning is valid", "pinning", true},
		{"pinned is valid", "pinned", true},
		{"failed is valid", "failed", true},
		{"invalid status", "invalid", false},
		{"empty status", "", false},
		{"uppercase status", "QUEUED", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status := Status(tt.value)
			if status.IsValid() != tt.valid {
				t.Errorf("Status(%s).IsValid() = %v, expected %v", tt.value, status.IsValid(), tt.valid)
			}
		})
	}
}

// TestNewStatusFromValue tests creating Status from string
func TestNewStatusFromValue(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		wantErr bool
	}{
		{"valid queued", "queued", false},
		{"valid pinning", "pinning", false},
		{"valid pinned", "pinned", false},
		{"valid failed", "failed", false},
		{"invalid value", "invalid", true},
		{"empty value", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewStatusFromValue(tt.value)
			if (err != nil) != tt.wantErr {
				t.Errorf("NewStatusFromValue(%s) error = %v, wantErr %v", tt.value, err, tt.wantErr)
			}
		})
	}
}

// TestErrorResponseFormat tests that error responses follow IPFS spec
func TestErrorResponseFormat(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		reason     string
		details    string
	}{
		{"bad request", http.StatusBadRequest, "BAD_REQUEST", "Invalid CID format"},
		{"unauthorized", http.StatusUnauthorized, "UNAUTHORIZED", "Access token is missing"},
		{"not found", http.StatusNotFound, "NOT_FOUND", "Pin not found"},
		{"internal error", http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Database error"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := createErrorResponse(tt.statusCode, tt.reason, tt.details)

			if resp.Code != tt.statusCode {
				t.Errorf("createErrorResponse() code = %d, expected %d", resp.Code, tt.statusCode)
			}

			failure, ok := resp.Body.(Failure)
			if !ok {
				t.Errorf("createErrorResponse() body is not Failure type")
				return
			}

			if failure.Error.Reason != tt.reason {
				t.Errorf("createErrorResponse() reason = %s, expected %s", failure.Error.Reason, tt.reason)
			}

			if failure.Error.Details != tt.details {
				t.Errorf("createErrorResponse() details = %s, expected %s", failure.Error.Details, tt.details)
			}
		})
	}
}

// TestDefaultErrorHandler tests error handler produces valid IPFS format
func TestDefaultErrorHandler(t *testing.T) {
	tests := []struct {
		name           string
		err            error
		result         *ImplResponse
		expectedStatus int
		expectedReason string
	}{
		{
			name:           "parsing error",
			err:            &ParsingError{Param: "cid", Err: fmt.Errorf("invalid format")},
			result:         nil,
			expectedStatus: http.StatusBadRequest,
			expectedReason: "BAD_REQUEST",
		},
		{
			name:           "required error",
			err:            &RequiredError{Field: "cid"},
			result:         nil,
			expectedStatus: http.StatusBadRequest,
			expectedReason: "BAD_REQUEST",
		},
		{
			name:           "generic error with result",
			err:            fmt.Errorf("something went wrong"),
			result:         &ImplResponse{Code: http.StatusInternalServerError, Body: Failure{Error: FailureError{Reason: "INTERNAL_SERVER_ERROR", Details: "something went wrong"}}},
			expectedStatus: http.StatusInternalServerError,
			expectedReason: "INTERNAL_SERVER_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest("GET", "/pins", nil)

			DefaultErrorHandler(w, r, tt.err, tt.result)

			if w.Code != tt.expectedStatus {
				t.Errorf("DefaultErrorHandler() status = %d, expected %d", w.Code, tt.expectedStatus)
			}

			var failure Failure
			if err := json.Unmarshal(w.Body.Bytes(), &failure); err != nil {
				t.Errorf("DefaultErrorHandler() response is not valid JSON: %v", err)
				return
			}

			if failure.Error.Reason != tt.expectedReason {
				t.Errorf("DefaultErrorHandler() reason = %s, expected %s", failure.Error.Reason, tt.expectedReason)
			}
		})
	}
}

// TestParseTime tests RFC3339 time parsing
func TestParseTime(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{"valid RFC3339", "2020-07-27T17:32:28Z", false},
		{"valid RFC3339 with timezone", "2020-07-27T17:32:28+00:00", false},
		{"valid RFC3339 with milliseconds", "2020-07-27T17:32:28.276Z", false},
		{"empty string", "", false}, // Returns zero time, no error
		{"invalid format", "2020-07-27", true},
		{"invalid date", "not-a-date", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseTime(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("parseTime(%s) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			}
		})
	}
}

// TestParseNumericParameter tests numeric parameter parsing with constraints
func TestParseNumericParameter(t *testing.T) {
	tests := []struct {
		name    string
		param   string
		min     int32
		max     int32
		wantErr bool
	}{
		{"valid within range", "50", 1, 100, false},
		{"at minimum", "1", 1, 100, false},
		{"at maximum", "100", 1, 100, false},
		{"below minimum", "0", 1, 100, true},
		{"above maximum", "101", 1, 100, true},
		{"empty string", "", 1, 100, true}, // Returns 0 which fails min constraint
		{"invalid number", "abc", 1, 100, true},
		{"negative number", "-5", 1, 100, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseNumericParameter[int32](
				tt.param,
				WithParse[int32](parseInt32),
				WithMinimum[int32](tt.min),
				WithMaximum[int32](tt.max),
			)
			if (err != nil) != tt.wantErr {
				t.Errorf("parseNumericParameter(%s) error = %v, wantErr %v", tt.param, err, tt.wantErr)
			}
		})
	}
}

// TestConcurrentRequests tests handling of concurrent requests
func TestConcurrentRequests(t *testing.T) {
	// Test that concurrent access to toStringSlice doesn't cause races
	var wg sync.WaitGroup
	iterations := 100

	for i := 0; i < iterations; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			input := []interface{}{fmt.Sprintf("item-%d", i), "test"}
			result := toStringSlice(input)
			if len(result) != 2 {
				t.Errorf("Concurrent toStringSlice failed: got %d items, expected 2", len(result))
			}
		}(i)
	}

	wg.Wait()
}

// TestConcurrentMapAccess tests concurrent map access safety
func TestConcurrentMapAccess(t *testing.T) {
	var wg sync.WaitGroup
	iterations := 100

	for i := 0; i < iterations; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			input := map[string]interface{}{
				fmt.Sprintf("key-%d", i): fmt.Sprintf("value-%d", i),
				"common":                 "value",
			}
			result := toStringMap(input)
			if result == nil {
				t.Errorf("Concurrent toStringMap returned nil")
			}
		}(i)
	}

	wg.Wait()
}

// Benchmark tests
func BenchmarkValidateCID(b *testing.B) {
	cid := "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
	for i := 0; i < b.N; i++ {
		_ = validateCID(cid)
	}
}

func BenchmarkValidatePin(b *testing.B) {
	pin := Pin{
		Cid:     "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
		Name:    "test-file.txt",
		Origins: []string{"/ip4/192.168.1.1/tcp/4001/p2p/QmPeer1"},
		Meta:    map[string]string{"app_id": "test-app"},
	}
	for i := 0; i < b.N; i++ {
		_ = validatePin(pin)
	}
}

func BenchmarkToStringSlice(b *testing.B) {
	input := []interface{}{"a", "b", "c", "d", "e"}
	for i := 0; i < b.N; i++ {
		_ = toStringSlice(input)
	}
}

func BenchmarkToStringMap(b *testing.B) {
	input := map[string]interface{}{
		"key1": "value1",
		"key2": "value2",
		"key3": "value3",
	}
	for i := 0; i < b.N; i++ {
		_ = toStringMap(input)
	}
}

func BenchmarkMapStatus(b *testing.B) {
	statuses := []string{"pin_error", "unpinned", "pin_queued", "pinned", "pinning"}
	for i := 0; i < b.N; i++ {
		_ = mapStatus(statuses[i%len(statuses)])
	}
}
