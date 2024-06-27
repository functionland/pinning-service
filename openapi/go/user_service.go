package openapi

import (
	"context"
	"errors"
	"fmt"
	"time"

	"cloud.google.com/go/firestore"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

type UserService struct {
	client *firestore.Client
}

func NewUserService(client *firestore.Client) (*UserService, error) {
	return &UserService{client: client}, nil
}

func (s *UserService) Close() error {
	return s.client.Close()
}

func (s *UserService) CreateUser(ctx context.Context, username, password string) error {
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

func (s *UserService) AuthenticateUser(ctx context.Context, username, password string) (string, error) {
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

func (s *UserService) GetUserPasswordHash(ctx context.Context, username string) (string, error) {
	docs, err := s.client.Collection("users").Where("username", "==", username).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return "", errors.New("invalid username: " + username)
	}

	var passwordHash string
	for _, doc := range docs {
		passwordHash = doc.Data()["password_hash"].(string)
		break
	}

	return passwordHash, nil
}

func (s *UserService) GetPasswordHashFromAuthToken(ctx context.Context, authToken string) (string, error) {
	docs, err := s.client.Collection("sessions").Where("session_token", "==", authToken).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return "", errors.New("invalid or expired session token: " + authToken)
	}

	var username string
	for _, doc := range docs {
		username = doc.Data()["username"].(string)
		break
	}

	return s.GetUserPasswordHash(ctx, username)
}

func (s *UserService) CreateSession(ctx context.Context, username string) (string, error) {
	sessionToken := generateSessionToken()
	_, _, err := s.client.Collection("sessions").Add(ctx, map[string]interface{}{
		"username":      username,
		"session_token": sessionToken,
		"created_at":    time.Now(),
	})
	if err != nil {
		return "", err
	}

	return sessionToken, nil
}

func (s *UserService) ValidateSession(ctx context.Context, sessionToken string) (string, error) {
	docs, err := s.client.Collection("sessions").Where("session_token", "==", sessionToken).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return "", err
	}

	var username string
	for _, doc := range docs {
		username = doc.Data()["username"].(string)
	}

	return username, nil
}

func (s *UserService) DeleteSession(ctx context.Context, sessionToken string) error {
	docs, err := s.client.Collection("sessions").Where("session_token", "==", sessionToken).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return errors.New("session token not found")
	}

	for _, doc := range docs {
		_, err := doc.Ref.Delete(ctx)
		if err != nil {
			return err
		}
	}

	return nil
}

func (s *UserService) GetUserPoolFromSession(ctx context.Context, authToken string) (int, error) {
	// Default pool ID in case of error or not found
	defaultPoolID := 1

	// Query the sessions collection to find the user by auth token
	docs, err := s.client.Collection("sessions").Where("session_token", "==", authToken).Documents(ctx).GetAll()
	if err != nil || len(docs) == 0 {
		return defaultPoolID, errors.New("invalid or expired session token: " + authToken)
	}

	var username string
	for _, doc := range docs {
		username = doc.Data()["username"].(string)
		break // We only need the first document
	}

	// Query the users collection to find the user's pool ID by username
	userDocs, err := s.client.Collection("users").Where("username", "==", username).Documents(ctx).GetAll()
	if err != nil || len(userDocs) == 0 {
		return defaultPoolID, err
	}

	var poolId int
	for _, doc := range userDocs {
		poolIdValue := doc.Data()["pool_id"]
		switch v := poolIdValue.(type) {
		case int64:
			poolId = int(v)
		case float64:
			poolId = int(v)
		case int:
			poolId = v
		default:
			return defaultPoolID, errors.New("pool_id is not of a type that can be converted to int, actual type: " + fmt.Sprintf("%T", v))
		}
		return poolId, nil
	}

	return defaultPoolID, nil
}

func generateSessionToken() string {
	// Implementation for generating a secure session token
	return uuid.New().String()
}
