package openapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/ipfs-cluster/ipfs-cluster/api"
	clusterapi "github.com/ipfs-cluster/ipfs-cluster/api/rest/client"
	ipfspath "github.com/ipfs/boxo/path"
	ipfsrpc "github.com/ipfs/kubo/client/rpc"
)

// PinsAPIServiceSQLite implements PinsAPIServicer using SQLite
type PinsAPIServiceSQLite struct {
	db                    *SQLiteService
	userService           *UserServiceSQLite
	ipfsAPI               *ipfsrpc.HttpApi
	ipfsClusterAPI        clusterapi.Client
	blockchainAPIEndpoint string
	masterSeed            string
	poolSeed              string
	poolId                int
}

// NewPinsAPIServiceSQLite creates a new pins API service with SQLite backend
func NewPinsAPIServiceSQLite(db *SQLiteService, userService *UserServiceSQLite, ipfsAPI *ipfsrpc.HttpApi, ipfsClusterAPI clusterapi.Client, blockchainAPIEndpoint, masterSeed, poolSeed string, poolId int) *PinsAPIServiceSQLite {
	return &PinsAPIServiceSQLite{
		db:                    db,
		userService:           userService,
		ipfsAPI:               ipfsAPI,
		ipfsClusterAPI:        ipfsClusterAPI,
		blockchainAPIEndpoint: blockchainAPIEndpoint,
		masterSeed:            masterSeed,
		poolSeed:              poolSeed,
		poolId:                poolId,
	}
}

// AddPin adds a new pin
func (s *PinsAPIServiceSQLite) AddPin(ctx context.Context, pin Pin) (ImplResponse, error) {
	// Validate pin input
	if err := validatePin(pin); err != nil {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", err.Error()), err
	}

	ipfsExists := false
	exists, err := s.cidExistsInIPFS(ctx, pin.Cid)
	if err != nil {
		log.Printf("Warning: failed to check CID existence in IPFS: %v", err)
		ipfsExists = false
	} else {
		ipfsExists = exists
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	var uploadStatus string
	if ipfsExists {
		uploadStatus = "uploaded"
	} else {
		uploadStatus = "pending"
	}

	requestId, err := s.db.AddPin(ctx, userID, pin, uploadStatus)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to add pin"), err
	}

	// Handle blockchain manifest upload asynchronously
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		if err := s.handleManifestUpload(bgCtx, pin.Cid, requestId); err != nil {
			log.Printf("Failed to upload manifest for CID %s: %v", pin.Cid, err)
		}
	}()

	status := PinStatus{
		Requestid: requestId,
		Status:    QUEUED,
		Created:   time.Now(),
		Pin:       pin,
		Delegates: []string{},
		Info:      map[string]string{"status_details": "Queue position: 0 of 0"},
	}

	return Response(http.StatusAccepted, status), nil
}

// DeletePinByRequestId deletes a pin
func (s *PinsAPIServiceSQLite) DeletePinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	if requestid == "" {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "requestid is required"), errors.New("requestid is required")
	}

	pinStatus, username, err := s.db.GetPinByRequestID(ctx, requestid)
	if err != nil {
		return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), err
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	if username != userID {
		return createErrorResponse(http.StatusForbidden, "FORBIDDEN", "You don't have permission to delete this pin"), errors.New("unauthorized")
	}

	// Mark pin as deleted first
	if err := s.db.MarkPinAsDeleted(ctx, requestid); err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to delete pin"), err
	}

	// Handle blockchain manifest removal asynchronously
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		if err := s.handleManifestRemoval(bgCtx, pinStatus.Pin.Cid, requestid); err != nil {
			log.Printf("Failed to remove manifest for CID %s: %v", pinStatus.Pin.Cid, err)
			s.db.MarkPinAsDeleteFailed(context.Background(), requestid)
		}
	}()

	return Response(http.StatusAccepted, nil), nil
}

// GetPinByRequestId retrieves a pin by request ID
func (s *PinsAPIServiceSQLite) GetPinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	if requestid == "" {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "requestid is required"), errors.New("requestid is required")
	}

	pinStatus, username, err := s.db.GetPinByRequestID(ctx, requestid)
	if err != nil {
		return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), err
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	if username != userID {
		return createErrorResponse(http.StatusForbidden, "FORBIDDEN", "You don't have permission to view this pin"), errors.New("unauthorized")
	}

	// Update status from IPFS cluster if available
	if s.ipfsClusterAPI != nil {
		clusterStatus, err := s.getClusterStatus(ctx, pinStatus.Pin.Cid)
		if err == nil {
			pinStatus.Status = mapStatus(clusterStatus)
		}
	}

	return Response(http.StatusOK, pinStatus), nil
}

// GetPins retrieves pins with filtering
func (s *PinsAPIServiceSQLite) GetPins(ctx context.Context, cid []string, name string, match TextMatchingStrategy, status []Status, before time.Time, after time.Time, limit int32, meta map[string]string) (ImplResponse, error) {
	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	pins, count, err := s.db.GetPins(ctx, userID, cid, name, match, status, before, after, int(limit), meta)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to retrieve pins"), err
	}

	var results []PinStatus
	for _, p := range pins {
		ps := PinStatus{
			Requestid: p.RequestId,
			Status:    QUEUED,
			Created:   p.Created,
			Pin:       p.Pin,
			Delegates: []string{},
			Info:      map[string]string{},
		}

		// Update status from IPFS cluster if available
		if s.ipfsClusterAPI != nil {
			clusterStatus, err := s.getClusterStatus(ctx, p.Pin.Cid)
			if err == nil {
				ps.Status = mapStatus(clusterStatus)
			}
		}

		results = append(results, ps)
	}

	return Response(http.StatusOK, PinResults{
		Count:   int32(count),
		Results: results,
	}), nil
}

