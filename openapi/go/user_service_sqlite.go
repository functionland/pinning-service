package openapi

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// UserServiceSQLite provides user management using SQLite
type UserServiceSQLite struct {
	db *SQLiteService
}

// NewUserServiceSQLite creates a new user service with SQLite backend
func NewUserServiceSQLite(db *SQLiteService) (*UserServiceSQLite, error) {
	return &UserServiceSQLite{db: db}, nil
}

// Close is a no-op for SQLite user service (SQLiteService handles connection)
func (s *UserServiceSQLite) Close() error {
	return nil
}

// CreateUser creates a new user with hashed password
func (s *UserServiceSQLite) CreateUser(ctx context.Context, username, password string) error {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	return s.db.CreateUser(ctx, username, string(hashedPassword), 1)
}

// CreateUserWithPool creates a new user with a specific pool ID
func (s *UserServiceSQLite) CreateUserWithPool(ctx context.Context, username, password string, poolId int) error {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	return s.db.CreateUser(ctx, username, string(hashedPassword), poolId)
}

// AuthenticateUser authenticates a user and returns their ID if successful
func (s *UserServiceSQLite) AuthenticateUser(ctx context.Context, username, password string) (string, error) {
	passwordHash, err := s.db.GetUserPasswordHash(ctx, username)
	if err != nil {
		return "", err
	}

	err = bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password))
	if err != nil {
		return "", errors.New("invalid credentials")
	}

	return username, nil
}

// GetUserPasswordHash retrieves the password hash for a user
func (s *UserServiceSQLite) GetUserPasswordHash(ctx context.Context, username string) (string, error) {
	return s.db.GetUserPasswordHash(ctx, username)
}

// GetPasswordHashFromAuthToken retrieves password hash using auth token
func (s *UserServiceSQLite) GetPasswordHashFromAuthToken(ctx context.Context, authToken string) (string, error) {
	return s.db.GetPasswordHashFromAuthToken(ctx, authToken)
}

// CreateSession creates a new session for a user
func (s *UserServiceSQLite) CreateSession(ctx context.Context, username string) (string, error) {
	sessionToken := generateSessionTokenSQLite()
	err := s.db.CreateSession(ctx, username, sessionToken)
	if err != nil {
		return "", err
	}
	return sessionToken, nil
}

// ValidateSession validates a session token and returns the username
func (s *UserServiceSQLite) ValidateSession(ctx context.Context, sessionToken string) (string, error) {
	return s.db.ValidateSession(ctx, sessionToken)
}

// DeleteSession deletes a session
func (s *UserServiceSQLite) DeleteSession(ctx context.Context, sessionToken string) error {
	return s.db.DeleteSession(ctx, sessionToken)
}

// GetUserPoolFromSession retrieves pool ID from session token
func (s *UserServiceSQLite) GetUserPoolFromSession(ctx context.Context, authToken string) (int, error) {
	return s.db.GetUserPoolFromSession(ctx, authToken)
}

// RecordLoginAttempt records a login attempt for audit purposes
func (s *UserServiceSQLite) RecordLoginAttempt(ctx context.Context, username, status, ipAddress, userAgent string) error {
	return s.db.RecordLogin(ctx, username, status, ipAddress, userAgent)
}

func generateSessionTokenSQLite() string {
	return uuid.New().String()
}
