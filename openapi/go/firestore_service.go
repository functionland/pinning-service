package openapi

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/option"
)

type FirestoreService struct {
	Client *firestore.Client
}

type PinWithRequest struct {
	Pin       Pin
	RequestId string
	Created   time.Time
}

func NewFirestoreService(ctx context.Context, credentialsFile string) (*FirestoreService, error) {
	client, err := firestore.NewClient(ctx, "fula-explorer", option.WithCredentialsFile(credentialsFile))
	if err != nil {
		return nil, err
	}
	return &FirestoreService{Client: client}, nil
}

func (s *FirestoreService) Close() error {
	return s.Client.Close()
}

func extractAuthTokenFromContext(ctx context.Context) (string, error) {
	req, err := GetRequestFromContext(ctx)
	if err != nil {
		return "", err
	}

	authHeader := req.Header.Get("Authorization")
	if authHeader == "" {
		return "", errors.New("authorization token not found in context")
	}

	token := strings.TrimPrefix(authHeader, "Bearer ")
	if token == authHeader {
		return "", errors.New("malformed authorization token")
	}

	return token, nil
}

func (s *FirestoreService) AddPin(ctx context.Context, username string, pin Pin, uploadStatus string) (string, error) {
	requestId := generateRequestID(pin)
	_, _, err := s.Client.Collection("pins").Add(ctx, map[string]interface{}{
		"username":       username,
		"cid":            pin.Cid,
		"name":           pin.Name,
		"name_lowercase": strings.ToLower(pin.Name),
		"origins":        pin.Origins,
		"meta":           pin.Meta,
		"status":         "queued",
		"requestid":      requestId,
		"created_at":     time.Now(),
		"upload_status":  uploadStatus,
	})
	if err != nil {
		return "", err
	}
	return requestId, nil
}

func (s *FirestoreService) DeletePin(ctx context.Context, requestID string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	docs, err := s.Client.Collection("pins").Where("requestid", "==", requestID).Documents(ctx).GetAll()
	if err != nil {
		return fmt.Errorf("failed to query pins: %w", err)
	}
	if len(docs) == 0 {
		return errors.New("pin not found")
	}

	for _, doc := range docs {
		_, err := doc.Ref.Delete(ctx)
		if err != nil {
			return fmt.Errorf("failed to delete pin document: %w", err)
		}
	}

	return nil
}

func (s *FirestoreService) MarkPinAsDeleted(ctx context.Context, requestID string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	docs, err := s.Client.Collection("pins").Where("requestid", "==", requestID).Documents(ctx).GetAll()
	if err != nil {
		return fmt.Errorf("failed to query pins: %w", err)
	}
	if len(docs) == 0 {
		return errors.New("pin not found")
	}

	for _, doc := range docs {
		_, err := doc.Ref.Update(ctx, []firestore.Update{
			{Path: "status", Value: "deleted"},
			{Path: "remove_status", Value: "pending"},
		})
		if err != nil {
			return fmt.Errorf("failed to update pin status: %w", err)
		}
	}

	return nil
}

func (s *FirestoreService) MarkPinAsDeleteFailed(ctx context.Context, requestID string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	docs, err := s.Client.Collection("pins").Where("requestid", "==", requestID).Documents(ctx).GetAll()
	if err != nil {
		return fmt.Errorf("failed to query pins: %w", err)
	}
	if len(docs) == 0 {
		return errors.New("pin not found")
	}

	for _, doc := range docs {
		_, err := doc.Ref.Update(ctx, []firestore.Update{
			{Path: "status", Value: "deleted"},
			{Path: "remove_status", Value: "failed"},
		})
		if err != nil {
			return fmt.Errorf("failed to update pin status: %w", err)
		}
	}

	return nil
}

func (s *FirestoreService) UpdatePinStatus(ctx context.Context, requestID, status string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	docs, err := s.Client.Collection("pins").Where("requestid", "==", requestID).Documents(ctx).GetAll()
	if err != nil {
		return fmt.Errorf("failed to query pins: %w", err)
	}
	if len(docs) == 0 {
		return errors.New("pin not found")
	}

	for _, doc := range docs {
		_, err := doc.Ref.Update(ctx, []firestore.Update{
			{Path: "upload_status", Value: status},
		})
		if err != nil {
			return fmt.Errorf("failed to update pin status: %w", err)
		}
	}

	return nil
}

func (s *FirestoreService) GetPinByRequestID(ctx context.Context, requestID string) (PinStatus, string, error) {
	if requestID == "" {
		return PinStatus{}, "", errors.New("requestID cannot be empty")
	}

	docs, err := s.Client.Collection("pins").Where("requestid", "==", requestID).Where("status", "!=", "deleted").Documents(ctx).GetAll()
	if err != nil {
		return PinStatus{}, "", fmt.Errorf("failed to query pins: %w", err)
	}
	if len(docs) == 0 {
		return PinStatus{}, "", errors.New("pin not found")
	}

	var pinStatus PinStatus
	var username string
	for _, doc := range docs {
		data := doc.Data()

		// Safely extract username
		if u, ok := data["username"].(string); ok {
			username = u
		} else {
			return PinStatus{}, "", errors.New("invalid username in pin data")
		}

		// Safely extract created_at
		createdAt, err := doc.DataAt("created_at")
		if err != nil {
			return PinStatus{}, "", fmt.Errorf("failed to get created_at: %w", err)
		}
		createdTime, ok := createdAt.(time.Time)
		if !ok {
			return PinStatus{}, "", errors.New("invalid created_at format")
		}

		// Safely extract other fields
		cid, _ := data["cid"].(string)
		name, _ := data["name"].(string)
		status, _ := data["status"].(string)

		if cid == "" {
			return PinStatus{}, "", errors.New("invalid cid in pin data")
		}

		pinStatus = PinStatus{
			Requestid: requestID,
			Status:    Status(status),
			Created:   createdTime,
			Pin: Pin{
				Cid:     cid,
				Name:    name,
				Origins: toStringSlice(data["origins"]),
				Meta:    toStringMap(data["meta"]),
			},
			Delegates: toStringSlice(data["delegates"]),
			Info:      toStringMap(data["info"]),
		}
		break // Only need the first document
	}

	return pinStatus, username, nil
}

