package openapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/ipfs-cluster/ipfs-cluster/api"
	clusterapi "github.com/ipfs-cluster/ipfs-cluster/api/rest/client"
	ipfspath "github.com/ipfs/boxo/path"
	ipfsrpc "github.com/ipfs/kubo/client/rpc"
)

type PinsAPIService struct {
	firestoreService      *FirestoreService
	userService           *UserService
	ipfsAPI               *ipfsrpc.HttpApi
	ipfsClusterAPI        clusterapi.Client
	blockchainAPIEndpoint string
	masterSeed            string
	poolSeed              string
	poolId                int
}

func NewPinsAPIService(firestoreService *FirestoreService, userService *UserService, ipfsAPI *ipfsrpc.HttpApi, ipfsClusterAPI clusterapi.Client, blockchainAPIEndpoint, masterSeed, poolSeed string, poolId int) *PinsAPIService {
	return &PinsAPIService{
		firestoreService:      firestoreService,
		userService:           userService,
		ipfsAPI:               ipfsAPI,
		ipfsClusterAPI:        ipfsClusterAPI,
		blockchainAPIEndpoint: blockchainAPIEndpoint,
		masterSeed:            masterSeed,
		poolSeed:              poolSeed,
		poolId:                poolId,
	}
}

func (s *PinsAPIService) AddPin(ctx context.Context, pin Pin) (ImplResponse, error) {
	// Check if the CID already exists in IPFS
	/*ipfsExists, err := s.cidExistsInIPFS(ctx, pin.Cid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}
	if !ipfsExists {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "CID does not exist in IPFS"), nil
	}*/

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	// Check blockchain balance
	balance, passwordHash, err := s.checkBlockchainBalance(ctx)
	if err != nil || balance < 9999999999999 {
		_, err := s.setBlockchainBalance(ctx, s.masterSeed, 999999999999999999)
		if err != nil {
			return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
		}
	}

	// Create a manifest on the blockchain
	err = s.createManifestOnChain(ctx, passwordHash, pin.Cid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Verify the manifest exists on the blockchain
	exists, err := s.verifyManifestOnChain(ctx, passwordHash, pin.Cid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}
	if !exists {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Manifest creation failed on blockchain"), nil
	}

	// Interact with IPFS to add pin
	err = s.pinToIPFSCluster(ctx, pin.Cid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Store pin in Firestore
	_, err = s.firestoreService.AddPin(ctx, userID, pin)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Convert pin.Cid to api.Cid
	c, err := api.DecodeCid(pin.Cid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Call IPFS Cluster status endpoint to get additional details
	pinStatus, err := s.ipfsClusterAPI.Status(ctx, c, true)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Extract additional details from the status response
	delegates := []string{}
	for _, peer := range pinStatus.PeerMap {
		for _, addr := range peer.IPFSAddresses {
			delegates = append(delegates, addr.String())
		}
	}

	info := map[string]string{
		"status_details": "Queue position: 7 of 9", // You may update this with actual status details if available
	}

	response := PinStatus{
		Requestid: generateRequestID(pin),
		Status:    "queued",
		Created:   time.Now(),
		Pin: Pin{
			Cid:     pin.Cid,
			Name:    pin.Name,
			Origins: pin.Origins,
			Meta:    pin.Meta,
		},
		Delegates: delegates,
		Info:      info,
	}

	return Response(http.StatusAccepted, response), nil
}

// createManifestOnChain creates a manifest on the blockchain
func (s *PinsAPIService) createManifestOnChain(ctx context.Context, passwordHash, cid string) error {
	reqBody, err := json.Marshal(map[string]interface{}{
		"seed":               "//" + passwordHash,
		"replication_factor": []int{6},
		"pool_id":            []int{s.poolId},
		"cid":                []string{cid},
		"manifest_metadata": map[string]interface{}{
			"job": map[string]string{
				"work":   "Storage",
				"engine": "IPFS",
				"uri":    cid,
			},
		},
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", s.blockchainAPIEndpoint+"/fula/manifest/batch_upload", bytes.NewBuffer(reqBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResponse struct {
			Message     string `json:"message"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResponse); err != nil {
			return err
		}
		return errors.New(errorResponse.Message + ": " + errorResponse.Description)
	}

	return nil
}

// verifyManifestOnChain verifies if the manifest exists on the blockchain
func (s *PinsAPIService) verifyManifestOnChain(ctx context.Context, passwordHash, cid string) (bool, error) {
	account, err := s.getAccountFromPasswordHash(ctx, passwordHash)
	if err != nil {
		return false, err
	}

	reqBody, err := json.Marshal(map[string]interface{}{
		"pool_id":  s.poolId,
		"uploader": account,
		"cids":     []string{cid},
	})
	if err != nil {
		return false, err
	}

	resp, err := http.Post(s.blockchainAPIEndpoint+"/fula/manifest/available_batch", "application/json", bytes.NewBuffer(reqBody))
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	var result struct {
		Manifests []struct {
			Cid                  string `json:"cid"`
			ReplicationAvailable int    `json:"replication_available"`
		} `json:"manifests"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return false, err
	}

	if len(result.Manifests) == 0 {
		return false, nil
	}

	return true, nil
}

// cidExistsInIPFS checks if a CID exists in IPFS
func (s *PinsAPIService) cidExistsInIPFS(ctx context.Context, cid string) (bool, error) {
	// Create a new context with a 20-second timeout
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	// Convert string to ipfspath.Path
	p, err := ipfspath.NewPath("/ipfs/" + cid)
	if err != nil {
		return false, err
	}

	// Try to stat the block to see if it exists
	_, err = s.ipfsAPI.Block().Stat(ctx, p)
	if err != nil {
		// If the error is context.DeadlineExceeded, it means the operation timed out
		if err == context.DeadlineExceeded {
			return false, nil
		}

		// If the error is not "not found", then it is a real error
		if !strings.Contains(err.Error(), "not found") {
			return false, err
		}
		// The block does not exist
		return false, nil
	}
	// The block exists
	return true, nil
}

func (s *PinsAPIService) DeletePinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	// Get the pin by request ID and check ownership
	pin, username, err := s.getPinByRequestID(ctx, requestid)
	if err != nil {
		return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), err
	}

	if userID != username {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", "You do not have permission to delete this pin"), nil
	}

	// Check blockchain balance
	balance, passwordHash, err := s.checkBlockchainBalance(ctx)
	if err != nil || balance < 9999999999999 {
		_, err := s.setBlockchainBalance(ctx, s.masterSeed, 999999999999999999)
		if err != nil {
			return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
		}
	}

	log.Printf("This is pinned object for request: %s: %s ------------", requestid, pin.Pin.Cid)

	// Remove the manifest from the blockchain
	err = s.removeManifestFromChain(ctx, passwordHash, pin.Pin.Cid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}
	log.Printf("Manifest removed")

	// Verify the manifest has been removed from the blockchain
	exists, err := s.verifyManifestOnChain(ctx, passwordHash, pin.Pin.Cid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}
	if exists {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Manifest removal failed on blockchain"), nil
	}
	log.Printf("Manifest is actually removed")

	// Remove pin from IPFS
	err = s.unpinFromIPFSCluster(ctx, pin.Pin.Cid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Remove pin from Firestore
	err = s.firestoreService.DeletePin(ctx, requestid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	return Response(http.StatusAccepted, nil), nil
}

// removeManifestFromChain removes a manifest from the blockchain
func (s *PinsAPIService) removeManifestFromChain(ctx context.Context, passwordHash, cid string) error {
	log.Printf("Creating blockchain request with hash: %s", passwordHash)
	reqBody, err := json.Marshal(map[string]interface{}{
		"seed":    "//" + passwordHash,
		"cid":     cid,
		"pool_id": s.poolId,
	})
	if err != nil {
		return err
	}
	log.Printf("Created blockchain request")
	req, err := http.NewRequestWithContext(ctx, "POST", s.blockchainAPIEndpoint+"/fula/manifest/remove", bytes.NewBuffer(reqBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResponse struct {
			Message     string `json:"message"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResponse); err != nil {
			return err
		}
		return errors.New(errorResponse.Message + ": " + errorResponse.Description)
	}

	return nil
}

func (s *PinsAPIService) GetPinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	pin, _, err := s.firestoreService.GetPinByRequestID(ctx, requestid)
	if err != nil {
		return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), err
	}

	pinStatuses, err := s.getPinStatusFromIPFSCluster(ctx, []string{pin.Pin.Cid})
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	if len(pinStatuses) > 0 {
		return Response(http.StatusOK, pinStatuses[0]), nil
	}

	return Response(http.StatusOK, pin), nil
}

func (s *PinsAPIService) GetPins(ctx context.Context, cid []string, name string, match TextMatchingStrategy, status []Status, before time.Time, after time.Time, limit int32, meta map[string]string) (ImplResponse, error) {
	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	// Query pins from Firestore
	pins, err := s.firestoreService.GetPins(ctx, userID, int(limit))
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	cids := make([]string, len(pins))
	for i, pin := range pins {
		cids[i] = pin.Cid
	}

	pinStatuses, err := s.getPinStatusFromIPFSCluster(ctx, cids)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	return Response(http.StatusOK, PinResults{Results: pinStatuses}), nil
}

func (s *PinsAPIService) extractUserIDFromAuth(ctx context.Context) (string, error) {
	authToken, err := extractAuthTokenFromContext(ctx)
	if err != nil {
		return "", err
	}

	return s.firestoreService.GetUserIDFromToken(ctx, authToken)
}

func (s *PinsAPIService) ReplacePinByRequestId(ctx context.Context, requestid string, pin Pin) (ImplResponse, error) {
	// Replace pin logic
	return Response(http.StatusNotImplemented, nil), errors.New("ReplacePinByRequestId method not implemented")
}

func (s *PinsAPIService) getPinByRequestID(ctx context.Context, requestid string) (PinStatus, string, error) {
	pin, username, err := s.firestoreService.GetPinByRequestID(ctx, requestid)
	if err != nil {
		return PinStatus{}, "", err
	}

	pinStatuses, err := s.getPinStatusFromIPFSCluster(ctx, []string{pin.Pin.Cid})
	if err != nil {
		return PinStatus{}, "", err
	}

	if len(pinStatuses) > 0 {
		return pinStatuses[0], username, nil
	}

	return pin, username, nil
}

func (s *PinsAPIService) checkBlockchainBalance(ctx context.Context) (int64, string, error) {
	authToken, err := extractAuthTokenFromContext(ctx)
	if err != nil {
		return 0, "", err
	}

	passwordHash, err := s.userService.GetPasswordHashFromAuthToken(ctx, authToken)
	if err != nil {
		return 0, "", err
	}

	account, err := s.getAccountFromPasswordHash(ctx, passwordHash)
	if err != nil {
		return 0, "", err
	}

	resp, err := http.Get(s.blockchainAPIEndpoint + "/account/balance?account=" + account)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()

	var result struct {
		Amount int64 `json:"amount"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, "", err
	}

	return result.Amount, passwordHash, nil
}

func (s *PinsAPIService) setBlockchainBalance(ctx context.Context, seed string, amount int64) (bool, error) {
	authToken, err := extractAuthTokenFromContext(ctx)
	if err != nil {
		return false, err
	}

	passwordHash, err := s.userService.GetPasswordHashFromAuthToken(ctx, authToken)
	if err != nil {
		return false, err
	}

	account, err := s.getAccountFromPasswordHash(ctx, passwordHash)
	if err != nil {
		return false, err
	}

	reqBody, err := json.Marshal(map[string]interface{}{
		"seed":   seed,
		"amount": amount,
		"to":     account,
	})
	if err != nil {
		return false, err
	}

	resp, err := http.Post(s.blockchainAPIEndpoint+"/account/set_balance", "application/json", bytes.NewBuffer(reqBody))
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, errors.New("failed to set balance")
	}

	return true, nil
}

func (s *PinsAPIService) getAccountFromPasswordHash(ctx context.Context, passwordHash string) (string, error) {
	reqBody, err := json.Marshal(map[string]string{
		"seed": "//" + passwordHash,
	})
	if err != nil {
		return "", err
	}

	resp, err := http.Post(s.blockchainAPIEndpoint+"/account/seeded", "application/json", bytes.NewBuffer(reqBody))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResponse struct {
			Message     string `json:"message"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResponse); err != nil {
			return "", err
		}
		return "", errors.New(errorResponse.Message + ": " + errorResponse.Description)
	}

	var successResponse struct {
		Seed    string `json:"seed"`
		Account string `json:"account"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResponse); err != nil {
		return "", err
	}

	return successResponse.Account, nil
}

func (s *PinsAPIService) pinToIPFSCluster(ctx context.Context, cid string) error {
	// Decode the CID
	c, err := api.DecodeCid(cid)
	if err != nil {
		return err
	}

	// Set pin options (if any are needed)
	pinOptions := api.PinOptions{
		Mode: 0,
	}

	// Pin the CID to the IPFS Cluster
	_, err = s.ipfsClusterAPI.Pin(ctx, c, pinOptions)
	if err != nil {
		return err
	}

	return nil
}

func (s *PinsAPIService) unpinFromIPFSCluster(ctx context.Context, cid string) error {
	// Decode the CID
	c, err := api.DecodeCid(cid)
	if err != nil {
		return err
	}

	// Unpin the CID from the IPFS Cluster
	_, err = s.ipfsClusterAPI.Unpin(ctx, c)
	if err != nil {
		return err
	}

	return nil
}

func (s *PinsAPIService) getPinStatusFromIPFSCluster(ctx context.Context, cids []string) ([]PinStatus, error) {
	var pinStatuses []PinStatus
	var apiCids []api.Cid

	for _, cidStr := range cids {
		c, err := api.DecodeCid(cidStr)
		if err != nil {
			return nil, err
		}
		apiCids = append(apiCids, c)
	}

	statusChan := make(chan api.GlobalPinInfo)
	errChan := make(chan error)

	go func() {
		errChan <- s.ipfsClusterAPI.StatusCids(ctx, apiCids, false, statusChan)
	}()

	ipfsClusterID, err := s.ipfsClusterAPI.ID(ctx)
	if err != nil {
		return nil, err
	}

	for status := range statusChan {
		if pinInfo, ok := status.PeerMap[ipfsClusterID.ID.String()]; ok {
			pinStatuses = append(pinStatuses, PinStatus{
				Requestid: status.Cid.String(),
				Status:    Status(pinInfo.Status.String()), // Convert TrackerStatus to string
				Created:   status.Created,
				Pin: Pin{
					Cid: status.Cid.String(),
				},
			})
		}
	}

	if err := <-errChan; err != nil {
		return nil, err
	}

	return pinStatuses, nil
}

func generateRequestID(_ Pin) string {
	// Generate a unique request ID for the pin
	return uuid.New().String()
}
