//go:build integration
// +build integration

package openapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"
)

// Integration tests for the IPFS Pinning Service
// These tests require a running mock blockchain server

// TestIntegrationFullPinLifecycle tests the complete pin lifecycle
func TestIntegrationFullPinLifecycle(t *testing.T) {
	if os.Getenv("RUN_INTEGRATION_TESTS") != "true" {
		t.Skip("Skipping integration test. Set RUN_INTEGRATION_TESTS=true to run.")
	}

	// This test requires a running server
	baseURL := os.Getenv("PINNING_SERVICE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:6000"
	}

	authToken := os.Getenv("TEST_AUTH_TOKEN")
	if authToken == "" {
		t.Skip("TEST_AUTH_TOKEN not set")
	}

	client := &http.Client{Timeout: 30 * time.Second}

	// Step 1: Add a pin
	pin := Pin{
		Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
		Name: "integration-test-file.txt",
		Meta: map[string]string{"test": "integration"},
	}
	pinBody, _ := json.Marshal(pin)

	addReq, _ := http.NewRequest("POST", baseURL+"/pins", bytes.NewReader(pinBody))
	addReq.Header.Set("Content-Type", "application/json")
	addReq.Header.Set("Authorization", "Bearer "+authToken)

	addResp, err := client.Do(addReq)
	if err != nil {
		t.Fatalf("Failed to add pin: %v", err)
	}
	defer addResp.Body.Close()

	if addResp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(addResp.Body)
		t.Fatalf("Add pin failed with status %d: %s", addResp.StatusCode, string(body))
	}

	var addedPin PinStatus
	if err := json.NewDecoder(addResp.Body).Decode(&addedPin); err != nil {
		t.Fatalf("Failed to decode add response: %v", err)
	}

	t.Logf("Added pin with requestid: %s", addedPin.Requestid)

	// Step 2: Get the pin by requestid
	getReq, _ := http.NewRequest("GET", baseURL+"/pins/"+addedPin.Requestid, nil)
	getReq.Header.Set("Authorization", "Bearer "+authToken)

	getResp, err := client.Do(getReq)
	if err != nil {
		t.Fatalf("Failed to get pin: %v", err)
	}
	defer getResp.Body.Close()

	if getResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(getResp.Body)
		t.Fatalf("Get pin failed with status %d: %s", getResp.StatusCode, string(body))
	}

	var gotPin PinStatus
	if err := json.NewDecoder(getResp.Body).Decode(&gotPin); err != nil {
		t.Fatalf("Failed to decode get response: %v", err)
	}

	if gotPin.Pin.Cid != pin.Cid {
		t.Errorf("Pin CID mismatch: got %s, want %s", gotPin.Pin.Cid, pin.Cid)
	}

	// Step 3: List pins and verify our pin is there
	listReq, _ := http.NewRequest("GET", baseURL+"/pins?name=integration-test-file.txt", nil)
	listReq.Header.Set("Authorization", "Bearer "+authToken)

	listResp, err := client.Do(listReq)
	if err != nil {
		t.Fatalf("Failed to list pins: %v", err)
	}
	defer listResp.Body.Close()

	if listResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(listResp.Body)
		t.Fatalf("List pins failed with status %d: %s", listResp.StatusCode, string(body))
	}

	var listResult PinResults
	if err := json.NewDecoder(listResp.Body).Decode(&listResult); err != nil {
		t.Fatalf("Failed to decode list response: %v", err)
	}

	found := false
	for _, p := range listResult.Results {
		if p.Requestid == addedPin.Requestid {
			found = true
			break
		}
	}
	if !found {
		t.Error("Added pin not found in list results")
	}

	// Step 4: Replace the pin
	newPin := Pin{
		Cid:  "QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB",
		Name: "replaced-integration-test-file.txt",
	}
	replaceBody, _ := json.Marshal(newPin)

	replaceReq, _ := http.NewRequest("POST", baseURL+"/pins/"+addedPin.Requestid, bytes.NewReader(replaceBody))
	replaceReq.Header.Set("Content-Type", "application/json")
	replaceReq.Header.Set("Authorization", "Bearer "+authToken)

	replaceResp, err := client.Do(replaceReq)
	if err != nil {
		t.Fatalf("Failed to replace pin: %v", err)
	}
	defer replaceResp.Body.Close()

	if replaceResp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(replaceResp.Body)
		t.Fatalf("Replace pin failed with status %d: %s", replaceResp.StatusCode, string(body))
	}

	var replacedPin PinStatus
	if err := json.NewDecoder(replaceResp.Body).Decode(&replacedPin); err != nil {
		t.Fatalf("Failed to decode replace response: %v", err)
	}

	t.Logf("Replaced pin with new requestid: %s", replacedPin.Requestid)

	// Step 5: Delete the pin
	deleteReq, _ := http.NewRequest("DELETE", baseURL+"/pins/"+replacedPin.Requestid, nil)
	deleteReq.Header.Set("Authorization", "Bearer "+authToken)

	deleteResp, err := client.Do(deleteReq)
	if err != nil {
		t.Fatalf("Failed to delete pin: %v", err)
	}
	defer deleteResp.Body.Close()

	if deleteResp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(deleteResp.Body)
		t.Fatalf("Delete pin failed with status %d: %s", deleteResp.StatusCode, string(body))
	}

	// Step 6: Verify pin is deleted
	time.Sleep(time.Second) // Give time for deletion to propagate

	verifyReq, _ := http.NewRequest("GET", baseURL+"/pins/"+replacedPin.Requestid, nil)
	verifyReq.Header.Set("Authorization", "Bearer "+authToken)

	verifyResp, err := client.Do(verifyReq)
	if err != nil {
		t.Fatalf("Failed to verify deletion: %v", err)
	}
	defer verifyResp.Body.Close()

	if verifyResp.StatusCode != http.StatusNotFound {
		t.Errorf("Expected 404 for deleted pin, got %d", verifyResp.StatusCode)
	}

	t.Log("Full pin lifecycle test completed successfully")
}

