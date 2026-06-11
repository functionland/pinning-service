package openapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ipfs-cluster/ipfs-cluster/api"
	clusterapi "github.com/ipfs-cluster/ipfs-cluster/api/rest/client"
	ipfspath "github.com/ipfs/boxo/path"
	cid "github.com/ipfs/go-cid"
	ipfsrpc "github.com/ipfs/kubo/client/rpc"
)

// PinsAPIServicePostgres implements PinsAPIServicer using PostgreSQL
type PinsAPIServicePostgres struct {
	db                *PostgresService
	userService       *UserServicePostgres
	ipfsAPI           *ipfsrpc.HttpApi
	ipfsClusterAPI    clusterapi.Client
	enableIPFSPinning bool
	ipfsHTTPURL       string
}

// NewPinsAPIServicePostgres creates a new pins API service with PostgreSQL backend
func NewPinsAPIServicePostgres(db *PostgresService, userService *UserServicePostgres, ipfsAPI *ipfsrpc.HttpApi, ipfsClusterAPI clusterapi.Client, enableIPFSPinning bool, ipfsHTTPURL string) *PinsAPIServicePostgres {
	if ipfsHTTPURL == "" {
		ipfsHTTPURL = "http://127.0.0.1:5001"
	}
	return &PinsAPIServicePostgres{
		db:                db,
		userService:       userService,
		ipfsAPI:           ipfsAPI,
		ipfsClusterAPI:    ipfsClusterAPI,
		enableIPFSPinning: enableIPFSPinning,
		ipfsHTTPURL:       ipfsHTTPURL,
	}
}

