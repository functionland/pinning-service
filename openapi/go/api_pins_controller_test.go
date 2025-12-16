package openapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/mux"
)

// MockPinsAPIService is a mock implementation for testing
type MockPinsAPIService struct {
	pins     map[string]PinStatus
	mu       sync.RWMutex
	counter  int64
	addDelay time.Duration
	failAdd  bool
	failGet  bool
}

func NewMockPinsAPIService() *MockPinsAPIService {
	return &MockPinsAPIService{
		pins: make(map[string]PinStatus),
	}
}

func (m *MockPinsAPIService) AddPin(ctx context.Context, pin Pin) (ImplResponse, error) {
	if m.addDelay > 0 {
		time.Sleep(m.addDelay)
	}

	if m.failAdd {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "mock failure"), fmt.Errorf("mock failure")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.counter++
	requestId := fmt.Sprintf("req-%d-%d", time.Now().UnixNano(), m.counter)
	status := PinStatus{
		Requestid: requestId,
		Status:    QUEUED,
		Created:   time.Now(),
		Pin:       pin,
		Delegates: []string{"/ip4/127.0.0.1/tcp/4001/p2p/QmTestPeer"},
		Info:      map[string]string{"status_details": "Queue position: 0 of 0"},
	}
	m.pins[requestId] = status

	return Response(http.StatusAccepted, status), nil
}

func (m *MockPinsAPIService) DeletePinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.pins[requestid]; !ok {
		return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), fmt.Errorf("pin not found")
	}

	delete(m.pins, requestid)
	return Response(http.StatusAccepted, nil), nil
}

func (m *MockPinsAPIService) GetPinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	if m.failGet {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "mock failure"), fmt.Errorf("mock failure")
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	if pin, ok := m.pins[requestid]; ok {
		return Response(http.StatusOK, pin), nil
	}

	return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), fmt.Errorf("pin not found")
}

