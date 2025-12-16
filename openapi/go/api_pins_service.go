package openapi

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/ipfs-cluster/ipfs-cluster/api"
	clusterapi "github.com/ipfs-cluster/ipfs-cluster/api/rest/client"
	ipfspath "github.com/ipfs/boxo/path"
	ipfsrpc "github.com/ipfs/kubo/client/rpc"
)

// CID validation regex patterns
var (
	cidV0Regex = regexp.MustCompile(`^Qm[1-9A-HJ-NP-Za-km-z]{44}$`)
	cidV1Regex = regexp.MustCompile(`^b[a-z2-7]{58,}$`)
)

// MaxNameLength is the maximum allowed length for pin names per IPFS spec
const MaxNameLength = 255

// MaxOriginsCount is the maximum number of origins allowed per IPFS spec
const MaxOriginsCount = 20

// MaxMetaEntries is the maximum number of metadata entries allowed
const MaxMetaEntries = 1000

type CidWithRequestId struct {
	Cid       string
	RequestId string
	Name      string
	Created   time.Time
}

type RequestIdWithName struct {
	RequestId string
	Name      string
	Created   time.Time
}

type PinsAPIService struct {
	firestoreService *FirestoreService
	userService      *UserService
	ipfsAPI          *ipfsrpc.HttpApi
	ipfsClusterAPI   clusterapi.Client
}

func NewPinsAPIService(firestoreService *FirestoreService, userService *UserService, ipfsAPI *ipfsrpc.HttpApi, ipfsClusterAPI clusterapi.Client) *PinsAPIService {
	return &PinsAPIService{
		firestoreService: firestoreService,
		userService:      userService,
		ipfsAPI:          ipfsAPI,
		ipfsClusterAPI:   ipfsClusterAPI,
	}
}

// validateCID checks if the provided CID is valid
func validateCID(cid string) error {
	if cid == "" {
		return errors.New("CID cannot be empty")
	}
	// Try to decode using the IPFS cluster API to validate
	_, err := api.DecodeCid(cid)
	if err != nil {
		return fmt.Errorf("invalid CID format: %s", cid)
	}
	return nil
}

// validatePin validates the pin input according to IPFS spec
func validatePin(pin Pin) error {
	// Validate CID
	if err := validateCID(pin.Cid); err != nil {
		return err
	}

	// Validate name length (max 255 chars per IPFS spec)
	if len(pin.Name) > MaxNameLength {
		return fmt.Errorf("name exceeds maximum length of %d characters", MaxNameLength)
	}

	// Validate origins count (max 20 per IPFS spec)
	if len(pin.Origins) > MaxOriginsCount {
		return fmt.Errorf("origins exceeds maximum count of %d", MaxOriginsCount)
	}

	// Validate meta entries count
	if len(pin.Meta) > MaxMetaEntries {
		return fmt.Errorf("meta exceeds maximum entries of %d", MaxMetaEntries)
	}

	return nil
}