// TestIntegrationConcurrentUsers simulates multiple users making concurrent requests
func TestIntegrationConcurrentUsers(t *testing.T) {
	if os.Getenv("RUN_INTEGRATION_TESTS") != "true" {
		t.Skip("Skipping integration test. Set RUN_INTEGRATION_TESTS=true to run.")
	}

	baseURL := os.Getenv("PINNING_SERVICE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:6000"
	}

	authToken := os.Getenv("TEST_AUTH_TOKEN")
	if authToken == "" {
		t.Skip("TEST_AUTH_TOKEN not set")
	}

	client := &http.Client{Timeout: 30 * time.Second}
	numUsers := 10
	pinsPerUser := 5

	var wg sync.WaitGroup
	errors := make(chan error, numUsers*pinsPerUser)
	requestIds := make(chan string, numUsers*pinsPerUser)

	for user := 0; user < numUsers; user++ {
		wg.Add(1)
		go func(userID int) {
			defer wg.Done()

			for i := 0; i < pinsPerUser; i++ {
				pin := Pin{
					Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
					Name: fmt.Sprintf("user%d-file%d.txt", userID, i),
					Meta: map[string]string{
						"user_id": fmt.Sprintf("%d", userID),
						"file_id": fmt.Sprintf("%d", i),
					},
				}
				pinBody, _ := json.Marshal(pin)

				req, _ := http.NewRequest("POST", baseURL+"/pins", bytes.NewReader(pinBody))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer "+authToken)

				resp, err := client.Do(req)
				if err != nil {
					errors <- fmt.Errorf("user %d, file %d: request failed: %v", userID, i, err)
					continue
				}

				if resp.StatusCode != http.StatusAccepted {
					body, _ := io.ReadAll(resp.Body)
					resp.Body.Close()
					errors <- fmt.Errorf("user %d, file %d: status %d: %s", userID, i, resp.StatusCode, string(body))
					continue
				}

				var addedPin PinStatus
				if err := json.NewDecoder(resp.Body).Decode(&addedPin); err != nil {
					resp.Body.Close()
					errors <- fmt.Errorf("user %d, file %d: decode failed: %v", userID, i, err)
					continue
				}
				resp.Body.Close()

				requestIds <- addedPin.Requestid
			}
		}(user)
	}

	wg.Wait()
	close(errors)
	close(requestIds)

	// Check for errors
	errCount := 0
	for err := range errors {
		t.Error(err)
		errCount++
	}

	if errCount > 0 {
		t.Errorf("%d errors occurred during concurrent user test", errCount)
	}

	// Count successful pins
	successCount := 0
	for range requestIds {
		successCount++
	}

	expected := numUsers * pinsPerUser
	if successCount != expected {
		t.Errorf("Expected %d successful pins, got %d", expected, successCount)
	} else {
		t.Logf("Successfully created %d pins from %d concurrent users", successCount, numUsers)
	}
}