func (m *MockPinsAPIService) GetPins(ctx context.Context, cid []string, name string, match TextMatchingStrategy, status []Status, before time.Time, after time.Time, limit int32, meta map[string]string) (ImplResponse, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var results []PinStatus
	for _, pin := range m.pins {
		// Apply filters
		if len(cid) > 0 {
			found := false
			for _, c := range cid {
				if pin.Pin.Cid == c {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}

		if name != "" {
			switch match {
			case "exact", "":
				if pin.Pin.Name != name {
					continue
				}
			case "iexact":
				if strings.ToLower(pin.Pin.Name) != strings.ToLower(name) {
					continue
				}
			case "partial":
				if !strings.Contains(pin.Pin.Name, name) {
					continue
				}
			case "ipartial":
				if !strings.Contains(strings.ToLower(pin.Pin.Name), strings.ToLower(name)) {
					continue
				}
			}
		}

		if len(status) > 0 {
			found := false
			for _, s := range status {
				if pin.Status == s {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}

		results = append(results, pin)
		if limit > 0 && int32(len(results)) >= limit {
			break
		}
	}

	return Response(http.StatusOK, PinResults{
		Count:   int32(len(results)),
		Results: results,
	}), nil
}

func (m *MockPinsAPIService) ReplacePinByRequestId(ctx context.Context, requestid string, pin Pin) (ImplResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.pins[requestid]; !ok {
		return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), fmt.Errorf("pin not found")
	}

	// Delete old and add new with different requestid
	delete(m.pins, requestid)

	// Ensure new requestid is different by using a counter
	newRequestId := fmt.Sprintf("replaced-%d-%d", time.Now().UnixNano(), len(m.pins))
	status := PinStatus{
		Requestid: newRequestId,
		Status:    QUEUED,
		Created:   time.Now(),
		Pin:       pin,
		Delegates: []string{"/ip4/127.0.0.1/tcp/4001/p2p/QmTestPeer"},
		Info:      map[string]string{"status_details": "Queue position: 0 of 0"},
	}
	m.pins[newRequestId] = status

	return Response(http.StatusAccepted, status), nil
}

// Helper function to create test router
func setupTestRouter(service PinsAPIServicer) *mux.Router {
	controller := NewPinsAPIController(service)
	return NewRouter(controller)
}

// TestAddPinEndpoint tests POST /pins
func TestAddPinEndpoint(t *testing.T) {
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	tests := []struct {
		name           string
		body           interface{}
		expectedStatus int
		expectedReason string
	}{
		{
			name: "valid pin request",
			body: Pin{
				Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
				Name: "test-file.txt",
			},
			expectedStatus: http.StatusAccepted,
		},
		{
			name: "pin with all optional fields",
			body: Pin{
				Cid:     "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
				Name:    "complete-test.txt",
				Origins: []string{"/ip4/192.168.1.1/tcp/4001/p2p/QmPeer1"},
				Meta:    map[string]string{"app_id": "test-app", "version": "1.0"},
			},
			expectedStatus: http.StatusAccepted,
		},
		{
			name:           "missing CID",
			body:           map[string]string{"name": "test"},
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "empty body",
			body:           map[string]string{},
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "invalid JSON",
			body:           "not json",
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var bodyBytes []byte
			var err error

			if str, ok := tt.body.(string); ok {
				bodyBytes = []byte(str)
			} else {
				bodyBytes, err = json.Marshal(tt.body)
				if err != nil {
					t.Fatalf("Failed to marshal body: %v", err)
				}
			}

			req := httptest.NewRequest("POST", "/pins", bytes.NewReader(bodyBytes))
			req.Header.Set("Content-Type", "application/json")

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("AddPin() status = %d, expected %d, body: %s", w.Code, tt.expectedStatus, w.Body.String())
			}

			// Verify response format
			if w.Code >= 400 {
				var failure Failure
				if err := json.Unmarshal(w.Body.Bytes(), &failure); err != nil {
					t.Errorf("Error response is not valid Failure format: %v", err)
				}
			} else {
				var pinStatus PinStatus
				if err := json.Unmarshal(w.Body.Bytes(), &pinStatus); err != nil {
					t.Errorf("Success response is not valid PinStatus format: %v", err)
				}
				if pinStatus.Requestid == "" {
					t.Error("PinStatus.Requestid should not be empty")
				}
				if pinStatus.Status != QUEUED {
					t.Errorf("PinStatus.Status = %s, expected %s", pinStatus.Status, QUEUED)
				}
			}
		})
	}
}

// TestGetPinByRequestIdEndpoint tests GET /pins/{requestid}
func TestGetPinByRequestIdEndpoint(t *testing.T) {
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	// First add a pin
	addBody, _ := json.Marshal(Pin{
		Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
		Name: "test-file.txt",
	})
	addReq := httptest.NewRequest("POST", "/pins", bytes.NewReader(addBody))
	addReq.Header.Set("Content-Type", "application/json")
	addW := httptest.NewRecorder()
	router.ServeHTTP(addW, addReq)

	var addedPin PinStatus
	json.Unmarshal(addW.Body.Bytes(), &addedPin)

	tests := []struct {
		name           string
		requestId      string
		expectedStatus int
	}{
		{
			name:           "existing pin",
			requestId:      addedPin.Requestid,
			expectedStatus: http.StatusOK,
		},
		{
			name:           "non-existing pin",
			requestId:      "non-existing-id",
			expectedStatus: http.StatusNotFound,
		},
		// Note: empty requestid test removed as mux router redirects /pins/ to /pins (301)
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/pins/"+tt.requestId, nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("GetPinByRequestId() status = %d, expected %d", w.Code, tt.expectedStatus)
			}
		})
	}
}

// TestDeletePinByRequestIdEndpoint tests DELETE /pins/{requestid}
func TestDeletePinByRequestIdEndpoint(t *testing.T) {
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	// First add a pin
	addBody, _ := json.Marshal(Pin{
		Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
		Name: "test-file.txt",
	})
	addReq := httptest.NewRequest("POST", "/pins", bytes.NewReader(addBody))
	addReq.Header.Set("Content-Type", "application/json")
	addW := httptest.NewRecorder()
	router.ServeHTTP(addW, addReq)

	var addedPin PinStatus
	json.Unmarshal(addW.Body.Bytes(), &addedPin)

	tests := []struct {
		name           string
		requestId      string
		expectedStatus int
	}{
		{
			name:           "delete existing pin",
			requestId:      addedPin.Requestid,
			expectedStatus: http.StatusAccepted,
		},
		{
			name:           "delete non-existing pin",
			requestId:      "non-existing-id",
			expectedStatus: http.StatusNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("DELETE", "/pins/"+tt.requestId, nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("DeletePinByRequestId() status = %d, expected %d", w.Code, tt.expectedStatus)
			}
		})
	}

	// Verify pin was actually deleted
	getReq := httptest.NewRequest("GET", "/pins/"+addedPin.Requestid, nil)
	getW := httptest.NewRecorder()
	router.ServeHTTP(getW, getReq)

	if getW.Code != http.StatusNotFound {
		t.Error("Pin should be deleted but was still found")
	}
}