// ReplacePinByRequestId replaces an existing pin
func (s *PinsAPIServiceSQLite) ReplacePinByRequestId(ctx context.Context, requestid string, pin Pin) (ImplResponse, error) {
	if requestid == "" {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "requestid is required"), errors.New("requestid is required")
	}

	if err := validatePin(pin); err != nil {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", err.Error()), err
	}

	// Verify the pin exists and belongs to the user
	_, username, err := s.db.GetPinByRequestID(ctx, requestid)
	if err != nil {
		return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), err
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	if username != userID {
		return createErrorResponse(http.StatusForbidden, "FORBIDDEN", "You don't have permission to modify this pin"), errors.New("unauthorized")
	}

	// Delete old pin and add new one
	if err := s.db.DeletePin(ctx, requestid); err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to replace pin"), err
	}

	// Add new pin
	return s.AddPin(ctx, pin)
}

// Helper methods

func (s *PinsAPIServiceSQLite) extractUserIDFromAuth(ctx context.Context) (string, error) {
	token, err := extractAuthTokenFromContext(ctx)
	if err != nil {
		return "", err
	}
	return s.db.GetUserIDFromToken(ctx, token, "extractUserIDFromAuth")
}

func (s *PinsAPIServiceSQLite) cidExistsInIPFS(ctx context.Context, cidStr string) (bool, error) {
	if s.ipfsAPI == nil {
		return false, nil
	}

	path, err := ipfspath.NewPath("/ipfs/" + cidStr)
	if err != nil {
		return false, err
	}

	_, err = s.ipfsAPI.Block().Stat(ctx, path)
	if err != nil {
		return false, nil
	}
	return true, nil
}

func (s *PinsAPIServiceSQLite) getClusterStatus(ctx context.Context, cidStr string) (string, error) {
	if s.ipfsClusterAPI == nil {
		return "queued", nil
	}

	cid, err := api.DecodeCid(cidStr)
	if err != nil {
		return "queued", err
	}

	pinInfo, err := s.ipfsClusterAPI.Status(ctx, cid, false)
	if err != nil {
		return "queued", err
	}

	for _, peerInfo := range pinInfo.PeerMap {
		return peerInfo.Status.String(), nil
	}

	return "queued", nil
}

func (s *PinsAPIServiceSQLite) handleManifestUpload(ctx context.Context, cidStr string, requestId string) error {
	poolIdForUser, err := s.getPoolIdForRequest(ctx, requestId)
	if err != nil {
		poolIdForUser = s.poolId
	}

	payload := map[string]interface{}{
		"cid":     []string{cidStr},
		"pool_id": poolIdForUser,
	}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	// Retry logic
	var lastErr error
	for i := 0; i < 3; i++ {
		req, err := http.NewRequestWithContext(ctx, "POST", s.blockchainAPIEndpoint+"/fula/manifest/batch_upload", bytes.NewBuffer(jsonPayload))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+s.masterSeed)

		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			time.Sleep(time.Duration(i+1) * time.Second)
			continue
		}
		resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			s.db.UpdatePinStatus(context.Background(), requestId, "manifest_uploaded")
			return nil
		}
		lastErr = fmt.Errorf("unexpected status code: %d", resp.StatusCode)
		time.Sleep(time.Duration(i+1) * time.Second)
	}

	return lastErr
}

func (s *PinsAPIServiceSQLite) handleManifestRemoval(ctx context.Context, cidStr string, requestId string) error {
	poolIdForUser, err := s.getPoolIdForRequest(ctx, requestId)
	if err != nil {
		poolIdForUser = s.poolId
	}

	payload := map[string]interface{}{
		"cid":     cidStr,
		"pool_id": poolIdForUser,
	}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	// Retry logic
	var lastErr error
	for i := 0; i < 3; i++ {
		req, err := http.NewRequestWithContext(ctx, "POST", s.blockchainAPIEndpoint+"/fula/manifest/remove", bytes.NewBuffer(jsonPayload))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+s.masterSeed)

		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			time.Sleep(time.Duration(i+1) * time.Second)
			continue
		}
		resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}
		lastErr = fmt.Errorf("unexpected status code: %d", resp.StatusCode)
		time.Sleep(time.Duration(i+1) * time.Second)
	}

	return lastErr
}

func (s *PinsAPIServiceSQLite) getPoolIdForRequest(ctx context.Context, requestId string) (int, error) {
	_, username, err := s.db.GetPinByRequestID(ctx, requestId)
	if err != nil {
		return s.poolId, err
	}

	poolId, err := s.db.GetUserPoolID(ctx, username)
	if err != nil {
		return s.poolId, err
	}

	return poolId, nil
}

// Note: generateRequestID is defined in api_pins_service.go