// TestIntegrationRateLimiting tests behavior under high load
func TestIntegrationRateLimiting(t *testing.T) {
	if os.Getenv("RUN_INTEGRATION_TESTS") != "true" {
		t.Skip("Skipping integration test. Set RUN_INTEGRATION_TESTS=true to run.")
	}

	baseURL := os.Getenv("PINNING_SERVICE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:6000"
	}

	authToken := os.Getenv("TEST_AUTH_TOKEN")
	if authToken == "" {
		t.Skip("TEST_AUTH_TOKEN not set")
	}

	client := &http.Client{Timeout: 5 * time.Second}
	numRequests := 100

	var wg sync.WaitGroup
	results := make(chan int, numRequests)

	start := time.Now()

	for i := 0; i < numRequests; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()

			req, _ := http.NewRequest("GET", baseURL+"/pins?limit=1", nil)
			req.Header.Set("Authorization", "Bearer "+authToken)

			resp, err := client.Do(req)
			if err != nil {
				results <- 0 // Error
				return
			}
			defer resp.Body.Close()

			results <- resp.StatusCode
		}(i)
	}

	wg.Wait()
	close(results)

	duration := time.Since(start)

	// Count results
	statusCounts := make(map[int]int)
	for status := range results {
		statusCounts[status]++
	}

	t.Logf("Completed %d requests in %v", numRequests, duration)
	for status, count := range statusCounts {
		t.Logf("  Status %d: %d requests", status, count)
	}

	// Most requests should succeed
	successRate := float64(statusCounts[http.StatusOK]) / float64(numRequests) * 100
	if successRate < 90 {
		t.Errorf("Success rate %.1f%% is below 90%% threshold", successRate)
	}
}

// TestIntegrationLargeFileMetadata tests handling of pins with large metadata
func TestIntegrationLargeFileMetadata(t *testing.T) {
	if os.Getenv("RUN_INTEGRATION_TESTS") != "true" {
		t.Skip("Skipping integration test. Set RUN_INTEGRATION_TESTS=true to run.")
	}

	baseURL := os.Getenv("PINNING_SERVICE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:6000"
	}

	authToken := os.Getenv("TEST_AUTH_TOKEN")
	if authToken == "" {
		t.Skip("TEST_AUTH_TOKEN not set")
	}

	client := &http.Client{Timeout: 30 * time.Second}

	// Create pin with maximum allowed metadata
	meta := make(map[string]string)
	for i := 0; i < 100; i++ {
		meta[fmt.Sprintf("key_%d", i)] = fmt.Sprintf("value_%d_with_some_additional_content", i)
	}

	origins := make([]string, 20)
	for i := 0; i < 20; i++ {
		origins[i] = fmt.Sprintf("/ip4/192.168.1.%d/tcp/4001/p2p/QmTestPeer%d", i, i)
	}

	pin := Pin{
		Cid:     "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
		Name:    "large-metadata-test-file.txt",
		Origins: origins,
		Meta:    meta,
	}
	pinBody, _ := json.Marshal(pin)

	req, _ := http.NewRequest("POST", baseURL+"/pins", bytes.NewReader(pinBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+authToken)

	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Failed to add pin with large metadata: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("Add pin with large metadata failed with status %d: %s", resp.StatusCode, string(body))
	}

	var addedPin PinStatus
	if err := json.NewDecoder(resp.Body).Decode(&addedPin); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	t.Logf("Successfully added pin with large metadata, requestid: %s", addedPin.Requestid)

	// Verify the metadata was stored correctly
	getReq, _ := http.NewRequest("GET", baseURL+"/pins/"+addedPin.Requestid, nil)
	getReq.Header.Set("Authorization", "Bearer "+authToken)

	getResp, err := client.Do(getReq)
	if err != nil {
		t.Fatalf("Failed to get pin: %v", err)
	}
	defer getResp.Body.Close()

	var gotPin PinStatus
	if err := json.NewDecoder(getResp.Body).Decode(&gotPin); err != nil {
		t.Fatalf("Failed to decode get response: %v", err)
	}

	if len(gotPin.Pin.Meta) != len(meta) {
		t.Errorf("Metadata count mismatch: got %d, want %d", len(gotPin.Pin.Meta), len(meta))
	}

	// Cleanup
	deleteReq, _ := http.NewRequest("DELETE", baseURL+"/pins/"+addedPin.Requestid, nil)
	deleteReq.Header.Set("Authorization", "Bearer "+authToken)
	client.Do(deleteReq)
}