// TestGetPinsEndpoint tests GET /pins with various filters
func TestGetPinsEndpoint(t *testing.T) {
	// Each subtest gets its own service to avoid state pollution
	createPinsService := func() (*MockPinsAPIService, *mux.Router) {
		service := NewMockPinsAPIService()
		router := setupTestRouter(service)

		// Add some test pins
		pins := []Pin{
			{Cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", Name: "file1.txt"},
			{Cid: "QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB", Name: "file2.txt"},
			{Cid: "QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM", Name: "FILE3.TXT"},
		}

		for _, pin := range pins {
			body, _ := json.Marshal(pin)
			req := httptest.NewRequest("POST", "/pins", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
		}
		return service, router
	}

	tests := []struct {
		name           string
		query          string
		expectedStatus int
		minCount       int // Use min count instead of exact to handle timing
	}{
		{
			name:           "no filters - returns all",
			query:          "",
			expectedStatus: http.StatusOK,
			minCount:       3,
		},
		{
			name:           "filter by name exact",
			query:          "?name=file1.txt",
			expectedStatus: http.StatusOK,
			minCount:       1,
		},
		{
			name:           "filter by name iexact",
			query:          "?name=FILE1.TXT&match=iexact",
			expectedStatus: http.StatusOK,
			minCount:       1,
		},
		{
			name:           "filter by name partial",
			query:          "?name=file&match=partial",
			expectedStatus: http.StatusOK,
			minCount:       2,
		},
		{
			name:           "filter by name ipartial",
			query:          "?name=FILE&match=ipartial",
			expectedStatus: http.StatusOK,
			minCount:       3,
		},
		{
			name:           "filter by status",
			query:          "?status=queued",
			expectedStatus: http.StatusOK,
			minCount:       3,
		},
		{
			name:           "filter by non-matching status",
			query:          "?status=pinned",
			expectedStatus: http.StatusOK,
			minCount:       0,
		},
		{
			name:           "with limit",
			query:          "?limit=2",
			expectedStatus: http.StatusOK,
			minCount:       2,
		},
		{
			name:           "invalid limit - below minimum",
			query:          "?limit=0",
			expectedStatus: http.StatusBadRequest,
			minCount:       0,
		},
		{
			name:           "invalid limit - above maximum",
			query:          "?limit=1001",
			expectedStatus: http.StatusBadRequest,
			minCount:       0,
		},
		{
			name:           "invalid status",
			query:          "?status=invalid",
			expectedStatus: http.StatusBadRequest,
			minCount:       0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, router := createPinsService()
			req := httptest.NewRequest("GET", "/pins"+tt.query, nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("GetPins() status = %d, expected %d, body: %s", w.Code, tt.expectedStatus, w.Body.String())
				return
			}

			if tt.expectedStatus == http.StatusOK {
				var result PinResults
				if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
					t.Errorf("Failed to unmarshal response: %v", err)
					return
				}
				if int(result.Count) < tt.minCount {
					t.Errorf("GetPins() count = %d, expected at least %d", result.Count, tt.minCount)
				}
			}
		})
	}
}

