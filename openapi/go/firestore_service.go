package openapi

import (
	"context"
	"errors"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/option"
)

type FirestoreService struct {
	Client *firestore.Client
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

func (s *FirestoreService) AddPin(ctx context.Context, username string, pin Pin) error {
	_, _, err := s.Client.Collection("pins").Add(ctx, map[string]interface{}{
		"username":   username,
		"cid":        pin.Cid,
		"status":     "queued",
		"requestid":  generateRequestID(pin),
		"created_at": time.Now(),
	})
	return err
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

func (s *FirestoreService) GetPinByRequestID(ctx context.Context, requestID string) (PinStatus, error) {
	docs, err := s.Client.Collection("pins").Where("requestid", "==", requestID).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return PinStatus{}, err
	}

	var pinStatus PinStatus
	for _, doc := range docs {
		pinStatus = PinStatus{
			Requestid: requestID,
			Status:    Status(doc.Data()["status"].(string)),
			Created:   doc.Data()["created_at"].(time.Time),
			Pin: Pin{
				Cid:     doc.Data()["cid"].(string),
				Name:    doc.Data()["name"].(string),
				Origins: doc.Data()["origins"].([]string),
				Meta:    doc.Data()["meta"].(map[string]string),
			},
			Delegates: doc.Data()["delegates"].([]string),
			Info:      doc.Data()["info"].(map[string]string),
		}
	}

	return pinStatus, nil
}

func (s *FirestoreService) GetPins(ctx context.Context, username string, limit int) ([]Pin, error) {
	docs, err := s.Client.Collection("pins").Where("username", "==", username).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}

	var pins []Pin
	for _, doc := range docs {
		pin := Pin{
			Cid:     doc.Data()["cid"].(string),
			Name:    doc.Data()["name"].(string),
			Origins: doc.Data()["origins"].([]string),
			Meta:    doc.Data()["meta"].(map[string]string),
		}
		pins = append(pins, pin)
	}

	return pins, nil
}

func (s *FirestoreService) GetUserIDFromToken(ctx context.Context, token string) (string, error) {
	docs, err := s.Client.Collection("sessions").Where("session_token", "==", token).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return "", errors.New("invalid or expired session token: " + token)
	}

	var username string
	for _, doc := range docs {
		username = doc.Data()["username"].(string)
		break
	}

	return username, nil
}