// AddPin adds a new pin
func (s *PinsAPIServicePostgres) AddPin(ctx context.Context, pin Pin) (ImplResponse, error) {
	if err := validatePin(pin); err != nil {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", err.Error()), err
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	// Check credit status
	creditStatus, creditErr := s.db.GetCreditStatus(ctx, userID)
	if creditErr != nil {
		log.Printf("Warning: credit check failed for user %s: %v", userID, creditErr)
	} else if !creditStatus.CanUpload {
		log.Printf("Upload blocked for user %s: %s", userID, creditStatus.Message)
		return createErrorResponse(http.StatusPaymentRequired, "INSUFFICIENT_CREDITS", creditStatus.Message), errors.New("insufficient credits")
	}

	// Check for existing pin
	existingPin, err := s.db.GetExistingPinByCID(ctx, userID, pin.Cid)
	if err != nil {
		log.Printf("Warning: failed to check for existing pin: %v", err)
	}
	if existingPin != nil {
		log.Printf("CID %s already pinned for user %s, returning existing pin %s", pin.Cid, userID, existingPin.Requestid)
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
		log.Printf("AddPin DB error for user %s cid %s: %v", userID, pin.Cid, err)
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to add pin"), err
	}

	delegates := s.getDelegates(ctx)

	// Pin to IPFS Cluster asynchronously
	go func(reqID, cid, name string) {
		pinCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		if err := s.pinToCluster(pinCtx, cid, name); err != nil {
			log.Printf("Warning: failed to pin to cluster: %v", err)
			s.db.UpdatePinStatusAndSize(pinCtx, requestId, "failed", 0)
		} else {
			s.db.UpdatePinStatusAndSize(pinCtx, requestId, "pinning", 0)

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

// ImportDag imports a DAG from an uploaded CAR file (vendor extension): the
// CAR is validated (single root, hash integrity, completeness), the blocks
// are imported to the IPFS cluster via /add?format=car (which also
// cluster-pins the root with the configured replication factor), and a pin
// row is created under the user's account so quota accounting picks the size
// up exactly like a pin-by-CID. See PinsAPIServicer for the carPath/onDone
// ownership contract.
func (s *PinsAPIServicePostgres) ImportDag(ctx context.Context, carPath string, name string, onDone func()) (ImplResponse, error) {
	// Until the async import goroutine takes over, every return path must
	// remove the temp CAR and release the caller's concurrency slot.
	asyncStarted := false
	defer func() {
		if !asyncStarted {
			os.Remove(carPath)
			if onDone != nil {
				onDone()
			}
		}
	}()

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	fi, err := os.Stat(carPath)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "uploaded CAR not accessible"), err
	}
	carSize := fi.Size()

	lim := carImportLimitsFromEnv()
	if carSize > lim.MaxCarBytes {
		err := fmt.Errorf("CAR file is %d bytes, max %d", carSize, lim.MaxCarBytes)
		return createErrorResponse(http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", err.Error()), err
	}

	// Credit gate, same as AddPin (fail-open on lookup errors). Unlike
	// pin-by-CID — where the DAG size is unknown until after pinning — the
	// upload size is known here, so additionally reject free-tier users whose
	// import could not possibly fit their remaining allowance.
	creditStatus, creditErr := s.db.GetCreditStatus(ctx, userID)
	if creditErr != nil {
		log.Printf("Warning: credit check failed for user %s: %v", userID, creditErr)
	} else {
		if !creditStatus.CanUpload {
			log.Printf("DAG import blocked for user %s: %s", userID, creditStatus.Message)
			return createErrorResponse(http.StatusPaymentRequired, "INSUFFICIENT_CREDITS", creditStatus.Message), errors.New("insufficient credits")
		}
		if creditStatus.CurrentBytes+carSize > creditStatus.FreeTierBytes && creditStatus.BalanceFula <= 0 {
			msg := fmt.Sprintf("importing %d bytes would exceed the free tier (%d of %d bytes used); please add FULA credits",
				carSize, creditStatus.CurrentBytes, creditStatus.FreeTierBytes)
			log.Printf("DAG import blocked for user %s: %s", userID, msg)
			return createErrorResponse(http.StatusPaymentRequired, "INSUFFICIENT_CREDITS", msg), errors.New("insufficient credits")
		}
	}

	stats, err := validateCARFile(ctx, carPath, lim)
	if err != nil {
		for _, sentinel := range []error{ErrCARInvalid, ErrCARNoRoots, ErrCARMultipleRoots, ErrCARRootMissing,
			ErrCARIncomplete, ErrCARBlockTooLarge, ErrCARTooManyBlocks, ErrCARUnsupportedCodec} {
			if errors.Is(err, sentinel) {
				return carImportErrorResponse(err), err
			}
		}
		log.Printf("DAG import: unexpected validation failure for user %s: %v", userID, err)
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "failed to validate CAR file"), err
	}

	pin := Pin{
		Cid:  stats.Root.String(),
		Name: name,
		Meta: map[string]string{"source": "car_import"},
	}
	if err := validatePin(pin); err != nil {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", err.Error()), err
	}

	// Dedup/heal: an already-pinned CID needs no import; an existing row that
	// never reached "pinned" (failed, or stuck fetching from the network) is
	// reused and healed by this import, which supplies the missing blocks.
	var requestId string
	healing := false
	existingPin, err := s.db.GetExistingPinByCID(ctx, userID, pin.Cid)
	if err != nil {
		log.Printf("Warning: failed to check for existing pin: %v", err)
	}
	if existingPin != nil {
		if existingPin.Status == PINNED {
			log.Printf("DAG import: CID %s already pinned for user %s, returning existing pin %s", pin.Cid, userID, existingPin.Requestid)
			return Response(http.StatusOK, *existingPin), nil
		}
		requestId = existingPin.Requestid
		healing = true
		if err := s.db.UpdatePinStatusAndSize(ctx, requestId, "queued", 0); err != nil {
			log.Printf("Warning: failed to reset pin %s for re-import: %v", requestId, err)
		}
	} else {
		requestId, err = s.db.AddPin(ctx, userID, pin, "uploaded")
		if err != nil {
			log.Printf("ImportDag DB error for user %s cid %s: %v", userID, pin.Cid, err)
			return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to add pin"), err
		}
	}

	delegates := s.getDelegates(ctx)

	go func(reqID string, root cid.Cid, version uint64, pinName, path string, carSize, validatedBytes int64) {
		defer func() {
			os.Remove(path)
			if onDone != nil {
				onDone()
			}
		}()

		importCtx, cancel := context.WithTimeout(context.Background(), clusterImportTimeout(carSize))
		defer cancel()

		s.db.UpdatePinStatusAndSize(importCtx, reqID, "pinning", 0)

		if err := addCARToCluster(importCtx, s.ipfsClusterAPI, path, version, pinName, root); err != nil {
			log.Printf("Warning: DAG import failed for CID %s (request %s): %v", root, reqID, err)
			s.db.UpdatePinStatusAndSize(importCtx, reqID, "failed", 0)
			return
		}
		log.Printf("DAG import: CAR for CID %s imported to cluster (request %s)", root, reqID)

		if s.enableIPFSPinning && s.ipfsAPI != nil {
			if p, pathErr := ipfspath.NewPath("/ipfs/" + root.String()); pathErr == nil {
				if pinErr := s.ipfsAPI.Pin().Add(importCtx, p); pinErr != nil {
					log.Printf("Warning: direct IPFS pin after DAG import failed for %s: %v", root, pinErr)
				}
			}
		}

		sizeCtx, sizeCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer sizeCancel()

		size, sizeErr := s.getCIDSize(sizeCtx, root.String())
		if sizeErr != nil || size <= 0 {
			// Never miss quota accounting: fall back to the validated sum of
			// unique block sizes, which matches dag/stat for a complete DAG.
			log.Printf("Warning: dag/stat unavailable for %s (err=%v, size=%d); using validated CAR bytes %d", root, sizeErr, size, validatedBytes)
			size = validatedBytes
		}
		if updateErr := s.db.UpdatePinSize(sizeCtx, reqID, size); updateErr != nil {
			log.Printf("Warning: failed to update pin size for %s: %v", reqID, updateErr)
		}
	}(requestId, stats.Root, stats.Version, name, carPath, carSize, stats.UniqueBytes)
	asyncStarted = true

	statusDetails := "CAR accepted, importing to IPFS Cluster"
	if healing {
		statusDetails = "CAR accepted, re-importing to IPFS Cluster"
	}
	status := PinStatus{
		Requestid: requestId,
		Status:    QUEUED,
		Created:   time.Now(),
		Pin:       pin,
		Delegates: delegates,
		Info: map[string]string{
			"status_details": statusDetails,
			"source":         "car_import",
			"car_size":       strconv.FormatInt(carSize, 10),
			"block_count":    strconv.FormatInt(stats.BlockCount, 10),
		},
	}

	return Response(http.StatusAccepted, status), nil
}

// DeletePinByRequestId deletes a pin
func (s *PinsAPIServicePostgres) DeletePinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	if requestid == "" {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "requestid is required"), errors.New("requestid is required")
	}

	pinStatus, pinUserID, pinUsername, err := s.db.GetPinByRequestID(ctx, requestid)
	if err != nil {
		if errors.Is(err, ErrPinNotFound) {
			return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), err
		}
		log.Printf("GetPinByRequestID DB error for %s: %v", requestid, err)
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to load pin"), err
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	if !pinOwnerMatches(pinUserID, pinUsername, userID) {
		return createErrorResponse(http.StatusForbidden, "FORBIDDEN", "You don't have permission to delete this pin"), errors.New("unauthorized")
	}

	// Mark THIS pin deleted first so it is excluded from the ref-count below.
	if err := s.db.MarkPinAsDeleted(ctx, requestid); err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to delete pin"), err
	}

	// F6 ref-count guard: only unpin the CID from the cluster when NO other
	// active pin (any user) still references it. The cluster pins by CID with no
	// per-user awareness, so an unconditional unpin would destroy data another
	// user still holds. Bias toward retention everywhere: on a count error we
	// SKIP the unpin (a leaked cluster pin is wasted storage; an erroneous unpin
	// is data loss).
	cid := pinStatus.Pin.Cid
	remaining, err := s.db.CountActivePinsByCID(ctx, cid)
	if err != nil {
		log.Printf("Warning: CountActivePinsByCID(%s) failed; skipping cluster unpin to avoid data loss: %v", cid, err)
	} else if remaining == 0 {
		go func(cid string) {
			unpinCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()

			// Re-check immediately before unpinning to shrink the TOCTOU window
			// where a concurrent AddPin landed after the count above. (A new
			// pin's own async pinToCluster also re-pins, so this is
			// belt-and-suspenders.)
			if n, rerr := s.db.CountActivePinsByCID(unpinCtx, cid); rerr != nil || n > 0 {
				log.Printf("Skipping unpin of %s: re-check found %d active pin(s) (err=%v)", cid, n, rerr)
				return
			}
			if err := s.unpinFromCluster(unpinCtx, cid); err != nil {
				log.Printf("Warning: failed to unpin from cluster: %v", err)
			}
		}(cid)
	} else {
		log.Printf("CID %s still referenced by %d active pin(s); skipping cluster unpin", cid, remaining)
	}

	return Response(http.StatusAccepted, nil), nil
}

