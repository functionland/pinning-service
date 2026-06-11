package openapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// buildCarMultipart builds a multipart/form-data body with an optional name
// field and a file part.
func buildCarMultipart(t *testing.T, name string, fileContent []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if name != "" {
		if err := w.WriteField("name", name); err != nil {
			t.Fatalf("WriteField: %v", err)
		}
	}
	fw, err := w.CreateFormFile("file", "test.car")
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(fileContent); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return &buf, w.FormDataContentType()
}

func TestImportDagEndpoint_FlagOff(t *testing.T) {
	t.Setenv("DAG_IMPORT_ENABLED", "false")
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	body, contentType := buildCarMultipart(t, "", []byte("car bytes"))
	req := httptest.NewRequest(http.MethodPost, "/pins/import/car", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("flag off: code = %d, want 404", rec.Code)
	}
	if len(service.importedNames) != 0 {
		t.Errorf("flag off must not reach the service")
	}
}

func TestImportDagEndpoint_Success(t *testing.T) {
	t.Setenv("DAG_IMPORT_ENABLED", "true")
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	carBytes := []byte("pretend this is a car file payload")
	body, contentType := buildCarMultipart(t, "pretty name", carBytes)
	req := httptest.NewRequest(http.MethodPost, "/pins/import/car", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202 (body: %s)", rec.Code, rec.Body.String())
	}
	var status PinStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if status.Requestid == "" {
		t.Errorf("empty requestid in response")
	}

	service.mu.RLock()
	defer service.mu.RUnlock()
	if len(service.importedNames) != 1 || service.importedNames[0] != "pretty name" {
		t.Errorf("service saw names %v, want [pretty name]", service.importedNames)
	}
	if len(service.importedSizes) != 1 || service.importedSizes[0] != int64(len(carBytes)) {
		t.Errorf("service saw sizes %v, want [%d]", service.importedSizes, len(carBytes))
	}
}