func (s *PinsAPIService) AddPin(ctx context.Context, pin Pin) (ImplResponse, error) {
	// Validate pin input
	if err := validatePin(pin); err != nil {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", err.Error()), err
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	// Interact with IPFS to add pin
	err = s.pinToIPFSCluster(ctx, pin.Cid)
	if err != nil {
		log.Printf("Error pinning to IPFS cluster: %v", err)
		return createErrorResponse(http.StatusFailedDependency, "PIN_TO_CLUSTER_FAILED", err.Error()), err
	}

	// Store pin in Firestore and mark blockchain upload as pending
	requestId, err := s.firestoreService.AddPin(ctx, userID, pin, "pending")
	if err != nil {
		log.Printf("Error storing pin in Firestore: %v", err)
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

func (s *PinsAPIService) DeletePinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	// Validate requestid
	if requestid == "" {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "requestid cannot be empty"), errors.New("requestid cannot be empty")
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	pin, username, err := s.getPinByRequestID(ctx, requestid)
	if err != nil {
		log.Printf("Error getting pin by request ID %s: %v", requestid, err)
		return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), err
	}

	if userID != username {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", "You do not have permission to delete this pin"), errors.New("permission denied")
	}

	// Mark pin as deleted in Firestore and set remove_manifest as pending
	err = s.firestoreService.MarkPinAsDeleted(ctx, requestid)
	if err != nil {
		log.Printf("Error marking pin as deleted: %v", err)
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Remove pin from IPFS
	err = s.unpinFromIPFSCluster(ctx, pin.Pin.Cid)
	if err != nil {
		if !strings.Contains(err.Error(), "pin is not part of the pinset") && !strings.Contains(err.Error(), "404") {
			log.Printf("ipfscluster unpin errored: %s", err.Error())
			if markErr := s.firestoreService.MarkPinAsDeleteFailed(ctx, requestid); markErr != nil {
				log.Printf("Error marking pin as delete failed: %v", markErr)
			}
			return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
		}
		log.Printf("ipfscluster unpin info: %s", err.Error())
	}

	// Return response
	return Response(http.StatusAccepted, nil), nil
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
		pinStatuses[0].Created = pin.Created
		return Response(http.StatusOK, pinStatuses[0]), nil
	}

	return Response(http.StatusOK, pin), nil
}

func (s *PinsAPIService) GetPins(ctx context.Context, cid []string, name string, match TextMatchingStrategy, status []Status, before time.Time, after time.Time, limit int32, meta map[string]string) (ImplResponse, error) {
	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	// Validate name length if provided
	if len(name) > MaxNameLength {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", fmt.Sprintf("name exceeds maximum length of %d characters", MaxNameLength)), errors.New("name too long")
	}

	// Validate CIDs if provided
	for _, c := range cid {
		if err := validateCID(c); err != nil {
			return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", err.Error()), err
		}
	}

	log.Printf("GetPins with parameters: userID=%s, cid=%v, name=%s, match=%s, before=%s, after=%s, limit=%d", userID, cid, name, match, before, after, int(limit))

	// Query pins from Firestore with filtering criteria
	pins, count, err := s.firestoreService.GetPins(ctx, userID, cid, name, match, nil, before, after, int(limit), meta)
	if err != nil {
		log.Printf("Error querying pins from Firestore: %v", err)
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Per IPFS spec: return empty array with count=0 when no pins found, NOT 404
	if len(pins) == 0 {
		return Response(http.StatusOK, PinResults{Results: []PinStatus{}, Count: 0}), nil
	}

	cidsWithRequestId := make([]CidWithRequestId, len(pins))
	for i, pin := range pins {
		cidsWithRequestId[i] = CidWithRequestId{
			Cid:       pin.Pin.Cid,
			RequestId: pin.RequestId,
			Name:      pin.Pin.Name,
			Created:   pin.Created,
		}
	}
	log.Printf("fetched %d pins", len(cidsWithRequestId))

	pinStatuses, err := s.getPinStatusFromIPFSCluster(ctx, cidsWithRequestId)
	if err != nil {
		log.Printf("Error getting pin status from IPFS cluster: %v", err)
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error()), err
	}

	// Filter the pinStatuses based on the provided status filter
	filteredCount := int32(count)
	if len(status) > 0 {
		filteredPinStatuses := make([]PinStatus, 0, len(pinStatuses))
		for _, pinStatus := range pinStatuses {
			for _, s := range status {
				if pinStatus.Status == s {
					filteredPinStatuses = append(filteredPinStatuses, pinStatus)
					break
				}
			}
		}
		pinStatuses = filteredPinStatuses
		filteredCount = int32(len(filteredPinStatuses))
	}

	return Response(http.StatusOK, PinResults{Results: pinStatuses, Count: filteredCount}), nil
}

func (s *PinsAPIService) extractUserIDFromAuth(ctx context.Context) (string, error) {
	authToken, err := extractAuthTokenFromContext(ctx)
	if err != nil {
		return "", err
	}

	log.Printf("extractUserIDFromAuth extracted authToken: %s", authToken)
	firestoreCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	return s.firestoreService.GetUserIDFromToken(firestoreCtx, authToken, "api_pins_service")
}

func (s *PinsAPIService) ReplacePinByRequestId(ctx context.Context, requestid string, pin Pin) (ImplResponse, error) {
	// First, remove the existing pin
	log.Printf("Removing current pin: %s", requestid)
	deleteResp, err := s.DeletePinByRequestId(ctx, requestid)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to remove existing pin"), err
	}

	// Check if delete response was successful
	if deleteResp.Code != http.StatusAccepted {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to remove existing pin"), nil
	}

	log.Printf("Adding new pin: %s", pin.Cid)
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
		pinStatuses[0].Created = pin.Created

		return pinStatuses[0], username, nil
	}

	return pin, username, nil
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
			Created:   cidWithRequestId.Created,
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
			createdFromDatastore := requestIdWithName.Created
			customStatus := mapStatus(string(Status(pinInfo.Status.String())))

			// Use the name from the status if it's not empty, otherwise use the name from the map
			if status.Name != "" {
				name = status.Name
			}

			pinStatuses = append(pinStatuses, PinStatus{
				Requestid: requestId,
				Status:    customStatus, // Convert TrackerStatus to string
				Created:   createdFromDatastore,
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
	case "pin_error", "unpinned":
		return "failed"
	case "pin_queued", "remote":
		return "queued"
	default:
		return Status(ipfsStatus) // Use the original status if no custom mapping is required
	}
}

func generateRequestID(_ Pin) string {
	// Generate a unique request ID for the pin
	return uuid.New().String()
}