// TestIntegrationMetaFiltering tests filtering by metadata
func TestIntegrationMetaFiltering(t *testing.T) {
	if os.Getenv("RUN_INTEGRATION_TESTS") != "true" {
		t.Skip("Skipping integration test. Set RUN_INTEGRATION_TESTS=true to run.")
	}

	baseURL := os.Getenv("PINNING_SERVICE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:6000"
	}

	authToken := os.Getenv("TEST_AUTH_TOKEN")
	if authToken == "" {
		t.Skip("TEST_AUTH_TOKEN not set")
	}

	client := &http.Client{Timeout: 30 * time.Second}

	// Create pins with different metadata
	appIDs := []string{"app-1", "app-2", "app-1"}
	var createdPins []string

	for i, appID := range appIDs {
		pin := Pin{
			Cid:  "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
			Name: fmt.Sprintf("meta-filter-test-%d.txt", i),
			Meta: map[string]string{"app_id": appID},
		}
		pinBody, _ := json.Marshal(pin)

		req, _ := http.NewRequest("POST", baseURL+"/pins", bytes.NewReader(pinBody))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+authToken)

		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Failed to add pin: %v", err)
		}

		if resp.StatusCode == http.StatusAccepted {
			var addedPin PinStatus
			json.NewDecoder(resp.Body).Decode(&addedPin)
			createdPins = append(createdPins, addedPin.Requestid)
		}
		resp.Body.Close()
	}

	// Filter by app_id
	metaFilter := `{"app_id":"app-1"}`
	listReq, _ := http.NewRequest("GET", baseURL+"/pins?meta="+metaFilter, nil)
	listReq.Header.Set("Authorization", "Bearer "+authToken)

	listResp, err := client.Do(listReq)
	if err != nil {
		t.Fatalf("Failed to list pins with meta filter: %v", err)
	}
	defer listResp.Body.Close()

	if listResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(listResp.Body)
		t.Fatalf("List pins with meta filter failed: %s", string(body))
	}

	var listResult PinResults
	json.NewDecoder(listResp.Body).Decode(&listResult)

	// Should find 2 pins with app_id="app-1"
	app1Count := 0
	for _, p := range listResult.Results {
		if p.Pin.Meta["app_id"] == "app-1" {
			app1Count++
		}
	}

	t.Logf("Found %d pins with app_id=app-1", app1Count)

	// Cleanup
	for _, requestID := range createdPins {
		deleteReq, _ := http.NewRequest("DELETE", baseURL+"/pins/"+requestID, nil)
		deleteReq.Header.Set("Authorization", "Bearer "+authToken)
		client.Do(deleteReq)
	}
}