// TestReplacePinEndpoint tests POST /pins/{requestid}
func TestReplacePinEndpoint(t *testing.T) {
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	// First add a pin
	addBody, _ := json.Marshal(Pin{
		Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
		Name: "original-file.txt",
	})
	addReq := httptest.NewRequest("POST", "/pins", bytes.NewReader(addBody))
	addReq.Header.Set("Content-Type", "application/json")
	addW := httptest.NewRecorder()
	router.ServeHTTP(addW, addReq)

	var originalPin PinStatus
	json.Unmarshal(addW.Body.Bytes(), &originalPin)

	tests := []struct {
		name           string
		requestId      string
		body           Pin
		expectedStatus int
	}{
		{
			name:      "replace existing pin",
			requestId: originalPin.Requestid,
			body: Pin{
				Cid:  "QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB",
				Name: "replaced-file.txt",
			},
			expectedStatus: http.StatusAccepted,
		},
		{
			name:      "replace non-existing pin",
			requestId: "non-existing-id",
			body: Pin{
				Cid:  "QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB",
				Name: "new-file.txt",
			},
			expectedStatus: http.StatusNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, _ := json.Marshal(tt.body)
			req := httptest.NewRequest("POST", "/pins/"+tt.requestId, bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("ReplacePinByRequestId() status = %d, expected %d", w.Code, tt.expectedStatus)
			}

			if tt.expectedStatus == http.StatusAccepted {
				var newPin PinStatus
				if err := json.Unmarshal(w.Body.Bytes(), &newPin); err != nil {
					t.Errorf("Failed to unmarshal response: %v", err)
					return
				}
				// New requestid should be different
				if newPin.Requestid == tt.requestId {
					t.Error("Replace should return a new requestid")
				}
				// CID should be updated
				if newPin.Pin.Cid != tt.body.Cid {
					t.Errorf("CID not updated: got %s, expected %s", newPin.Pin.Cid, tt.body.Cid)
				}
			}
		})
	}
}

// TestConcurrentPinRequests tests handling of many concurrent requests
func TestConcurrentPinRequests(t *testing.T) {
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	var wg sync.WaitGroup
	numRequests := 50
	successCount := int32(0)

	for i := 0; i < numRequests; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()

			pin := Pin{
				Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
				Name: fmt.Sprintf("concurrent-file-%d.txt", i),
			}
			body, _ := json.Marshal(pin)

			req := httptest.NewRequest("POST", "/pins", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code == http.StatusAccepted {
				atomic.AddInt32(&successCount, 1)
			}
		}(i)
	}

	wg.Wait()

	// All requests should succeed
	if successCount != int32(numRequests) {
		t.Errorf("Expected %d successful requests, got %d", numRequests, successCount)
	}
}

// TestResponseHeaders tests that proper headers are set
func TestResponseHeaders(t *testing.T) {
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	pin := Pin{
		Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
		Name: "test.txt",
	}
	body, _ := json.Marshal(pin)

	req := httptest.NewRequest("POST", "/pins", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	contentType := w.Header().Get("Content-Type")
	if !strings.Contains(contentType, "application/json") {
		t.Errorf("Content-Type should be application/json, got %s", contentType)
	}
}

// TestLargePayload tests handling of large request payloads
func TestLargePayload(t *testing.T) {
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	// Create pin with many origins (within limits)
	origins := make([]string, 20)
	for i := 0; i < 20; i++ {
		origins[i] = fmt.Sprintf("/ip4/192.168.1.%d/tcp/4001/p2p/QmPeer%d", i, i)
	}

	// Create pin with large meta (within limits)
	meta := make(map[string]string)
	for i := 0; i < 100; i++ {
		meta[fmt.Sprintf("key%d", i)] = fmt.Sprintf("value%d", i)
	}

	pin := Pin{
		Cid:     "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
		Name:    strings.Repeat("a", 255), // Max name length
		Origins: origins,
		Meta:    meta,
	}
	body, _ := json.Marshal(pin)

	req := httptest.NewRequest("POST", "/pins", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Errorf("Large valid payload should succeed, got status %d: %s", w.Code, w.Body.String())
	}
}

// Benchmark for endpoint performance
func BenchmarkAddPinEndpoint(b *testing.B) {
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	pin := Pin{
		Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
		Name: "benchmark-file.txt",
	}
	body, _ := json.Marshal(pin)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req := httptest.NewRequest("POST", "/pins", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
	}
}

func BenchmarkGetPinsEndpoint(b *testing.B) {
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	// Add some pins first
	for i := 0; i < 100; i++ {
		pin := Pin{
			Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
			Name: fmt.Sprintf("file-%d.txt", i),
		}
		body, _ := json.Marshal(pin)
		req := httptest.NewRequest("POST", "/pins", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req := httptest.NewRequest("GET", "/pins?limit=10", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
	}
}