func TestImportDagEndpoint_MissingFilePart(t *testing.T) {
	t.Setenv("DAG_IMPORT_ENABLED", "true")
	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("name", "no file here")
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/pins/import/car", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}

func TestImportDagEndpoint_NotMultipart(t *testing.T) {
	t.Setenv("DAG_IMPORT_ENABLED", "true")
	router := setupTestRouter(NewMockPinsAPIService())

	req := httptest.NewRequest(http.MethodPost, "/pins/import/car", bytes.NewBufferString(`{"cid":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}

func TestImportDagEndpoint_TooLargeContentLength(t *testing.T) {
	t.Setenv("DAG_IMPORT_ENABLED", "true")
	t.Setenv("DAG_IMPORT_MAX_CAR_BYTES", "1024")
	router := setupTestRouter(NewMockPinsAPIService())

	// 2 MiB body: Content-Length (set automatically from the buffer) exceeds
	// max + 1MiB margin → rejected before reading the body.
	body, contentType := buildCarMultipart(t, "", make([]byte, 2<<20))
	req := httptest.NewRequest(http.MethodPost, "/pins/import/car", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("code = %d, want 413", rec.Code)
	}
}

func TestImportDagEndpoint_TooLargeChunked(t *testing.T) {
	t.Setenv("DAG_IMPORT_ENABLED", "true")
	t.Setenv("DAG_IMPORT_MAX_CAR_BYTES", "1024")
	router := setupTestRouter(NewMockPinsAPIService())

	// Unknown Content-Length (chunked): the precheck can't fire, so the
	// MaxBytesReader must catch the oversized body mid-copy.
	body, contentType := buildCarMultipart(t, "", make([]byte, 2<<20))
	req := httptest.NewRequest(http.MethodPost, "/pins/import/car", io.NopCloser(body))
	req.ContentLength = -1
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("code = %d, want 413 (body: %s)", rec.Code, rec.Body.String())
	}
}

// TestImportDagRouteDisambiguation guards the /pins/import/car vs
// /pins/{requestid} routing. Routes are registered from a map (random
// iteration order), so we instantiate several routers to cover orderings.
func TestImportDagRouteDisambiguation(t *testing.T) {
	t.Setenv("DAG_IMPORT_ENABLED", "true")

	for i := 0; i < 10; i++ {
		service := NewMockPinsAPIService()
		router := setupTestRouter(service)

		// 3-segment path → ImportDag.
		body, contentType := buildCarMultipart(t, "", []byte("car"))
		req := httptest.NewRequest(http.MethodPost, "/pins/import/car", body)
		req.Header.Set("Content-Type", contentType)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("iteration %d: import/car code = %d, want 202", i, rec.Code)
		}

		// 2-segment POST → ReplacePinByRequestId, even with requestid="import"
		// (mock 404s for unknown ids — proof the Replace handler ran).
		jsonBody := bytes.NewBufferString(`{"cid":"QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"}`)
		req2 := httptest.NewRequest(http.MethodPost, "/pins/import", jsonBody)
		req2.Header.Set("Content-Type", "application/json")
		rec2 := httptest.NewRecorder()
		router.ServeHTTP(rec2, req2)
		if rec2.Code != http.StatusNotFound {
			t.Fatalf("iteration %d: POST /pins/import code = %d, want 404 from Replace handler", i, rec2.Code)
		}

		service.mu.RLock()
		imports := len(service.importedNames)
		service.mu.RUnlock()
		if imports != 1 {
			t.Fatalf("iteration %d: service saw %d imports, want exactly 1", i, imports)
		}
	}
}

// TestImportDagEndpoint_CustomSpoolDir: DAG_IMPORT_TMP_DIR routes the upload
// spool to a configurable directory (created on demand) — the escape hatch
// for systemd-hardened deployments where /tmp is read-only.
func TestImportDagEndpoint_CustomSpoolDir(t *testing.T) {
	t.Setenv("DAG_IMPORT_ENABLED", "true")
	spool := filepath.Join(t.TempDir(), "nested", "spool") // does not exist yet
	t.Setenv("DAG_IMPORT_TMP_DIR", spool)

	service := NewMockPinsAPIService()
	router := setupTestRouter(service)

	body, contentType := buildCarMultipart(t, "", []byte("car payload"))
	req := httptest.NewRequest(http.MethodPost, "/pins/import/car", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202 (body: %s)", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(spool); err != nil {
		t.Errorf("spool dir was not created: %v", err)
	}
	if len(service.importedSizes) != 1 {
		t.Fatalf("service saw %d imports, want 1", len(service.importedSizes))
	}
}

// blockingImportService wraps the mock so ImportDag blocks until released —
// used to hold concurrency slots open.
type blockingImportService struct {
	*MockPinsAPIService
	entered int32
	gate    chan struct{}
}

func (b *blockingImportService) ImportDag(ctx context.Context, carPath string, name string, onDone func()) (ImplResponse, error) {
	atomic.AddInt32(&b.entered, 1)
	<-b.gate
	return b.MockPinsAPIService.ImportDag(ctx, carPath, name, onDone)
}

// TestImportDagEndpoint_ConcurrencyLimit: the global import cap yields 429
// when exhausted and recovers once imports finish. The mock has no
// ResolveUserID, so the controller keys on "" (global-only) — exactly the
// global cap is under test here; per-user behavior is covered by
// TestImportLimiter_PerUserAndGlobal. We pin the process-wide limiter to a
// global cap of 2 so the test is deterministic regardless of run order.
func TestImportDagEndpoint_ConcurrencyLimit(t *testing.T) {
	t.Setenv("DAG_IMPORT_ENABLED", "true")
	importLimiterOnce.Do(func() {}) // consume the once so acquireImportSlot won't re-init
	globalImportLim = newImportLimiter(2, 1)

	service := &blockingImportService{
		MockPinsAPIService: NewMockPinsAPIService(),
		gate:               make(chan struct{}),
	}
	router := setupTestRouter(service)

	post := func() int {
		body, contentType := buildCarMultipart(t, "", []byte("car"))
		req := httptest.NewRequest(http.MethodPost, "/pins/import/car", body)
		req.Header.Set("Content-Type", contentType)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}

	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = post()
		}(i)
	}

	// Wait until both in-flight imports hold their slots.
	deadline := time.Now().Add(5 * time.Second)
	for atomic.LoadInt32(&service.entered) < 2 {
		if time.Now().After(deadline) {
			close(service.gate)
			t.Fatal("blocked imports never entered the service")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if code := post(); code != http.StatusTooManyRequests {
		close(service.gate)
		t.Fatalf("third concurrent import code = %d, want 429", code)
	}

	close(service.gate)
	wg.Wait()
	for i, code := range codes {
		if code != http.StatusAccepted {
			t.Errorf("blocked import %d finished with %d, want 202", i, code)
		}
	}

	// Slots released → a new import succeeds.
	if code := post(); code != http.StatusAccepted {
		t.Errorf("post-release import code = %d, want 202", code)
	}
}
