package openapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/ipfs-cluster/ipfs-cluster/api"
	clusterapi "github.com/ipfs-cluster/ipfs-cluster/api/rest/client"
	ipfspath "github.com/ipfs/boxo/path"
	ipfsrpc "github.com/ipfs/kubo/client/rpc"
)

type PinsAPIService struct {
	firestoreService      *FirestoreService
	ipfsAPI               *ipfsrpc.HttpApi
	ipfsClusterAPI        clusterapi.Client
	blockchainAPIEndpoint string
	masterSeed            string
	poolSeed              string
}

func NewPinsAPIService(firestoreService *FirestoreService, ipfsAPI *ipfsrpc.HttpApi, ipfsClusterAPI clusterapi.Client, blockchainAPIEndpoint, masterSeed, poolSeed string) *PinsAPIService {
	return &PinsAPIService{
		firestoreService:      firestoreService,
		ipfsAPI:               ipfsAPI,
		ipfsClusterAPI:        ipfsClusterAPI,
		blockchainAPIEndpoint: blockchainAPIEndpoint,
		masterSeed:            masterSeed,
		poolSeed:              poolSeed,
	}
}

func (s *FirestoreService) GetUserIDFromToken(ctx context.Context, token string) (string, error) {
	docs, err := s.client.Collection("sessions").Where("session_token", "==", token).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return "", errors.New("invalid or expired session token")
	}

	var userID string
	for _, doc := range docs {
		userID = doc.Data()["user_id"].(string)
		break
	}

	return userID, nil
}

func (s *PinsAPIService) AddPin(ctx context.Context, pin Pin) (ImplResponse, error) {
	// Check if the CID already exists in IPFS
	exists, err := s.cidExistsInIPFS(ctx, pin.Cid)
	if err != nil {
		return Response(http.StatusInternalServerError, Failure{Error: FailureError{Reason: err.Error()}}), err
	}
	if !exists {
		return Response(http.StatusBadRequest, Failure{Error: FailureError{Reason: "CID does not exist in IPFS"}}), nil
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return Response(http.StatusUnauthorized, Failure{Error: FailureError{Reason: err.Error()}}), err
	}

	// Check blockchain balance
	balance, err := s.checkBlockchainBalance(ctx, pin.Cid)
	if err != nil || balance < 9999999999999 {
		_, err := s.setBlockchainBalance(ctx, s.masterSeed, pin.Cid, 999999999999999999)
		if err != nil {
			return Response(http.StatusInternalServerError, Failure{Error: FailureError{Reason: err.Error()}}), err
		}
	}

	// Interact with IPFS to add pin
	err = s.pinToIPFSCluster(ctx, pin.Cid)
	if err != nil {
		return Response(http.StatusInternalServerError, Failure{Error: FailureError{Reason: err.Error()}}), err
	}

	// Store pin in Firestore
	err = s.firestoreService.AddPin(ctx, userID, pin)
	if err != nil {
		return Response(http.StatusInternalServerError, Failure{Error: FailureError{Reason: err.Error()}}), err
	}

	return Response(http.StatusAccepted, PinStatus{
		Requestid: generateRequestID(pin),
		Status:    "queued",
		Created:   time.Now(),
		Pin:       pin,
	}), nil
}

// cidExistsInIPFS checks if a CID exists in IPFS
func (s *PinsAPIService) cidExistsInIPFS(ctx context.Context, cid string) (bool, error) {
	pinList, err := s.ipfsAPI.Pin().Ls(ctx)
	if err != nil {
		return false, err
	}

	for p := range pinList {
		if p.Path().String() == cid {
			return true, nil
		}
	}

	return false, nil
}

func (s *PinsAPIService) DeletePinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	balance, err := s.checkBlockchainBalance(ctx, requestid)
	if err != nil || balance < 9999999999999 {
		_, err := s.setBlockchainBalance(ctx, s.masterSeed, requestid, 999999999999999999)
		if err != nil {
			return Response(http.StatusInternalServerError, Failure{Error: FailureError{Reason: err.Error()}}), err
		}
	}

	// Remove pin from IPFS
	pin, err := s.getPinByRequestID(ctx, requestid)
	if err != nil {
		return Response(http.StatusNotFound, Failure{Error: FailureError{Reason: "Pin not found"}}), err
	}

	err = s.unpinFromIPFSCluster(ctx, pin.Pin.Cid)
	if err != nil {
		return Response(http.StatusInternalServerError, Failure{Error: FailureError{Reason: err.Error()}}), err
	}

	// Remove pin from Firestore
	err = s.firestoreService.DeletePin(ctx, requestid)
	if err != nil {
		return Response(http.StatusInternalServerError, Failure{Error: FailureError{Reason: err.Error()}}), err
	}

	return Response(http.StatusAccepted, nil), nil
}