// GetPinByRequestId retrieves a pin by request ID
func (s *PinsAPIServicePostgres) GetPinByRequestId(ctx context.Context, requestid string) (ImplResponse, error) {
	if requestid == "" {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "requestid is required"), errors.New("requestid is required")
	}

	pinStatus, pinUserID, pinUsername, err := s.db.GetPinByRequestID(ctx, requestid)
	if err != nil {
		if errors.Is(err, ErrPinNotFound) {
			return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), err
		}
		log.Printf("GetPinByRequestID DB error for %s: %v", requestid, err)
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to load pin"), err
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	if !pinOwnerMatches(pinUserID, pinUsername, userID) {
		return createErrorResponse(http.StatusForbidden, "FORBIDDEN", "You don't have permission to view this pin"), errors.New("unauthorized")
	}

	if len(pinStatus.Delegates) == 0 {
		pinStatus.Delegates = s.getDelegates(ctx)
	}

	if s.ipfsClusterAPI != nil {
		clusterStatus, err := s.getClusterStatus(ctx, pinStatus.Pin.Cid)
		if err == nil {
			newStatus := mapStatus(clusterStatus)
			pinStatus.Status = newStatus
			if updateErr := s.db.UpdatePinStatusAndSize(ctx, requestid, string(newStatus), 0); updateErr != nil {
				log.Printf("Warning: failed to update pin status for %s: %v", requestid, updateErr)
			}
		}
	}

	if s.ipfsAPI != nil {
		go func(reqID, cid string, currentStatus Status) {
			timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			size, sizeErr := s.getCIDSize(timeoutCtx, cid)
			if sizeErr == nil && size > 0 {
				if updateErr := s.db.UpdatePinSize(timeoutCtx, reqID, size); updateErr != nil {
					log.Printf("Warning: failed to update pin size for %s: %v", reqID, updateErr)
				}
			}
		}(requestid, pinStatus.Pin.Cid, pinStatus.Status)
	}

	return Response(http.StatusOK, pinStatus), nil
}

