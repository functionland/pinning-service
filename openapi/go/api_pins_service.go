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

type CidWithRequestId struct {
	Cid       string
	RequestId string
	Name      string
}

type RequestIdWithName struct {
	RequestId string
	Name      string
}

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
	ipfsExists := true
	ipfsExists, err := s.cidExistsInIPFS(ctx, pin.Cid)
	if err != nil {
		ipfsExists = false
	}
	if !ipfsExists {
		ipfsExists = false
	}

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

	if ipfsExists {
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
	}

	// Interact with IPFS to add pin
	err = s.pinToIPFSCluster(ctx, pin.Cid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Store pin in Firestore
	requestId, err := s.firestoreService.AddPin(ctx, userID, pin)
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
		"status_details": "Queue position: 0 of 0", // You may update this with actual status details if available
	}

	response := PinStatus{
		Requestid: requestId,
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
	log.Printf("blockchain account was created from seed: %s", account)

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
	} else {
		log.Println(result)
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

	pinStatuses, err := s.getPinStatusFromIPFSCluster(ctx, []CidWithRequestId{{Cid: pin.Pin.Cid, RequestId: requestid, Name: pin.Pin.Name}})
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
	log.Printf("GetPins with parameters: userID=%s, cid=%s, name=%s, match=%s, before=%s, after=%s, limit=%d", userID, cid, name, match, before, after, int(limit))

	// Query pins from Firestore with filtering criteria
	pins, count, err := s.firestoreService.GetPins(ctx, userID, cid, name, match, nil, before, after, int(limit), meta) // Exclude status filter here
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	if len(pins) == 0 {
		return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), nil
	}

	cidsWithRequestId := make([]CidWithRequestId, len(pins))
	for i, pin := range pins {
		cidsWithRequestId[i] = CidWithRequestId{
			Cid:       pin.Pin.Cid,
			RequestId: pin.RequestId,
			Name:      pin.Pin.Name,
		}
	}
	log.Printf("fetched: %v ", cidsWithRequestId)
	pinStatuses, err := s.getPinStatusFromIPFSCluster(ctx, cidsWithRequestId)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Filter the pinStatuses based on the provided status filter
	if len(status) > 0 {
		filteredPinStatuses := []PinStatus{}
		for _, pinStatus := range pinStatuses {
			for _, s := range status {
				if pinStatus.Status == s {
					filteredPinStatuses = append(filteredPinStatuses, pinStatus)
					break
				}
			}
		}
		pinStatuses = filteredPinStatuses
	}

	return Response(http.StatusOK, PinResults{Results: pinStatuses, Count: int32(count)}), nil
}

func (s *PinsAPIService) extractUserIDFromAuth(ctx context.Context) (string, error) {
	authToken, err := extractAuthTokenFromContext(ctx)
	if err != nil {
		return "", err
	}

	return s.firestoreService.GetUserIDFromToken(ctx, authToken)
}

func (s *PinsAPIService) ReplacePinByRequestId(ctx context.Context, requestid string, pin Pin) (ImplResponse, error) {
	// First, remove the existing pin
	deleteResp, err := s.DeletePinByRequestId(ctx, requestid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to remove existing pin"), err
	}

	// Check if delete response was successful
	if deleteResp.Code != http.StatusAccepted {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to remove existing pin"), nil
	}

	// Now, add the new pin
	addResp, err := s.AddPin(ctx, pin)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to add new pin"), err
	}

	// Return the response from the AddPin method
	return addResp, nil
}

func (s *PinsAPIService) getPinByRequestID(ctx context.Context, requestid string) (PinStatus, string, error) {
	pin, username, err := s.firestoreService.GetPinByRequestID(ctx, requestid)
	if err != nil {
		return PinStatus{}, "", err
	}

	pinStatuses, err := s.getPinStatusFromIPFSCluster(ctx, []CidWithRequestId{{Cid: pin.Pin.Cid, RequestId: requestid, Name: pin.Pin.Name}})
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
	log.Printf("auth token is: %s", authToken)

	passwordHash, err := s.userService.GetPasswordHashFromAuthToken(ctx, authToken)
	if err != nil {
		return 0, "", err
	}
	log.Printf("Password hash is: %s", passwordHash)

	account, err := s.getAccountFromPasswordHash(ctx, passwordHash)
	if err != nil {
		return 0, "", err
	}
	log.Printf("account is %s", account)

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

func multiaddrToStringSlice(addresses []api.Multiaddr) []string {
	if addresses == nil {
		return []string{}
	}
	stringSlice := make([]string, len(addresses))
	for i, addr := range addresses {
		stringSlice[i] = addr.String()
	}
	return stringSlice
}

func (s *PinsAPIService) getPinStatusFromIPFSCluster(ctx context.Context, cidsWithRequestId []CidWithRequestId) ([]PinStatus, error) {
	var pinStatuses []PinStatus
	var apiCids []api.Cid

	// Create a map to store the mapping between CID and RequestIdWithName
	cidToRequestId := make(map[string]RequestIdWithName)
	for _, cidWithRequestId := range cidsWithRequestId {
		cidStr := cidWithRequestId.Cid
		c, err := api.DecodeCid(cidStr)
		if err != nil {
			return nil, err
		}
		apiCids = append(apiCids, c)
		cidToRequestId[cidStr] = RequestIdWithName{
			RequestId: cidWithRequestId.RequestId,
			Name:      cidWithRequestId.Name,
		}
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
			// Get the corresponding RequestIdWithName from the map
			requestIdWithName := cidToRequestId[status.Cid.String()]
			requestId := requestIdWithName.RequestId
			name := requestIdWithName.Name
			customStatus := mapStatus(string(Status(pinInfo.Status.String())))

			// Use the name from the status if it's not empty, otherwise use the name from the map
			if status.Name != "" {
				name = status.Name
			}

			pinStatuses = append(pinStatuses, PinStatus{
				Requestid: requestId,
				Status:    customStatus, // Convert TrackerStatus to string
				Created:   status.Created,
				Pin: Pin{
					Cid:     status.Cid.String(),
					Name:    name,
					Origins: multiaddrToStringSlice(status.Origins), // Convert []api.Multiaddr to []string
					Meta:    status.Metadata,
				},
			})
		}
	}

	if err := <-errChan; err != nil {
		return nil, err
	}

	return pinStatuses, nil
}
func mapStatus(ipfsStatus string) Status {
	switch ipfsStatus {
	case "pin_error":
		return "failed"
	case "pin_queued":
		return "queued"
	default:
		return Status(ipfsStatus) // Use the original status if no custom mapping is required
	}
}

func generateRequestID(_ Pin) string {
	// Generate a unique request ID for the pin
	return uuid.New().String()
}