func (s *PinsAPIService) GetPinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	pin, err := s.firestoreService.GetPinByRequestID(ctx, requestid)
	if err != nil {
		return Response(http.StatusNotFound, Failure{Error: FailureError{Reason: "Pin not found"}}), err
	}

	pinStatuses, err := s.getPinStatusFromIPFSCluster(ctx, []string{pin.Pin.Cid})
	if err != nil {
		return Response(http.StatusInternalServerError, Failure{Error: FailureError{Reason: err.Error()}}), err
	}

	if len(pinStatuses) > 0 {
		return Response(http.StatusOK, pinStatuses[0]), nil
	}

	return Response(http.StatusOK, pin), nil
}

func (s *PinsAPIService) GetPins(ctx context.Context, cid []string, name string, match TextMatchingStrategy, status []Status, before time.Time, after time.Time, limit int32, meta map[string]string) (ImplResponse, error) {
	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return Response(http.StatusUnauthorized, Failure{Error: FailureError{Reason: err.Error()}}), err
	}

	// Query pins from Firestore
	pins, err := s.firestoreService.GetPins(ctx, userID, int(limit))
	if err != nil {
		return Response(http.StatusInternalServerError, Failure{Error: FailureError{Reason: err.Error()}}), err
	}

	cids := make([]string, len(pins))
	for i, pin := range pins {
		cids[i] = pin.Cid
	}

	pinStatuses, err := s.getPinStatusFromIPFSCluster(ctx, cids)
	if err != nil {
		return Response(http.StatusInternalServerError, Failure{Error: FailureError{Reason: err.Error()}}), err
	}

	return Response(http.StatusOK, PinResults{Results: pinStatuses}), nil
}

func (s *PinsAPIService) extractUserIDFromAuth(ctx context.Context) (string, error) {
	authToken, err := extractAuthTokenFromContext(ctx)
	if err != nil {
		return "", err
	}

	return s.firestoreService.GetUserIDFromAuthToken(ctx, authToken)
}

func (s *PinsAPIService) ReplacePinByRequestId(ctx context.Context, requestid string, pin Pin) (ImplResponse, error) {
	// Replace pin logic
	return Response(http.StatusNotImplemented, nil), errors.New("ReplacePinByRequestId method not implemented")
}

func (s *PinsAPIService) getPinByRequestID(ctx context.Context, requestid string) (PinStatus, error) {
	pin, err := s.firestoreService.GetPinByRequestID(ctx, requestid)
	if err != nil {
		return PinStatus{}, err
	}

	pinStatuses, err := s.getPinStatusFromIPFSCluster(ctx, []string{pin.Pin.Cid})
	if err != nil {
		return PinStatus{}, err
	}

	if len(pinStatuses) > 0 {
		return pinStatuses[0], nil
	}

	return PinStatus{}, errors.New("pin status not found")
}

func (s *PinsAPIService) checkBlockchainBalance(ctx context.Context, account string) (int64, error) {
	authToken, err := extractAuthTokenFromContext(ctx)
	if err != nil {
		return 0, err
	}

	_, err = s.firestoreService.GetPasswordHashFromAuthToken(ctx, authToken)
	if err != nil {
		return 0, err
	}

	// Use the passwordHash for further processing if needed
	resp, err := http.Get(s.blockchainAPIEndpoint + "/account/balance?account=" + account)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	var result struct {
		Amount int64 `json:"amount"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, err
	}

	return result.Amount, nil
}

func (s *PinsAPIService) setBlockchainBalance(ctx context.Context, seed, account string, amount int64) (bool, error) {
	authToken, err := extractAuthTokenFromContext(ctx)
	if err != nil {
		return false, err
	}

	_, err = s.firestoreService.GetPasswordHashFromAuthToken(ctx, authToken)
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

func extractSessionTokenFromContext(ctx context.Context) (string, error) {
	sessionToken, ok := ctx.Value("sessionToken").(string)
	if !ok || sessionToken == "" {
		return "", errors.New("session token not found in context")
	}
	return sessionToken, nil
}

func (s *PinsAPIService) pinToIPFSCluster(ctx context.Context, cid string) error {
	p, err := ipfspath.NewPath(cid)
	if err != nil {
		return err
	}
	return s.ipfsAPI.Pin().Add(ctx, p)
}

func (s *PinsAPIService) unpinFromIPFSCluster(ctx context.Context, cid string) error {
	p, err := ipfspath.NewPath(cid)
	if err != nil {
		return err
	}
	return s.ipfsAPI.Pin().Rm(ctx, p)
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

func generateRequestID(pin Pin) string {
	// Generate a unique request ID for the pin
	return uuid.New().String()
}
