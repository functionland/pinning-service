package openapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	db                *SQLiteService
	userService       *UserServiceSQLite
	ipfsAPI           *ipfsrpc.HttpApi
	ipfsClusterAPI    clusterapi.Client
	enableIPFSPinning bool   // If true, pin to both IPFS and IPFS Cluster; if false, only IPFS Cluster
	ipfsHTTPURL       string // HTTP URL for IPFS API (e.g., "http://127.0.0.1:5001")
}

// NewPinsAPIServiceSQLite creates a new pins API service with SQLite backend
func NewPinsAPIServiceSQLite(db *SQLiteService, userService *UserServiceSQLite, ipfsAPI *ipfsrpc.HttpApi, ipfsClusterAPI clusterapi.Client, enableIPFSPinning bool, ipfsHTTPURL string) *PinsAPIServiceSQLite {
	if ipfsHTTPURL == "" {
		ipfsHTTPURL = "http://127.0.0.1:5001"
	}
	return &PinsAPIServiceSQLite{
		db:                db,
		userService:       userService,
		ipfsAPI:           ipfsAPI,
		ipfsClusterAPI:    ipfsClusterAPI,
		enableIPFSPinning: enableIPFSPinning,
		ipfsHTTPURL:       ipfsHTTPURL,
	}
}