// GetPins retrieves pins with filtering
func (s *PinsAPIServicePostgres) GetPins(ctx context.Context, cid []string, name string, match TextMatchingStrategy, status []Status, before time.Time, after time.Time, limit int32, meta map[string]string) (ImplResponse, error) {
	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	pins, count, err := s.db.GetPins(ctx, userID, cid, name, match, status, before, after, int(limit), meta)
	if err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to retrieve pins"), err
	}

	delegates := s.getDelegates(ctx)

	// Skip expensive per-CID cluster status lookups for large batch requests.
	// Each cluster status call is a network round-trip; for large lists this
	// causes the request to timeout before any response is sent.
	skipClusterStatus := len(pins) > 10

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

		if s.ipfsClusterAPI != nil && !skipClusterStatus {
			cidCtx, cidCancel := context.WithTimeout(ctx, 5*time.Second)
			clusterStatus, err := s.getClusterStatus(cidCtx, p.Pin.Cid)
			cidCancel()
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
func (s *PinsAPIServicePostgres) ReplacePinByRequestId(ctx context.Context, requestid string, pin Pin) (ImplResponse, error) {
	if requestid == "" {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "requestid is required"), errors.New("requestid is required")
	}

	if err := validatePin(pin); err != nil {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", err.Error()), err
	}

	_, pinUserID, pinUsername, err := s.db.GetPinByRequestID(ctx, requestid)
	if err != nil {
		if errors.Is(err, ErrPinNotFound) {
			return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), err
		}
		log.Printf("GetPinByRequestID DB error for %s: %v", requestid, err)
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to load pin"), err
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	if !pinOwnerMatches(pinUserID, pinUsername, userID) {
		return createErrorResponse(http.StatusForbidden, "FORBIDDEN", "You don't have permission to modify this pin"), errors.New("unauthorized")
	}

	if err := s.db.DeletePin(ctx, requestid); err != nil {
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to replace pin"), err
	}

	return s.AddPin(ctx, pin)
}

// GetPinNodes returns the cluster nodes where a pin is stored
func (s *PinsAPIServicePostgres) GetPinNodes(ctx context.Context, requestid string) (ImplResponse, error) {
	if requestid == "" {
		return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", "requestid is required"), errors.New("requestid is required")
	}

	pinStatus, pinUserID, pinUsername, err := s.db.GetPinByRequestID(ctx, requestid)
	if err != nil {
		if errors.Is(err, ErrPinNotFound) {
			return createErrorResponse(http.StatusNotFound, "NOT_FOUND", "Pin not found"), err
		}
		log.Printf("GetPinByRequestID DB error for %s: %v", requestid, err)
		return createErrorResponse(http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to load pin"), err
	}

	userID, err := s.extractUserIDFromAuth(ctx)
	if err != nil {
		return createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error()), err
	}

	if !pinOwnerMatches(pinUserID, pinUsername, userID) {
		return createErrorResponse(http.StatusForbidden, "FORBIDDEN", "You don't have permission to view this pin"), errors.New("unauthorized")
	}

	nodes, err := s.getClusterNodes(ctx, pinStatus.Pin.Cid)
	if err != nil {
		log.Printf("Warning: failed to get cluster nodes for %s: %v", pinStatus.Pin.Cid, err)
		nodes = []PinNodeInfo{}
	}

	return Response(http.StatusOK, PinNodesResponse{
		Requestid: requestid,
		Cid:       pinStatus.Pin.Cid,
		Nodes:     nodes,
	}), nil
}

