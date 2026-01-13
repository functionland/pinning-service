package openapi

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// UserServicePostgres provides user management using PostgreSQL
type UserServicePostgres struct {
	db *PostgresService
}

// NewUserServicePostgres creates a new user service with PostgreSQL backend
func NewUserServicePostgres(db *PostgresService) (*UserServicePostgres, error) {
	return &UserServicePostgres{db: db}, nil
}

// Close is a no-op for PostgreSQL user service (PostgresService handles connection)
func (s *UserServicePostgres) Close() error {
	return nil
}

// CreateUser creates a new user with hashed password
func (s *UserServicePostgres) CreateUser(ctx context.Context, username, password string) error {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	return s.db.CreateUser(ctx, username, string(hashedPassword), 1)
}

// CreateUserWithPool creates a new user with a specific pool ID
func (s *UserServicePostgres) CreateUserWithPool(ctx context.Context, username, password string, poolId int) error {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	return s.db.CreateUser(ctx, username, string(hashedPassword), poolId)
}

// AuthenticateUser authenticates a user and returns their ID if successful
func (s *UserServicePostgres) AuthenticateUser(ctx context.Context, username, password string) (string, error) {
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
func (s *UserServicePostgres) GetUserPasswordHash(ctx context.Context, username string) (string, error) {
	return s.db.GetUserPasswordHash(ctx, username)
}

// GetPasswordHashFromAuthToken retrieves password hash using auth token
func (s *UserServicePostgres) GetPasswordHashFromAuthToken(ctx context.Context, authToken string) (string, error) {
	return s.db.GetPasswordHashFromAuthToken(ctx, authToken)
}

// CreateSession creates a new session for a user
func (s *UserServicePostgres) CreateSession(ctx context.Context, username string) (string, error) {
	sessionToken := generateSessionTokenPostgres()
	err := s.db.CreateSession(ctx, username, sessionToken)
	if err != nil {
		return "", err
	}
	return sessionToken, nil
}

// ValidateSession validates a session token and returns the username
func (s *UserServicePostgres) ValidateSession(ctx context.Context, sessionToken string) (string, error) {
	return s.db.ValidateSession(ctx, sessionToken)
}

// DeleteSession deletes a session
func (s *UserServicePostgres) DeleteSession(ctx context.Context, sessionToken string) error {
	return s.db.DeleteSession(ctx, sessionToken)
}

// GetUserPoolFromSession retrieves pool ID from session token
func (s *UserServicePostgres) GetUserPoolFromSession(ctx context.Context, authToken string) (int, error) {
	return s.db.GetUserPoolFromSession(ctx, authToken)
}

// RecordLoginAttempt records a login attempt for audit purposes
func (s *UserServicePostgres) RecordLoginAttempt(ctx context.Context, username, status, ipAddress, userAgent string) error {
	return s.db.RecordLogin(ctx, username, status, ipAddress, userAgent)
}

func generateSessionTokenPostgres() string {
	return uuid.New().String()
}