// AddPin adds a new pin
func (s *PinsAPIServiceSQLite) AddPin(ctx context.Context, pin Pin) (ImplResponse, error) {
	// Validate pin input
	if err := validatePin(pin); err != nil {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", err.Error()), err
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	// Check if user already has a pin for this CID (avoid duplicates)
	existingPin, err := s.db.GetExistingPinByCID(ctx, userID, pin.Cid)
	if err != nil {
		log.Printf("Warning: failed to check for existing pin: %v", err)
	}
	if existingPin != nil {
		log.Printf("CID %s already pinned for user %s, returning existing pin %s", pin.Cid, userID, existingPin.Requestid)
		// Return the existing pin with 200 OK (not 202 Accepted for new pins)
		return Response(http.StatusOK, *existingPin), nil
	}

	ipfsExists := false
	exists, err := s.cidExistsInIPFS(ctx, pin.Cid)
	if err != nil {
		log.Printf("Warning: failed to check CID existence in IPFS: %v", err)
		ipfsExists = false
	} else {
		ipfsExists = exists
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

	// Get delegates from IPFS cluster or use default
	delegates := s.getDelegates(ctx)

	// Pin to IPFS Cluster asynchronously and calculate size after success
	go func(reqID, cid, name string) {
		pinCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		if err := s.pinToCluster(pinCtx, cid, name); err != nil {
			log.Printf("Warning: failed to pin to cluster: %v", err)
			// Update status to failed in DB
			s.db.UpdatePinStatusAndSize(pinCtx, requestId, "failed", 0)
		} else {
			// Update status to pinning
			s.db.UpdatePinStatusAndSize(pinCtx, requestId, "pinning", 0)

			// Calculate cumulative DAG size after cluster pinning succeeds
			sizeCtx, sizeCancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer sizeCancel()

			log.Printf("Calculating DAG size for CID %s (request %s)", cid, reqID)
			size, sizeErr := s.getCIDSize(sizeCtx, cid)
			if sizeErr != nil {
				log.Printf("Warning: failed to get CID size for %s: %v", cid, sizeErr)
			} else if size > 0 {
				log.Printf("DAG size for CID %s: %d bytes", cid, size)
				if updateErr := s.db.UpdatePinSize(sizeCtx, reqID, size); updateErr != nil {
					log.Printf("Warning: failed to update pin size for %s: %v", reqID, updateErr)
				}
			} else {
				log.Printf("Warning: getCIDSize returned 0 for CID %s", cid)
			}
		}
	}(requestId, pin.Cid, pin.Name)

	status := PinStatus{
		Requestid: requestId,
		Status:    QUEUED,
		Created:   time.Now(),
		Pin:       pin,
		Delegates: delegates,
		Info:      map[string]string{"status_details": "Submitted to IPFS Cluster"},
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

	// Unpin from IPFS Cluster asynchronously
	go func(cid string) {
		unpinCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		if err := s.unpinFromCluster(unpinCtx, cid); err != nil {
			log.Printf("Warning: failed to unpin from cluster: %v", err)
		}
	}(pinStatus.Pin.Cid)

	// Mark pin as deleted
	if err := s.db.MarkPinAsDeleted(ctx, requestid); err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to delete pin"), err
	}

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

	// Ensure delegates have at least 1 item (required by spec)
	if len(pinStatus.Delegates) == 0 {
		pinStatus.Delegates = s.getDelegates(ctx)
	}

	// Update status from IPFS cluster if available and persist to database
	if s.ipfsClusterAPI != nil {
		clusterStatus, err := s.getClusterStatus(ctx, pinStatus.Pin.Cid)
		if err == nil {
			newStatus := mapStatus(clusterStatus)
			pinStatus.Status = newStatus
			// Persist the updated status to database
			if updateErr := s.db.UpdatePinStatusAndSize(ctx, requestid, string(newStatus), 0); updateErr != nil {
				log.Printf("Warning: failed to update pin status for %s: %v", requestid, updateErr)
			} else {
				log.Printf("Updated pin %s status to %s from cluster", requestid, newStatus)
			}
		}
	}

	// Try to fetch and update size asynchronously (fire and forget with timeout)
	if s.ipfsAPI != nil {
		go func(reqID, cid string, currentStatus Status) {
			// Use a short timeout to avoid blocking on remote content
			timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			size, sizeErr := s.getCIDSize(timeoutCtx, cid)
			if sizeErr == nil && size > 0 {
				if updateErr := s.db.UpdatePinSize(timeoutCtx, reqID, size); updateErr != nil {
					log.Printf("Warning: failed to update pin size for %s: %v", reqID, updateErr)
				} else {
					log.Printf("Updated pin %s size to %d bytes", reqID, size)
				}
			}
		}(requestid, pinStatus.Pin.Cid, pinStatus.Status)
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

	// Get delegates once for all results
	delegates := s.getDelegates(ctx)

	var results []PinStatus
	for _, p := range pins {
		ps := PinStatus{
			Requestid: p.RequestId,
			Status:    QUEUED,
			Created:   p.Created,
			Pin:       p.Pin,
			Delegates: delegates,
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

// dagStatResponse represents the response from IPFS dag/stat API
type dagStatResponse struct {
	TotalSize int64 `json:"TotalSize"`
}

// getCIDSize returns the cumulative DAG size of a CID from IPFS using HTTP API
func (s *PinsAPIServiceSQLite) getCIDSize(ctx context.Context, cidStr string) (int64, error) {
	if s.ipfsHTTPURL == "" {
		return 0, nil
	}

	// Build the dag/stat URL with progress=false to get immediate response
	url := fmt.Sprintf("%s/api/v0/dag/stat?arg=%s&progress=false", s.ipfsHTTPURL, cidStr)

	req, err := http.NewRequestWithContext(ctx, "POST", url, nil)
	if err != nil {
		return 0, err
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return 0, fmt.Errorf("dag/stat failed with status %d: %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}

	var result dagStatResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return 0, err
	}

	return result.TotalSize, nil
}

// getDelegates returns delegate addresses for pinning service
// The spec requires at least 1 delegate (minItems: 1)
func (s *PinsAPIServiceSQLite) getDelegates(ctx context.Context) []string {
	// Try to get delegates from IPFS node
	if s.ipfsAPI != nil {
		// Get the IPFS node's peer ID and addresses
		key, err := s.ipfsAPI.Key().Self(ctx)
		if err == nil {
			// Return default delegate address format
			return []string{"/p2p/" + key.ID().String()}
		}
	}

	// Fallback to a placeholder delegate if IPFS is not available
	// This ensures we always return at least 1 delegate as required by spec
	return []string{"/p2p/QmPlaceholder"}
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

// pinToCluster sends a pin request to IPFS Cluster (and optionally IPFS directly)
func (s *PinsAPIServiceSQLite) pinToCluster(ctx context.Context, cidStr string, name string) error {
	var clusterErr, ipfsErr error

	// Pin to IPFS Cluster
	if s.ipfsClusterAPI != nil {
		cid, err := api.DecodeCid(cidStr)
		if err != nil {
			return err
		}

		// Create pin options with name
		opts := api.PinOptions{
			Name: name,
			Mode: api.PinModeRecursive,
		}

		// Pin to cluster
		_, clusterErr = s.ipfsClusterAPI.Pin(ctx, cid, opts)
		if clusterErr != nil {
			log.Printf("Error pinning to cluster: %v", clusterErr)
		} else {
			log.Printf("Successfully submitted pin to cluster: %s", cidStr)
		}
	} else {
		log.Printf("Warning: IPFS Cluster API not available, skipping cluster pin")
	}

	// Also pin to IPFS directly if enabled
	if s.enableIPFSPinning && s.ipfsAPI != nil {
		path, err := ipfspath.NewPath("/ipfs/" + cidStr)
		if err != nil {
			log.Printf("Error creating path for IPFS pin: %v", err)
		} else {
			ipfsErr = s.ipfsAPI.Pin().Add(ctx, path)
			if ipfsErr != nil {
				log.Printf("Error pinning to IPFS: %v", ipfsErr)
			} else {
				log.Printf("Successfully pinned to IPFS: %s", cidStr)
			}
		}
	}

	// Return cluster error as primary (IPFS pinning is secondary)
	if clusterErr != nil {
		return clusterErr
	}
	return ipfsErr
}

// unpinFromCluster removes a pin from IPFS Cluster (and optionally IPFS directly)
func (s *PinsAPIServiceSQLite) unpinFromCluster(ctx context.Context, cidStr string) error {
	var clusterErr, ipfsErr error

	// Unpin from IPFS Cluster
	if s.ipfsClusterAPI != nil {
		cid, err := api.DecodeCid(cidStr)
		if err != nil {
			return err
		}

		// Unpin from cluster
		_, clusterErr = s.ipfsClusterAPI.Unpin(ctx, cid)
		if clusterErr != nil {
			log.Printf("Error unpinning from cluster: %v", clusterErr)
		} else {
			log.Printf("Successfully unpinned from cluster: %s", cidStr)
		}
	} else {
		log.Printf("Warning: IPFS Cluster API not available, skipping cluster unpin")
	}

	// Also unpin from IPFS directly if enabled
	if s.enableIPFSPinning && s.ipfsAPI != nil {
		path, err := ipfspath.NewPath("/ipfs/" + cidStr)
		if err != nil {
			log.Printf("Error creating path for IPFS unpin: %v", err)
		} else {
			ipfsErr = s.ipfsAPI.Pin().Rm(ctx, path)
			if ipfsErr != nil {
				log.Printf("Error unpinning from IPFS: %v", ipfsErr)
			} else {
				log.Printf("Successfully unpinned from IPFS: %s", cidStr)
			}
		}
	}

	// Return cluster error as primary (IPFS unpinning is secondary)
	if clusterErr != nil {
		return clusterErr
	}
	return ipfsErr
}

// syncStatusAndSize fetches status from cluster and size from IPFS, updates DB
func (s *PinsAPIServiceSQLite) syncStatusAndSize(ctx context.Context, requestId, cidStr string) (Status, int64, error) {
	var status Status = QUEUED
	var size int64 = 0

	// Get status from cluster
	if s.ipfsClusterAPI != nil {
		clusterStatus, err := s.getClusterStatus(ctx, cidStr)
		if err == nil {
			status = mapStatus(clusterStatus)
		}
	}

	// Get size from IPFS (only if pinned or pinning)
	if s.ipfsAPI != nil && (status == PINNED || status == PINNING) {
		fetchedSize, err := s.getCIDSize(ctx, cidStr)
		if err == nil && fetchedSize > 0 {
			size = fetchedSize
		}
	}

	// Update database
	if err := s.db.UpdatePinStatusAndSize(ctx, requestId, string(status), size); err != nil {
		log.Printf("Warning: failed to update pin status/size for %s: %v", requestId, err)
	}

	return status, size, nil
}

// PinNodeInfo represents information about a single cluster node for a pin
type PinNodeInfo struct {
	PeerID   string `json:"peer_id"`
	PeerName string `json:"peer_name,omitempty"`
	Status   string `json:"status"`
	Error    string `json:"error,omitempty"`
}

// PinNodesResponse represents the response for GetPinNodes
type PinNodesResponse struct {
	Requestid string        `json:"requestid"`
	Cid       string        `json:"cid"`
	Nodes     []PinNodeInfo `json:"nodes"`
}

// GetPinNodes returns the cluster nodes where a pin is stored
func (s *PinsAPIServiceSQLite) GetPinNodes(ctx context.Context, requestid string) (ImplResponse, error) {
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

	// Get cluster status with full peer information
	nodes, err := s.getClusterNodes(ctx, pinStatus.Pin.Cid)
	if err != nil {
		log.Printf("Warning: failed to get cluster nodes for %s: %v", pinStatus.Pin.Cid, err)
		// Return empty nodes array instead of error
		nodes = []PinNodeInfo{}
	}

	return Response(http.StatusOK, PinNodesResponse{
		Requestid: requestid,
		Cid:       pinStatus.Pin.Cid,
		Nodes:     nodes,
	}), nil
}

// getClusterNodes returns information about all cluster nodes for a CID
func (s *PinsAPIServiceSQLite) getClusterNodes(ctx context.Context, cidStr string) ([]PinNodeInfo, error) {
	if s.ipfsClusterAPI == nil {
		return nil, errors.New("IPFS Cluster API not available")
	}

	cid, err := api.DecodeCid(cidStr)
	if err != nil {
		return nil, err
	}

	pinInfo, err := s.ipfsClusterAPI.Status(ctx, cid, false)
	if err != nil {
		return nil, err
	}

	nodes := make([]PinNodeInfo, 0, len(pinInfo.PeerMap))
	for peerID, peerInfo := range pinInfo.PeerMap {
		node := PinNodeInfo{
			PeerID:   peerID,
			PeerName: peerInfo.PeerName,
			Status:   peerInfo.Status.String(),
		}
		if peerInfo.Error != "" {
			node.Error = peerInfo.Error
		}
		nodes = append(nodes, node)
	}

	return nodes, nil
}

// Note: generateRequestID is defined in api_pins_service.go
