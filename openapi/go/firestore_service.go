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

func (s *FirestoreService) AddPin(ctx context.Context, username string, pin Pin) (string, error) {
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
	})
	if err != nil {
		return "", err
	}
	return requestId, nil
}

func (s *FirestoreService) DeletePin(ctx context.Context, requestID string) error {
	docs, err := s.Client.Collection("pins").Where("requestid", "==", requestID).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return err
	}

	for _, doc := range docs {
		_, err := doc.Ref.Delete(ctx)
		if err != nil {
			return err
		}
	}

	return nil
}

func (s *FirestoreService) GetPinByRequestID(ctx context.Context, requestID string) (PinStatus, string, error) {
	docs, err := s.Client.Collection("pins").Where("requestid", "==", requestID).Documents(ctx).GetAll()
	if err != nil {
		return PinStatus{}, "", err
	}
	if len(docs) == 0 {
		return PinStatus{}, "", errors.New("document not found")
	}

	var pinStatus PinStatus
	var username string
	for _, doc := range docs {
		data := doc.Data()
		username = data["username"].(string)
		pinStatus = PinStatus{
			Requestid: requestID,
			Status:    Status(data["status"].(string)),
			Created:   data["created_at"].(time.Time),
			Pin: Pin{
				Cid:     data["cid"].(string),
				Name:    data["name"].(string),
				Origins: toStringSlice(data["origins"]),
				Meta:    toStringMap(data["meta"]),
			},
			Delegates: toStringSlice(data["delegates"]),
			Info:      toStringMap(data["info"]),
		}
	}

	return pinStatus, username, nil
}

func toStringSlice(input interface{}) []string {
	if input == nil {
		return nil
	}
	interfaceSlice := input.([]interface{})
	stringSlice := make([]string, len(interfaceSlice))
	for i, v := range interfaceSlice {
		stringSlice[i] = v.(string)
	}
	return stringSlice
}

func toStringMap(input interface{}) map[string]string {
	if input == nil {
		return nil
	}
	interfaceMap := input.(map[string]interface{})
	stringMap := make(map[string]string)
	for k, v := range interfaceMap {
		stringMap[k] = v.(string)
	}
	return stringMap
}

func roundToTopSecond(t time.Time) time.Time {
	/*if t.Nanosecond() > 0 || t.Second() > 0 {
		return t.Truncate(time.Minute).Add(time.Minute)
	}
	return t.Truncate(time.Minute)*/
	return t
}

func roundToBottomSecond(t time.Time) time.Time {
	//return t.Truncate(time.Second)
	return t
}

func (s *FirestoreService) GetPins(ctx context.Context, username string, cid []string, name string, match TextMatchingStrategy, _ []Status, before time.Time, after time.Time, limit int, meta map[string]string) ([]PinWithRequest, int, error) {
	query := s.Client.Collection("pins").Where("username", "==", username)

	// Apply filters to the query
	if len(cid) > 0 {
		query = query.Where("cid", "in", cid)
	}

	if name != "" && (match == "exact" || match == "iexact") {
		switch match {
		case "exact":
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

	// Get the count of all matching documents
	countQuery := query
	countDocs, err := countQuery.Documents(ctx).GetAll()
	if err != nil {
		return nil, 0, err
	}
	count := len(countDocs)

	// Apply limit if specified, otherwise default to 10
	if limit <= 0 {
		limit = 10
	}
	query = query.OrderBy("created_at", firestore.Desc).Limit(limit)

	docs, err := query.Documents(ctx).GetAll()
	if err != nil {
		return nil, 0, err
	}

	var pins []PinWithRequest
	for _, doc := range docs {
		var origins []string
		if doc.Data()["origins"] != nil {
			origins = doc.Data()["origins"].([]string)
		}

		var meta map[string]string
		if doc.Data()["meta"] != nil {
			metaInterface := doc.Data()["meta"].(map[string]interface{})
			meta = make(map[string]string, len(metaInterface))
			for k, v := range metaInterface {
				meta[k] = v.(string)
			}
		}

		pin := PinWithRequest{
			Pin: Pin{
				Cid:     doc.Data()["cid"].(string),
				Name:    doc.Data()["name"].(string),
				Origins: origins,
				Meta:    meta,
			},
			RequestId: doc.Data()["requestid"].(string),
		}

		// Perform post-query filtering for partial and ipartial matches
		if name != "" {
			switch match {
			case "partial":
				if !strings.Contains(pin.Pin.Name, name) {
					count = count - 1
					continue
				}
			case "ipartial":
				if !strings.Contains(strings.ToLower(pin.Pin.Name), strings.ToLower(name)) {
					count = count - 1
					continue
				}
			}
		}

		pins = append(pins, pin)
	}

	return pins, count, nil
}

func (s *FirestoreService) GetUserIDFromToken(ctx context.Context, token string) (string, error) {
	docs, err := s.Client.Collection("sessions").Where("session_token", "==", token).Documents(ctx).GetAll()
	if err != nil {
		return "", fmt.Errorf("GetUserIDFromToken: error querying Firestore: %v", err)
	}
	if len(docs) == 0 {
		return "", fmt.Errorf("GetUserIDFromToken: no documents found for session token: %s", token)
	}

	var username string
	for _, doc := range docs {
		username, ok := doc.Data()["username"].(string)
		if !ok {
			return "", fmt.Errorf("GetUserIDFromToken: error casting username to string for session token: %s", token)
		}
		break
	}

	return username, nil
}