func toStringSlice(input interface{}) []string {
	if input == nil {
		return nil
	}
	interfaceSlice, ok := input.([]interface{})
	if !ok {
		return nil
	}
	stringSlice := make([]string, 0, len(interfaceSlice))
	for _, v := range interfaceSlice {
		if str, ok := v.(string); ok {
			stringSlice = append(stringSlice, str)
		}
	}
	return stringSlice
}

func toStringMap(input interface{}) map[string]string {
	if input == nil {
		return nil
	}
	interfaceMap, ok := input.(map[string]interface{})
	if !ok {
		return nil
	}
	stringMap := make(map[string]string)
	for k, v := range interfaceMap {
		if str, ok := v.(string); ok {
			stringMap[k] = str
		}
	}
	return stringMap
}

func roundToTopSecond(t time.Time) time.Time {
	return t
}

func roundToBottomSecond(t time.Time) time.Time {
	return t
}

func (s *FirestoreService) GetPins(ctx context.Context, username string, cid []string, name string, match TextMatchingStrategy, _ []Status, before time.Time, after time.Time, limit int, metaFilter map[string]string) ([]PinWithRequest, int, error) {
	if username == "" {
		return nil, 0, errors.New("username cannot be empty")
	}

	query := s.Client.Collection("pins").Where("username", "==", username).Where("status", "!=", "deleted")

	// Apply filters to the query
	if len(cid) > 0 {
		// Firestore 'in' query has a limit of 10 elements
		if len(cid) > 10 {
			cid = cid[:10]
		}
		query = query.Where("cid", "in", cid)
	}

	if name != "" && (match == "exact" || match == "iexact" || match == "") {
		switch match {
		case "exact", "":
			query = query.Where("name", "==", name)
		case "iexact":
			query = query.Where("name_lowercase", "==", strings.ToLower(name))
		}
	}

	if !before.IsZero() {
		roundedBefore := roundToTopSecond(before)
		query = query.Where("created_at", "<", roundedBefore)
	}

	if !after.IsZero() {
		roundedAfter := roundToBottomSecond(after)
		query = query.Where("created_at", ">", roundedAfter)
	}

	// Apply limit if specified, otherwise default to 10
	if limit <= 0 {
		limit = 10
	}
	if limit > 1000 {
		limit = 1000
	}

	// Get documents with ordering and limit
	query = query.OrderBy("created_at", firestore.Desc).Limit(limit)

	docs, err := query.Documents(ctx).GetAll()
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query pins: %w", err)
	}

	var pins []PinWithRequest
	for _, doc := range docs {
		data := doc.Data()

		// Safely extract fields with type checking
		cidValue, _ := data["cid"].(string)
		nameValue, _ := data["name"].(string)
		requestIdValue, _ := data["requestid"].(string)

		if cidValue == "" || requestIdValue == "" {
			continue // Skip invalid documents
		}

		origins := toStringSlice(data["origins"])
		meta := toStringMap(data["meta"])

		createdAt, err := doc.DataAt("created_at")
		if err != nil {
			continue // Skip documents with invalid created_at
		}
		createdTime, ok := createdAt.(time.Time)
		if !ok {
			continue // Skip documents with invalid created_at format
		}

		pin := PinWithRequest{
			Pin: Pin{
				Cid:     cidValue,
				Name:    nameValue,
				Origins: origins,
				Meta:    meta,
			},
			RequestId: requestIdValue,
			Created:   createdTime,
		}

		// Perform post-query filtering for partial and ipartial matches
		if name != "" {
			switch match {
			case "partial":
				if !strings.Contains(pin.Pin.Name, name) {
					continue
				}
			case "ipartial":
				if !strings.Contains(strings.ToLower(pin.Pin.Name), strings.ToLower(name)) {
					continue
				}
			}
		}

		// Apply meta filter (AND logic per IPFS spec)
		if len(metaFilter) > 0 {
			metaMatch := true
			for k, v := range metaFilter {
				if meta == nil || meta[k] != v {
					metaMatch = false
					break
				}
			}
			if !metaMatch {
				continue
			}
		}

		pins = append(pins, pin)
	}

	// Return the count as the number of matching pins after all filters
	return pins, len(pins), nil
}

func (s *FirestoreService) GetUserIDFromToken(ctx context.Context, token string, tag string) (string, error) {
	docs, err := s.Client.Collection("sessions").Where("session_token", "==", token).Documents(ctx).GetAll()
	if err != nil {
		if ctx.Err() == context.Canceled {
			return "", fmt.Errorf("GetUserIDFromToken: context canceled in %s: %v", tag, err)
		}
		return "", fmt.Errorf("GetUserIDFromToken: error querying Firestore in %s: %v", tag, err)
	}
	if len(docs) == 0 {
		return "", fmt.Errorf("GetUserIDFromToken: no documents found for session token in %s: %s", tag, token)
	}

	for _, doc := range docs {
		username, ok := doc.Data()["username"].(string)
		if !ok {
			return "", fmt.Errorf("GetUserIDFromToken: error casting username to string for session token: %s", token)
		}
		return username, nil
	}

	return "", nil
}
