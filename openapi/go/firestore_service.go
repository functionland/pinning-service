package openapi

import (
	"context"
	"errors"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"golang.org/x/crypto/bcrypt"
	"google.golang.org/api/option"
	"google.golang.org/grpc/metadata"
)

type FirestoreService struct {
	client *firestore.Client
}

func NewFirestoreService(ctx context.Context, credentialsFile string) (*FirestoreService, error) {
	client, err := firestore.NewClient(ctx, "your-project-id", option.WithCredentialsFile(credentialsFile))
	if err != nil {
		return nil, err
	}
	return &FirestoreService{client: client}, nil
}

func (s *FirestoreService) Close() error {
	return s.client.Close()
}

func (s *FirestoreService) CreateUser(ctx context.Context, username, password string) error {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	_, _, err = s.client.Collection("users").Add(ctx, map[string]interface{}{
		"username":      username,
		"password_hash": string(hashedPassword),
		"created_at":    time.Now(),
	})
	return err
}

func (s *FirestoreService) AuthenticateUser(ctx context.Context, username, password string) (string, error) {
	docs, err := s.client.Collection("users").Where("username", "==", username).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return "", err
	}

	var id string
	var hashedPassword string
	for _, doc := range docs {
		id = doc.Ref.ID
		hashedPassword = doc.Data()["password_hash"].(string)
	}

	err = bcrypt.CompareHashAndPassword([]byte(hashedPassword), []byte(password))
	if err != nil {
		return "", err
	}

	return id, nil
}

func (s *FirestoreService) GetPasswordHashFromAuthToken(ctx context.Context, authToken string) (string, error) {
	docs, err := s.client.Collection("sessions").Where("session_token", "==", authToken).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return "", errors.New("invalid or expired session token")
	}

	var userID string
	for _, doc := range docs {
		userID = doc.Data()["user_id"].(string)
		break
	}

	return s.GetUserPasswordHash(ctx, userID)
}

func (s *FirestoreService) GetUserPasswordHash(ctx context.Context, userID string) (string, error) {
	doc, err := s.client.Collection("users").Doc(userID).Get(ctx)
	if err != nil {
		return "", err
	}

	passwordHash, ok := doc.Data()["password_hash"].(string)
	if !ok {
		return "", errors.New("password hash not found")
	}

	return passwordHash, nil
}

func extractAuthTokenFromContext(ctx context.Context) (string, error) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return "", errors.New("no metadata found in context")
	}

	authHeader, ok := md["authorization"]
	if !ok || len(authHeader) == 0 {
		return "", errors.New("authorization token not found in context")
	}

	token := strings.TrimPrefix(authHeader[0], "Bearer ")
	return token, nil
}

func (s *FirestoreService) CreateSession(ctx context.Context, userID string) (string, error) {
	sessionToken := generateSessionToken()
	_, _, err := s.client.Collection("sessions").Add(ctx, map[string]interface{}{
		"user_id":       userID,
		"session_token": sessionToken,
		"created_at":    time.Now(),
	})
	if err != nil {
		return "", err
	}

	return sessionToken, nil
}

func (s *FirestoreService) ValidateSession(ctx context.Context, sessionToken string) (string, error) {
	docs, err := s.client.Collection("sessions").Where("session_token", "==", sessionToken).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return "", err
	}

	var userID string
	for _, doc := range docs {
		userID = doc.Data()["user_id"].(string)
	}

	return userID, nil
}

func (s *FirestoreService) AddPin(ctx context.Context, pin Pin) error {
	_, _, err := s.client.Collection("pins").Add(ctx, map[string]interface{}{
		"cid":        pin.Cid,
		"status":     "queued",
		"requestid":  generateRequestID(pin),
		"created_at": time.Now(),
	})
	return err
}

func (s *FirestoreService) DeletePin(ctx context.Context, requestID string) error {
	docs, err := s.client.Collection("pins").Where("requestid", "==", requestID).Documents(ctx).GetAll()
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
	docs, err := s.client.Collection("pins").Where("requestid", "==", requestID).Documents(ctx).GetAll()
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

func (s *FirestoreService) GetPins(ctx context.Context, limit int) ([]Pin, error) {
	docs, err := s.client.Collection("pins").Limit(limit).Documents(ctx).GetAll()
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

func generateSessionToken() string {
	// Implementation for generating a secure session token
	return "secureRandomToken"
}