// Helper methods

func (s *PinsAPIServicePostgres) extractUserIDFromAuth(ctx context.Context) (string, error) {
	token, err := extractAuthTokenFromContext(ctx)
	if err != nil {
		return "", err
	}
	return s.db.GetUserIDFromToken(ctx, token, "extractUserIDFromAuth")
}

// pinOwnerMatches reports whether requestUserID (extracted from the bearer
// token via GetUserIDFromToken — preferentially the SHA-256 user_id, falling
// back to the legacy plain username) is the owner of a pin row carrying the
// given user_id (hash) and username (legacy plain) columns.
//
// Three regimes coexist after the PII migration:
//
//   1. Post-wipe row + post-wipe session
//      pinUserID  = sha256(lower(email)),  pinUsername = ""
//      requestUserID = sha256(lower(email))
//      → first branch matches.
//
//   2. Legacy row + legacy session
//      pinUserID  = "",  pinUsername = "user@example.com"
//      requestUserID = "user@example.com"  (session.user_id was NULL → fell back to username)
//      → plain-equality branch matches.
//
//   3. Legacy row + post-wipe session
//      pinUserID  = "",  pinUsername = "User@Example.com"
//      requestUserID = sha256(lower(email))
//      → hash-of-lowered-username branch matches. The lower() mirrors webui's
//      emailToUserId() which lowercases before hashing (pinning-webui/server/utils/hash.ts:9).
//
// Any other case (including both id columns empty — should not occur given the
// wipe script's guard) returns false, yielding a 403 from callers.
func pinOwnerMatches(pinUserID, pinUsername, requestUserID string) bool {
	if requestUserID == "" {
		return false
	}
	if pinUserID != "" && pinUserID == requestUserID {
		return true
	}
	if pinUsername != "" {
		if pinUsername == requestUserID {
			return true
		}
		if hashToken(strings.ToLower(pinUsername)) == requestUserID {
			return true
		}
	}
	return false
}

func (s *PinsAPIServicePostgres) cidExistsInIPFS(ctx context.Context, cidStr string) (bool, error) {
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

func (s *PinsAPIServicePostgres) getCIDSize(ctx context.Context, cidStr string) (int64, error) {
	if s.ipfsHTTPURL == "" {
		return 0, nil
	}

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

func (s *PinsAPIServicePostgres) getDelegates(ctx context.Context) []string {
	if s.ipfsAPI != nil {
		key, err := s.ipfsAPI.Key().Self(ctx)
		if err == nil {
			return []string{"/p2p/" + key.ID().String()}
		}
	}
	return []string{"/p2p/QmPlaceholder"}
}

func (s *PinsAPIServicePostgres) getClusterStatus(ctx context.Context, cidStr string) (string, error) {
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

func (s *PinsAPIServicePostgres) pinToCluster(ctx context.Context, cidStr string, name string) error {
	var clusterErr, ipfsErr error

	if s.ipfsClusterAPI != nil {
		cid, err := api.DecodeCid(cidStr)
		if err != nil {
			return err
		}

		opts := api.PinOptions{
			Name: name,
			Mode: api.PinModeRecursive,
		}

		_, clusterErr = s.ipfsClusterAPI.Pin(ctx, cid, opts)
		if clusterErr != nil {
			log.Printf("Error pinning to cluster: %v", clusterErr)
		} else {
			log.Printf("Successfully submitted pin to cluster: %s", cidStr)
		}
	}

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

	if clusterErr != nil {
		return clusterErr
	}
	return ipfsErr
}

func (s *PinsAPIServicePostgres) unpinFromCluster(ctx context.Context, cidStr string) error {
	var clusterErr, ipfsErr error

	if s.ipfsClusterAPI != nil {
		cid, err := api.DecodeCid(cidStr)
		if err != nil {
			return err
		}

		_, clusterErr = s.ipfsClusterAPI.Unpin(ctx, cid)
		if clusterErr != nil {
			log.Printf("Error unpinning from cluster: %v", clusterErr)
		} else {
			log.Printf("Successfully unpinned from cluster: %s", cidStr)
		}
	}

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

	if clusterErr != nil {
		return clusterErr
	}
	return ipfsErr
}

func (s *PinsAPIServicePostgres) getClusterNodes(ctx context.Context, cidStr string) ([]PinNodeInfo, error) {
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