// MockBlockchainServer creates a test server that mocks the blockchain API
func MockBlockchainServer() *httptest.Server {
	manifests := make(map[string]interface{})
	var mu sync.Mutex

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/account/seeded":
			var req map[string]string
			json.NewDecoder(r.Body).Decode(&req)
			json.NewEncoder(w).Encode(map[string]string{
				"seed":    req["seed"],
				"account": "5DTestAccount",
			})

		case "/account/balance":
			json.NewEncoder(w).Encode(map[string]int64{
				"amount": 9999999999,
			})

		case "/account/set_balance":
			json.NewEncoder(w).Encode(map[string]bool{
				"success": true,
			})

		case "/fula/manifest/batch_upload":
			var req map[string]interface{}
			json.NewDecoder(r.Body).Decode(&req)

			mu.Lock()
			if cids, ok := req["cid"].([]interface{}); ok && len(cids) > 0 {
				cid := cids[0].(string)
				manifests[cid] = map[string]interface{}{
					"cid":                   cid,
					"replication_available": 6,
				}
			}
			mu.Unlock()

			json.NewEncoder(w).Encode(map[string]string{
				"message":     "Success",
				"description": "Manifest created",
			})

		case "/fula/manifest/available_batch":
			var req map[string]interface{}
			json.NewDecoder(r.Body).Decode(&req)

			result := map[string]interface{}{
				"manifests": []interface{}{},
			}

			mu.Lock()
			if cids, ok := req["cids"].([]interface{}); ok {
				for _, cid := range cids {
					if manifest, exists := manifests[cid.(string)]; exists {
						result["manifests"] = append(result["manifests"].([]interface{}), manifest)
					}
				}
			}
			mu.Unlock()

			json.NewEncoder(w).Encode(result)

		case "/fula/manifest/remove":
			var req map[string]interface{}
			json.NewDecoder(r.Body).Decode(&req)

			mu.Lock()
			if cid, ok := req["cid"].(string); ok {
				delete(manifests, cid)
			}
			mu.Unlock()

			json.NewEncoder(w).Encode(map[string]string{
				"message":     "Success",
				"description": "Manifest removed",
			})

		default:
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "Not found",
			})
		}
	}))
}

// TestWithMockBlockchain runs tests with a mock blockchain server
func TestWithMockBlockchain(t *testing.T) {
	server := MockBlockchainServer()
	defer server.Close()

	t.Logf("Mock blockchain server running at: %s", server.URL)

	// Test account seeded endpoint
	t.Run("account/seeded", func(t *testing.T) {
		reqBody, _ := json.Marshal(map[string]string{"seed": "//testhash"})
		resp, err := http.Post(server.URL+"/account/seeded", "application/json", bytes.NewReader(reqBody))
		if err != nil {
			t.Fatalf("Request failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected 200, got %d", resp.StatusCode)
		}

		var result map[string]string
		json.NewDecoder(resp.Body).Decode(&result)
		if result["account"] != "5DTestAccount" {
			t.Errorf("Unexpected account: %s", result["account"])
		}
	})

	// Test manifest batch upload
	t.Run("manifest/batch_upload", func(t *testing.T) {
		reqBody, _ := json.Marshal(map[string]interface{}{
			"seed":               "//testhash",
			"replication_factor": []int{6},
			"pool_id":            []int{1},
			"cid":                []string{"QmTestCid"},
		})
		resp, err := http.Post(server.URL+"/fula/manifest/batch_upload", "application/json", bytes.NewReader(reqBody))
		if err != nil {
			t.Fatalf("Request failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected 200, got %d", resp.StatusCode)
		}
	})

	// Test manifest available
	t.Run("manifest/available_batch", func(t *testing.T) {
		reqBody, _ := json.Marshal(map[string]interface{}{
			"pool_id":  1,
			"uploader": "5DTestAccount",
			"cids":     []string{"QmTestCid"},
		})
		resp, err := http.Post(server.URL+"/fula/manifest/available_batch", "application/json", bytes.NewReader(reqBody))
		if err != nil {
			t.Fatalf("Request failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected 200, got %d", resp.StatusCode)
		}

		var result map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&result)
		manifests := result["manifests"].([]interface{})
		if len(manifests) != 1 {
			t.Errorf("Expected 1 manifest, got %d", len(manifests))
		}
	})
}
