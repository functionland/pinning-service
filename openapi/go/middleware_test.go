package openapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestInjectRequestIntoContext tests the request context injection middleware
func TestInjectRequestIntoContext(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify the request is in context
		req, err := GetRequestFromContext(r.Context())
		if err != nil {
			t.Errorf("Failed to get request from context: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if req == nil {
			t.Error("Request from context is nil")
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	middleware := InjectRequestIntoContext(handler)

	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()

	middleware.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}
}

// TestGetRequestFromContext tests retrieving request from context
func TestGetRequestFromContext(t *testing.T) {
	tests := []struct {
		name    string
		ctx     context.Context
		wantErr bool
	}{
		{
			name:    "context without request",
			ctx:     context.Background(),
			wantErr: true,
		},
		{
			name:    "context with request",
			ctx:     context.WithValue(context.Background(), requestContextKey, httptest.NewRequest("GET", "/", nil)),
			wantErr: false,
		},
		{
			name:    "context with wrong type",
			ctx:     context.WithValue(context.Background(), requestContextKey, "not a request"),
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := GetRequestFromContext(tt.ctx)
			if (err != nil) != tt.wantErr {
				t.Errorf("GetRequestFromContext() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// TestExtractAuthTokenFromContext tests auth token extraction
func TestExtractAuthTokenFromContext(t *testing.T) {
	tests := []struct {
		name       string
		authHeader string
		wantErr    bool
		wantToken  string
	}{
		{
			name:       "valid bearer token",
			authHeader: "Bearer test-token-123",
			wantErr:    false,
			wantToken:  "test-token-123",
		},
		{
			name:       "missing auth header",
			authHeader: "",
			wantErr:    true,
		},
		{
			name:       "malformed token - no Bearer prefix",
			authHeader: "test-token-123",
			wantErr:    true,
		},
		{
			name:       "malformed token - wrong prefix",
			authHeader: "Basic test-token-123",
			wantErr:    true,
		},
		{
			name:       "bearer with empty token",
			authHeader: "Bearer ",
			wantErr:    false,
			wantToken:  "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}
			ctx := context.WithValue(context.Background(), requestContextKey, req)

			token, err := extractAuthTokenFromContext(ctx)
			if (err != nil) != tt.wantErr {
				t.Errorf("extractAuthTokenFromContext() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr && token != tt.wantToken {
				t.Errorf("extractAuthTokenFromContext() token = %v, want %v", token, tt.wantToken)
			}
		})
	}
}

// TestCreateErrorResponse tests error response creation
func TestCreateErrorResponse(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		reason     string
		details    string
	}{
		{
			name:       "bad request error",
			statusCode: http.StatusBadRequest,
			reason:     "BAD_REQUEST",
			details:    "Invalid CID format",
		},
		{
			name:       "unauthorized error",
			statusCode: http.StatusUnauthorized,
			reason:     "UNAUTHORIZED",
			details:    "Token expired",
		},
		{
			name:       "not found error",
			statusCode: http.StatusNotFound,
			reason:     "NOT_FOUND",
			details:    "Pin not found",
		},
		{
			name:       "internal server error",
			statusCode: http.StatusInternalServerError,
			reason:     "INTERNAL_SERVER_ERROR",
			details:    "Database connection failed",
		},
		{
			name:       "insufficient funds",
			statusCode: http.StatusConflict,
			reason:     "INSUFFICIENT_FUNDS",
			details:    "Not enough balance",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := createErrorResponse(tt.statusCode, tt.reason, tt.details)

			if resp.Code != tt.statusCode {
				t.Errorf("createErrorResponse() Code = %d, want %d", resp.Code, tt.statusCode)
			}

			failure, ok := resp.Body.(Failure)
			if !ok {
				t.Error("createErrorResponse() Body is not of type Failure")
				return
			}

			if failure.Error.Reason != tt.reason {
				t.Errorf("createErrorResponse() Reason = %s, want %s", failure.Error.Reason, tt.reason)
			}

			if failure.Error.Details != tt.details {
				t.Errorf("createErrorResponse() Details = %s, want %s", failure.Error.Details, tt.details)
			}
		})
	}
}

// TestCreateErrorResponseJSON tests JSON error response writing
func TestCreateErrorResponseJSON(t *testing.T) {
	resp := createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "Test error")

	w := httptest.NewRecorder()
	createErrorResponseJSON(w, resp)

	// Check status code
	if w.Code != http.StatusBadRequest {
		t.Errorf("Status code = %d, want %d", w.Code, http.StatusBadRequest)
	}

	// Check content type
	contentType := w.Header().Get("Content-Type")
	if contentType != "application/json" {
		t.Errorf("Content-Type = %s, want application/json", contentType)
	}

	// Check response body
	var failure Failure
	if err := json.Unmarshal(w.Body.Bytes(), &failure); err != nil {
		t.Errorf("Failed to unmarshal response: %v", err)
		return
	}

	if failure.Error.Reason != "BAD_REQUEST" {
		t.Errorf("Response Reason = %s, want BAD_REQUEST", failure.Error.Reason)
	}
}

// TestResponseCaptureWriter tests the response capture writer
func TestResponseCaptureWriter(t *testing.T) {
	w := httptest.NewRecorder()
	captureWriter := &responseCaptureWriter{
		ResponseWriter: w,
		body:           &bytes.Buffer{},
	}

	// Write status
	captureWriter.WriteHeader(http.StatusCreated)
	if captureWriter.status != http.StatusCreated {
		t.Errorf("status = %d, want %d", captureWriter.status, http.StatusCreated)
	}

	// Write body
	testBody := []byte(`{"test": "data"}`)
	n, err := captureWriter.Write(testBody)
	if err != nil {
		t.Errorf("Write() error = %v", err)
	}
	if n != len(testBody) {
		t.Errorf("Write() n = %d, want %d", n, len(testBody))
	}

	// Check captured body
	if captureWriter.body.String() != string(testBody) {
		t.Errorf("Captured body = %s, want %s", captureWriter.body.String(), string(testBody))
	}

	// Check underlying writer also got the data
	if w.Body.String() != string(testBody) {
		t.Errorf("Underlying writer body = %s, want %s", w.Body.String(), string(testBody))
	}
}

// TestRequestTimeout tests that request context has timeout
func TestRequestTimeout(t *testing.T) {
	timeoutReached := make(chan bool, 1)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			timeoutReached <- true
		case <-time.After(100 * time.Second):
			timeoutReached <- false
		}
	})

	// Create a handler that checks context deadline
	checkHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deadline, ok := r.Context().Deadline()
		if !ok {
			t.Error("Context should have a deadline")
			return
		}

		// Deadline should be roughly 90 seconds from now (based on InjectRequestIntoContext)
		expectedDeadline := time.Now().Add(90 * time.Second)
		diff := deadline.Sub(expectedDeadline)
		if diff > time.Second || diff < -time.Second {
			t.Errorf("Deadline is not approximately 90 seconds from now, diff: %v", diff)
		}

		w.WriteHeader(http.StatusOK)
	})

	middleware := InjectRequestIntoContext(checkHandler)

	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()

	middleware.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Also test handler that would timeout (but we won't wait for full timeout)
	_ = handler // Referenced to avoid unused variable
}

// BenchmarkInjectRequestIntoContext benchmarks the middleware
func BenchmarkInjectRequestIntoContext(b *testing.B) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	middleware := InjectRequestIntoContext(handler)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req := httptest.NewRequest("GET", "/test", nil)
		w := httptest.NewRecorder()
		middleware.ServeHTTP(w, req)
	}
}

// BenchmarkExtractAuthToken benchmarks token extraction
func BenchmarkExtractAuthToken(b *testing.B) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer test-token-123456789")
	ctx := context.WithValue(context.Background(), requestContextKey, req)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = extractAuthTokenFromContext(ctx)
	}
}

// BenchmarkCreateErrorResponse benchmarks error response creation
func BenchmarkCreateErrorResponse(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "Test error message")
	}
}
