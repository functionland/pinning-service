package openapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	_ "github.com/lib/pq"
)

// hashToken returns the SHA-256 hex digest of a session token.
// Used to store and look up tokens without keeping the raw value.
func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// ErrPinNotFound is returned by GetPinByRequestID when the row does not exist.
// Callers should distinguish this from real DB errors so 404 vs 500 can be
// returned correctly instead of collapsing every failure to 404.
var ErrPinNotFound = errors.New("pin not found")

// PostgresService provides database operations using PostgreSQL
type PostgresService struct {
	db   *sql.DB
	mu   sync.RWMutex
	dsn  string
}

// NewPostgresService creates a new PostgreSQL service with optimized settings
func NewPostgresService(dsn string) (*PostgresService, error) {
	// Open database connection
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Verify connection
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to connect to database: %w", err)
	}

	// Configure connection pool for better concurrency
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(1 * time.Minute)

	service := &PostgresService{
		db:  db,
		dsn: dsn,
	}

	// Initialize database schema (tables should be created via migration scripts)
	// We only check if tables exist, don't create them
	if err := service.verifySchema(); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema verification failed: %w", err)
	}

	return service, nil
}

// NewPostgresServiceFromEnv creates a PostgreSQL service from environment variables
func NewPostgresServiceFromEnv() (*PostgresService, error) {
	host := os.Getenv("POSTGRES_HOST")
	if host == "" {
		host = "localhost"
	}
	port := os.Getenv("POSTGRES_PORT")
	if port == "" {
		port = "5432"
	}
	dbname := os.Getenv("POSTGRES_DB")
	if dbname == "" {
		dbname = "pinning_service"
	}
	user := os.Getenv("POSTGRES_USER")
	if user == "" {
		user = "pinning_user"
	}
	password := os.Getenv("POSTGRES_PASSWORD")
	sslmode := os.Getenv("POSTGRES_SSL")
	if sslmode == "" {
		sslmode = "disable"
	}

	dsn := fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=%s",
		host, port, dbname, user, password, sslmode)

	return NewPostgresService(dsn)
}

// verifySchema checks that required tables exist
func (s *PostgresService) verifySchema() error {
	tables := []string{"users", "sessions", "pins", "logins"}
	for _, table := range tables {
		var exists bool
		err := s.db.QueryRow(`
			SELECT EXISTS (
				SELECT FROM information_schema.tables
				WHERE table_schema = 'public' AND table_name = $1
			)
		`, table).Scan(&exists)
		if err != nil {
			return fmt.Errorf("failed to check table %s: %w", table, err)
		}
		if !exists {
			return fmt.Errorf("required table '%s' does not exist - run migrations first", table)
		}
	}

	// Ensure critical indexes exist for query performance
	if err := s.ensureIndexes(); err != nil {
		log.Printf("Warning: failed to ensure indexes: %v", err)
	}

	return nil
}

// ensureIndexes creates critical indexes if they don't already exist.
func (s *PostgresService) ensureIndexes() error {
	indexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_pins_username ON pins(username)`,
		`CREATE INDEX IF NOT EXISTS idx_pins_status ON pins(status)`,
		`CREATE INDEX IF NOT EXISTS idx_pins_created ON pins(created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_pins_username_status ON pins(username, status)`,
		`CREATE INDEX IF NOT EXISTS idx_pins_username_created ON pins(username, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_pins_cid ON pins(cid)`,
		`CREATE INDEX IF NOT EXISTS idx_pins_session_token ON pins(session_token)`,
		`CREATE INDEX IF NOT EXISTS idx_pins_token_hash ON pins(token_hash)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username)`,
	}
	for _, ddl := range indexes {
		if _, err := s.db.Exec(ddl); err != nil {
			return fmt.Errorf("failed to create index: %s: %w", ddl, err)
		}
	}
	log.Println("postgres: ensured critical indexes exist")
	return nil
}

// Close closes the database connection
func (s *PostgresService) Close() error {
	return s.db.Close()
}

// GetDB returns the underlying database connection for advanced use
func (s *PostgresService) GetDB() *sql.DB {
	return s.db
}

// ============================================================================
// Pin Operations
// ============================================================================

// AddPin adds a new pin to the database
func (s *PostgresService) AddPin(ctx context.Context, username string, pin Pin, uploadStatus string) (string, error) {
	return s.AddPinWithSize(ctx, username, pin, uploadStatus, 0, "")
}

// AddPinWithSize adds a new pin to the database with size and session tracking
func (s *PostgresService) AddPinWithSize(ctx context.Context, username string, pin Pin, uploadStatus string, size int64, sessionToken string) (string, error) {
	requestId := generateRequestID(pin)

	originsJSON, err := json.Marshal(pin.Origins)
	if err != nil {
		originsJSON = []byte("[]")
	}

	metaJSON, err := json.Marshal(pin.Meta)
	if err != nil {
		metaJSON = []byte("{}")
	}

	createdAt := time.Now().UTC()

	var th string
	if sessionToken != "" {
		th = hashToken(sessionToken)
	}

	uid := hashToken(username) // user_id = SHA-256(email)

	// New entries: no plain-text username or session_token stored.
	// Old entries retain their plain-text values for fallback during migration.
	// $9 and $10 are both bound to `th` (dual-write of session_token and
	// token_hash). They must be *separate* placeholders because the two
	// columns have different Postgres types (session_token TEXT vs
	// token_hash VARCHAR(64)); reusing $9 for both causes
	// "inconsistent types deduced for parameter $9" at prepare time.
	query := `
		INSERT INTO pins (requestid, cid, name, name_lowercase, origins, meta, status, upload_status, size, session_token, token_hash, user_id, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11, $12)
	`

	_, err = s.db.ExecContext(ctx, query,
		requestId,
		pin.Cid,
		pin.Name,
		strings.ToLower(pin.Name),
		string(originsJSON),
		string(metaJSON),
		uploadStatus,
		size,
		th,
		th,
		uid,
		createdAt,
	)
	if err != nil {
		return "", fmt.Errorf("failed to add pin: %w", err)
	}

	return requestId, nil
}

// DeletePin permanently removes a pin from the database
func (s *PostgresService) DeletePin(ctx context.Context, requestID string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx, "DELETE FROM pins WHERE requestid = $1", requestID)
	if err != nil {
		return fmt.Errorf("failed to delete pin: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return errors.New("pin not found")
	}

	return nil
}

// MarkPinAsDeleted marks a pin as deleted (soft delete)
func (s *PostgresService) MarkPinAsDeleted(ctx context.Context, requestID string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx,
		"UPDATE pins SET status = 'deleted', remove_status = 'pending' WHERE requestid = $1",
		requestID,
	)
	if err != nil {
		return fmt.Errorf("failed to mark pin as deleted: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return errors.New("pin not found")
	}

	return nil
}

// MarkPinAsDeleteFailed marks a pin deletion as failed
func (s *PostgresService) MarkPinAsDeleteFailed(ctx context.Context, requestID string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx,
		"UPDATE pins SET status = 'deleted', remove_status = 'failed' WHERE requestid = $1",
		requestID,
	)
	if err != nil {
		return fmt.Errorf("failed to mark pin deletion as failed: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return errors.New("pin not found")
	}

	return nil
}

// UpdatePinStatus updates the upload status of a pin
func (s *PostgresService) UpdatePinStatus(ctx context.Context, requestID, status string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx,
		"UPDATE pins SET upload_status = $1 WHERE requestid = $2",
		status, requestID,
	)
	if err != nil {
		return fmt.Errorf("failed to update pin status: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return errors.New("pin not found")
	}

	return nil
}

// UpdatePinPinningStatus updates the pinning status of a pin
func (s *PostgresService) UpdatePinPinningStatus(ctx context.Context, requestID, status string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx,
		"UPDATE pins SET status = $1 WHERE requestid = $2",
		status, requestID,
	)
	if err != nil {
		return fmt.Errorf("failed to update pin pinning status: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return errors.New("pin not found")
	}

	return nil
}

// GetExistingPinByCID retrieves an existing non-deleted pin by CID for a user
func (s *PostgresService) GetExistingPinByCID(ctx context.Context, username, cid string) (*PinStatus, error) {
	if username == "" || cid == "" {
		return nil, nil
	}

	uid := hashToken(username)
	query := `
		SELECT requestid, cid, name, origins, meta, status, delegates, info, created_at
		FROM pins
		WHERE (user_id = $1 OR username = $3) AND cid = $2 AND status != 'deleted'
		ORDER BY created_at DESC
		LIMIT 1
	`

	var (
		reqID, cidVal, name, status string
		originsJSON, metaJSON       string
		delegatesJSON, infoJSON     string
		createdAt                   time.Time
	)

	err := s.db.QueryRowContext(ctx, query, uid, cid, username).Scan(
		&reqID, &cidVal, &name, &originsJSON, &metaJSON,
		&status, &delegatesJSON, &infoJSON, &createdAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to query existing pin: %w", err)
	}

	var origins []string
	var meta map[string]string
	var delegates []string
	var info map[string]string

	json.Unmarshal([]byte(originsJSON), &origins)
	json.Unmarshal([]byte(metaJSON), &meta)
	json.Unmarshal([]byte(delegatesJSON), &delegates)
	json.Unmarshal([]byte(infoJSON), &info)

	pinStatus := PinStatus{
		Requestid: reqID,
		Status:    Status(status),
		Created:   createdAt,
		Pin: Pin{
			Cid:     cidVal,
			Name:    name,
			Origins: origins,
			Meta:    meta,
		},
		Delegates: delegates,
		Info:      info,
	}

	return &pinStatus, nil
}

// GetPinByRequestID retrieves a pin by its request ID. Returns the pin status
// along with both ownership identifiers from the row: user_id (SHA-256 hash,
// post-PII-wipe form) and username (legacy email/plain form). Either may be
// empty depending on whether the row was backfilled and/or PII-wiped — callers
// should use pinOwnerMatches to decide ownership rather than comparing one
// field directly.
//
// Returns ErrPinNotFound when no row matches; wraps other DB errors verbatim.
//
// Note: origins/meta/delegates/info are still scanned as plain strings since
// the wipe script does not touch them. If a future wipe nulls any of those
// columns, they'll need the same sql.NullString treatment.
func (s *PostgresService) GetPinByRequestID(ctx context.Context, requestID string) (PinStatus, string, string, error) {
	if requestID == "" {
		return PinStatus{}, "", "", errors.New("requestID cannot be empty")
	}

	query := `
		SELECT requestid, user_id, username, cid, name, origins, meta, status, delegates, info, created_at
		FROM pins
		WHERE requestid = $1 AND status != 'deleted'
	`

	var (
		reqID, cid, name, status string
		userID, username         sql.NullString
		originsJSON, metaJSON    string
		delegatesJSON, infoJSON  string
		createdAt                time.Time
	)

	err := s.db.QueryRowContext(ctx, query, requestID).Scan(
		&reqID, &userID, &username, &cid, &name, &originsJSON, &metaJSON,
		&status, &delegatesJSON, &infoJSON, &createdAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return PinStatus{}, "", "", ErrPinNotFound
		}
		return PinStatus{}, "", "", fmt.Errorf("failed to query pin: %w", err)
	}

	var origins []string
	var meta map[string]string
	var delegates []string
	var info map[string]string

	json.Unmarshal([]byte(originsJSON), &origins)
	json.Unmarshal([]byte(metaJSON), &meta)
	json.Unmarshal([]byte(delegatesJSON), &delegates)
	json.Unmarshal([]byte(infoJSON), &info)

	pinStatus := PinStatus{
		Requestid: reqID,
		Status:    Status(status),
		Created:   createdAt,
		Pin: Pin{
			Cid:     cid,
			Name:    name,
			Origins: origins,
			Meta:    meta,
		},
		Delegates: delegates,
		Info:      info,
	}

	return pinStatus, userID.String, username.String, nil
}

// GetPins retrieves pins with filtering options
func (s *PostgresService) GetPins(ctx context.Context, username string, cid []string, name string, match TextMatchingStrategy, statuses []Status, before time.Time, after time.Time, limit int, metaFilter map[string]string) ([]PinWithRequest, int, error) {
	if username == "" {
		return nil, 0, errors.New("username cannot be empty")
	}

	// Build WHERE clause — use user_id with fallback to username for old entries
	uid := hashToken(username)
	whereClause := "(user_id = $1 OR username = $2) AND status != 'deleted'"
	whereArgs := []interface{}{uid, username}
	argNum := 3

	// CID filter
	if len(cid) > 0 {
		placeholders := make([]string, len(cid))
		for i, c := range cid {
			placeholders[i] = fmt.Sprintf("$%d", argNum)
			whereArgs = append(whereArgs, c)
			argNum++
		}
		whereClause += " AND cid IN (" + strings.Join(placeholders, ",") + ")"
	}

	// Name filter
	if name != "" {
		switch match {
		case "exact", "":
			whereClause += fmt.Sprintf(" AND name = $%d", argNum)
			whereArgs = append(whereArgs, name)
			argNum++
		case "iexact":
			whereClause += fmt.Sprintf(" AND name_lowercase = $%d", argNum)
			whereArgs = append(whereArgs, strings.ToLower(name))
			argNum++
		case "partial":
			whereClause += fmt.Sprintf(" AND name LIKE $%d", argNum)
			whereArgs = append(whereArgs, "%"+name+"%")
			argNum++
		case "ipartial":
			whereClause += fmt.Sprintf(" AND name_lowercase LIKE $%d", argNum)
			whereArgs = append(whereArgs, "%"+strings.ToLower(name)+"%")
			argNum++
		}
	}

	// Status filter
	if len(statuses) > 0 {
		placeholders := make([]string, len(statuses))
		for i, st := range statuses {
			placeholders[i] = fmt.Sprintf("$%d", argNum)
			whereArgs = append(whereArgs, string(st))
			argNum++
		}
		whereClause += " AND status IN (" + strings.Join(placeholders, ",") + ")"
	}

	// Time filters
	if !before.IsZero() {
		whereClause += fmt.Sprintf(" AND created_at < $%d", argNum)
		whereArgs = append(whereArgs, before)
		argNum++
	}
	if !after.IsZero() {
		whereClause += fmt.Sprintf(" AND created_at > $%d", argNum)
		whereArgs = append(whereArgs, after)
		argNum++
	}

	// Get total count
	countQuery := "SELECT COUNT(*) FROM pins WHERE " + whereClause
	var totalCount int
	if err := s.db.QueryRowContext(ctx, countQuery, whereArgs...).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("failed to count pins: %w", err)
	}

	// Set limit
	if limit <= 0 {
		limit = 10
	}
	if limit > 1000 {
		limit = 1000
	}

	selectQuery := fmt.Sprintf("SELECT requestid, cid, name, origins, meta, status, created_at FROM pins WHERE %s ORDER BY created_at DESC LIMIT $%d", whereClause, argNum)
	selectArgs := append(whereArgs, limit)

	rows, err := s.db.QueryContext(ctx, selectQuery, selectArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query pins: %w", err)
	}
	defer rows.Close()

	var pins []PinWithRequest
	for rows.Next() {
		var (
			reqID, cidVal, nameVal, status string
			originsJSON, metaJSON          string
			createdAt                      time.Time
		)

		if err := rows.Scan(&reqID, &cidVal, &nameVal, &originsJSON, &metaJSON, &status, &createdAt); err != nil {
			continue
		}

		var origins []string
		var meta map[string]string
		json.Unmarshal([]byte(originsJSON), &origins)
		json.Unmarshal([]byte(metaJSON), &meta)

		// Apply meta filter if specified
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

		pins = append(pins, PinWithRequest{
			Pin: Pin{
				Cid:     cidVal,
				Name:    nameVal,
				Origins: origins,
				Meta:    meta,
			},
			RequestId: reqID,
			Created:   createdAt,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating pins: %w", err)
	}

	return pins, totalCount, nil
}

// GetUserIDFromToken retrieves the username or user_id from a session token
func (s *PostgresService) GetUserIDFromToken(ctx context.Context, token string, tag string) (string, error) {
	var username sql.NullString
	var userId sql.NullString
	th := hashToken(token)

	// Primary: look up by token_hash
	err := s.db.QueryRowContext(ctx,
		"SELECT username, user_id FROM sessions WHERE token_hash = $1",
		th,
	).Scan(&username, &userId)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// Fallback: try plain-text column for rows not yet backfilled
			err2 := s.db.QueryRowContext(ctx,
				"SELECT username, user_id FROM sessions WHERE session_token = $1",
				token,
			).Scan(&username, &userId)
			if err2 != nil {
				if errors.Is(err2, sql.ErrNoRows) {
					return "", fmt.Errorf("GetUserIDFromToken: no session found for token in %s", tag)
				}
				return "", fmt.Errorf("GetUserIDFromToken: error querying database in %s: %v", tag, err2)
			}
			log.Printf("WARNING: GetUserIDFromToken used plain-text fallback in %s — backfill token_hash", tag)
		} else {
			if ctx.Err() == context.Canceled {
				return "", fmt.Errorf("GetUserIDFromToken: context canceled in %s: %v", tag, err)
			}
			return "", fmt.Errorf("GetUserIDFromToken: error querying database in %s: %v", tag, err)
		}
	}

	// Prefer user_id (hash-based, survives PII wipe); fall back to username for legacy
	if userId.Valid && userId.String != "" {
		return userId.String, nil
	}
	if username.Valid && username.String != "" {
		return username.String, nil
	}
	return "", fmt.Errorf("GetUserIDFromToken: no identity found for token in %s", tag)
}

// ============================================================================
// User Operations
// ============================================================================

// CreateUser creates a new user
func (s *PostgresService) CreateUser(ctx context.Context, username, passwordHash string, poolId int) error {
	uid := hashToken(username) // user_id = SHA-256(email)
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO users (password_hash, pool_id, user_id) VALUES ($1, $2, $3)",
		passwordHash, poolId, uid,
	)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
			return errors.New("user already exists")
		}
		return fmt.Errorf("failed to create user: %w", err)
	}
	return nil
}

// GetUserPasswordHash retrieves the password hash for a user
func (s *PostgresService) GetUserPasswordHash(ctx context.Context, username string) (string, error) {
	var passwordHash string
	uid := hashToken(username)
	// user_id IN (hash, raw) covers both: raw email input (hash matches) and
	// user_id input from ValidateSession (raw matches). username fallback for legacy rows.
	err := s.db.QueryRowContext(ctx,
		"SELECT password_hash FROM users WHERE user_id IN ($1, $2) OR username = $2",
		uid, username,
	).Scan(&passwordHash)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", errors.New("invalid username: " + username)
		}
		return "", fmt.Errorf("failed to get password hash: %w", err)
	}

	return passwordHash, nil
}

// GetUserPoolID retrieves the pool ID for a user
func (s *PostgresService) GetUserPoolID(ctx context.Context, username string) (int, error) {
	var poolId int
	uid := hashToken(username)
	err := s.db.QueryRowContext(ctx,
		"SELECT pool_id FROM users WHERE user_id IN ($1, $2) OR username = $2",
		uid, username,
	).Scan(&poolId)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 1, nil
		}
		return 1, fmt.Errorf("failed to get pool ID: %w", err)
	}

	return poolId, nil
}

// ============================================================================
// Session Operations
// ============================================================================

// CreateSession creates a new session for a user
func (s *PostgresService) CreateSession(ctx context.Context, username, sessionToken string) error {
	th := hashToken(sessionToken)
	uid := hashToken(username) // user_id = SHA-256(email)
	// New entries: store hash in both session_token (for UNIQUE constraint) and token_hash.
	// No plain-text username or token stored for new entries.
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO sessions (session_token, token_hash, user_id) VALUES ($1, $1, $2)",
		th, uid,
	)
	if err != nil {
		return fmt.Errorf("failed to create session: %w", err)
	}
	return nil
}

// CreateTestSession creates or replaces a test session with a fixed token
func (s *PostgresService) CreateTestSession(ctx context.Context, username, sessionToken string) error {
	th := hashToken(sessionToken)
	// First, delete any existing session with this token
	_, _ = s.db.ExecContext(ctx,
		"DELETE FROM sessions WHERE token_hash = $1 OR session_token = $2",
		th, sessionToken,
	)

	// Test sessions keep plain-text for test tooling compatibility
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO sessions (username, session_token, token_hash) VALUES ($1, $2, $3)",
		username, sessionToken, th,
	)
	if err != nil {
		return fmt.Errorf("failed to create test session: %w", err)
	}
	return nil
}

// ValidateSession validates a session token and returns the username or user_id
func (s *PostgresService) ValidateSession(ctx context.Context, sessionToken string) (string, error) {
	var username sql.NullString
	var userId sql.NullString
	th := hashToken(sessionToken)

	// Primary: look up by token_hash
	err := s.db.QueryRowContext(ctx,
		"SELECT username, user_id FROM sessions WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > NOW())",
		th,
	).Scan(&username, &userId)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// Fallback: try plain-text column for rows not yet backfilled
			err2 := s.db.QueryRowContext(ctx,
				"SELECT username, user_id FROM sessions WHERE session_token = $1 AND (expires_at IS NULL OR expires_at > NOW())",
				sessionToken,
			).Scan(&username, &userId)
			if err2 != nil {
				if errors.Is(err2, sql.ErrNoRows) {
					return "", errors.New("invalid or expired session token")
				}
				return "", fmt.Errorf("failed to validate session: %w", err2)
			}
			log.Printf("WARNING: ValidateSession used plain-text fallback — backfill token_hash")
		} else {
			return "", fmt.Errorf("failed to validate session: %w", err)
		}
	}

	// Prefer user_id (hash-based, survives PII wipe); fall back to username for legacy
	if userId.Valid && userId.String != "" {
		return userId.String, nil
	}
	if username.Valid && username.String != "" {
		return username.String, nil
	}
	return "", errors.New("invalid session: no identity found")
}

// DeleteSession deletes a session
func (s *PostgresService) DeleteSession(ctx context.Context, sessionToken string) error {
	th := hashToken(sessionToken)
	// Delete by token_hash (primary) or session_token (fallback)
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM sessions WHERE token_hash = $1 OR session_token = $2",
		th, sessionToken,
	)
	if err != nil {
		return fmt.Errorf("failed to delete session: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return errors.New("session token not found")
	}

	return nil
}

// GetPasswordHashFromAuthToken retrieves password hash from session token
func (s *PostgresService) GetPasswordHashFromAuthToken(ctx context.Context, authToken string) (string, error) {
	username, err := s.ValidateSession(ctx, authToken)
	if err != nil {
		return "", fmt.Errorf("GetPasswordHashFromAuthToken: %w", err)
	}
	return s.GetUserPasswordHash(ctx, username)
}

// GetUserPoolFromSession retrieves pool ID from session token
func (s *PostgresService) GetUserPoolFromSession(ctx context.Context, authToken string) (int, error) {
	username, err := s.ValidateSession(ctx, authToken)
	if err != nil {
		return 1, fmt.Errorf("GetUserPoolFromSession: %w", err)
	}
	return s.GetUserPoolID(ctx, username)
}

// ============================================================================
// Login Audit Operations
// ============================================================================

// RecordLogin records a login attempt
func (s *PostgresService) RecordLogin(ctx context.Context, username, status, ipAddress, userAgent string) error {
	uid := hashToken(username)
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO logins (status, ip_address, user_agent, user_id) VALUES ($1, $2, $3, $4)",
		status, ipAddress, userAgent, uid,
	)
	if err != nil {
		return fmt.Errorf("failed to record login: %w", err)
	}
	return nil
}

// GetRecentFailedLogins gets count of recent failed logins for rate limiting
func (s *PostgresService) GetRecentFailedLogins(ctx context.Context, username string, since time.Time) (int, error) {
	var count int
	uid := hashToken(username)
	err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM logins WHERE (user_id = $1 OR username = $2) AND status = 'failed' AND created_at > $3",
		uid, username, since,
	).Scan(&count)

	if err != nil {
		return 0, fmt.Errorf("failed to get failed login count: %w", err)
	}

	return count, nil
}

// ============================================================================
// Maintenance Operations
// ============================================================================

// CleanupExpiredSessions removes expired sessions
func (s *PostgresService) CleanupExpiredSessions(ctx context.Context) (int64, error) {
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP",
	)
	if err != nil {
		return 0, fmt.Errorf("failed to cleanup sessions: %w", err)
	}

	return result.RowsAffected()
}

// CleanupOldLogins removes old login records (older than 30 days)
func (s *PostgresService) CleanupOldLogins(ctx context.Context) (int64, error) {
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM logins WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days'",
	)
	if err != nil {
		return 0, fmt.Errorf("failed to cleanup old logins: %w", err)
	}

	return result.RowsAffected()
}

// Vacuum performs database maintenance (VACUUM in PostgreSQL is automatic, but we can run ANALYZE)
func (s *PostgresService) Vacuum(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, "ANALYZE")
	return err
}

// GetStats returns database statistics
func (s *PostgresService) GetStats(ctx context.Context) (map[string]int64, error) {
	stats := make(map[string]int64)

	tables := []string{"users", "sessions", "pins", "logins"}
	for _, table := range tables {
		var count int64
		err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count)
		if err != nil {
			return nil, fmt.Errorf("failed to get count for %s: %w", table, err)
		}
		stats[table] = count
	}

	return stats, nil
}

// ============================================================================
// Admin Operations
// ============================================================================

// GetPendingPinsAdmin retrieves pins with pending status for admin batch processing
func (s *PostgresService) GetPendingPinsAdmin(ctx context.Context, after time.Time, before time.Time, username string, statusFilter string, limit int) ([]PendingPinInfo, error) {
	query := `
		SELECT requestid, cid, name, username, status, upload_status, created_at, meta
		FROM pins
		WHERE created_at > $1 AND status != 'deleted'
	`
	args := []interface{}{after}
	argNum := 2

	// Add status filter
	if statusFilter == "pending" || statusFilter == "uploaded" || statusFilter == "failed" || statusFilter == "manifest_uploaded" {
		query += fmt.Sprintf(" AND upload_status = $%d", argNum)
		args = append(args, statusFilter)
		argNum++
	} else if statusFilter == "queued" || statusFilter == "pinning" || statusFilter == "pinned" {
		query += fmt.Sprintf(" AND status = $%d", argNum)
		args = append(args, statusFilter)
		argNum++
	}

	// Optional: before time filter
	if !before.IsZero() {
		query += fmt.Sprintf(" AND created_at < $%d", argNum)
		args = append(args, before)
		argNum++
	}

	// Optional: username filter
	if username != "" {
		query += fmt.Sprintf(" AND username = $%d", argNum)
		args = append(args, username)
		argNum++
	}

	query += fmt.Sprintf(" ORDER BY created_at ASC LIMIT $%d", argNum)
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query pending pins: %w", err)
	}
	defer rows.Close()

	var pins []PendingPinInfo
	for rows.Next() {
		var pin PendingPinInfo
		var metaJSON string

		if err := rows.Scan(&pin.RequestID, &pin.CID, &pin.Name, &pin.Username, &pin.Status, &pin.UploadStatus, &pin.CreatedAt, &metaJSON); err != nil {
			continue
		}

		if metaJSON != "" {
			json.Unmarshal([]byte(metaJSON), &pin.Meta)
		}

		pins = append(pins, pin)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating pending pins: %w", err)
	}

	return pins, nil
}

// BatchUpdatePinStatusByCID updates the status of multiple pins by CID
func (s *PostgresService) BatchUpdatePinStatusByCID(ctx context.Context, updates []PinStatusUpdateDB) (int, int, []string) {
	updated := 0
	failed := 0
	var errors []string

	// Use a transaction for better performance
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, len(updates), []string{"Failed to begin transaction: " + err.Error()}
	}
	defer tx.Rollback()

	for _, update := range updates {
		var query string
		var args []interface{}

		if update.Status != "" && update.UploadStatus != "" {
			query = "UPDATE pins SET status = $1, upload_status = $2 WHERE cid = $3 AND status != 'deleted'"
			args = []interface{}{update.Status, update.UploadStatus, update.CID}
		} else if update.Status != "" {
			query = "UPDATE pins SET status = $1 WHERE cid = $2 AND status != 'deleted'"
			args = []interface{}{update.Status, update.CID}
		} else if update.UploadStatus != "" {
			query = "UPDATE pins SET upload_status = $1 WHERE cid = $2 AND status != 'deleted'"
			args = []interface{}{update.UploadStatus, update.CID}
		} else {
			failed++
			errors = append(errors, "No status provided for CID: "+update.CID)
			continue
		}

		result, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			failed++
			errors = append(errors, "Failed to update CID "+update.CID+": "+err.Error())
			continue
		}

		rowsAffected, _ := result.RowsAffected()
		if rowsAffected > 0 {
			updated += int(rowsAffected)
		} else {
			failed++
			errors = append(errors, "No pins found for CID: "+update.CID)
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, len(updates), []string{"Failed to commit transaction: " + err.Error()}
	}

	return updated, failed, errors
}

// GetPinCountsByStatus returns pin counts grouped by status
func (s *PostgresService) GetPinCountsByStatus(ctx context.Context) (map[string]int64, error) {
	query := `
		SELECT status, COUNT(*) as count
		FROM pins
		WHERE status != 'deleted'
		GROUP BY status
	`

	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query pin counts: %w", err)
	}
	defer rows.Close()

	counts := make(map[string]int64)
	for rows.Next() {
		var status string
		var count int64
		if err := rows.Scan(&status, &count); err != nil {
			continue
		}
		counts[status] = count
	}

	// Also get upload_status counts
	uploadQuery := `
		SELECT upload_status, COUNT(*) as count
		FROM pins
		WHERE status != 'deleted'
		GROUP BY upload_status
	`

	uploadRows, err := s.db.QueryContext(ctx, uploadQuery)
	if err != nil {
		return counts, nil
	}
	defer uploadRows.Close()

	for uploadRows.Next() {
		var status string
		var count int64
		if err := uploadRows.Scan(&status, &count); err != nil {
			continue
		}
		counts["upload_"+status] = count
	}

	return counts, nil
}

// ============================================================================
// Storage Tracking Operations
// ============================================================================

// UpdatePinSize updates the size of a pin by request ID
func (s *PostgresService) UpdatePinSize(ctx context.Context, requestID string, size int64) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx,
		"UPDATE pins SET size = $1 WHERE requestid = $2",
		size, requestID,
	)
	if err != nil {
		return fmt.Errorf("failed to update pin size: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return errors.New("pin not found")
	}

	return nil
}

// UpdatePinSizeByCID updates the size of all pins with a given CID
func (s *PostgresService) UpdatePinSizeByCID(ctx context.Context, cid string, size int64) error {
	if cid == "" {
		return errors.New("cid cannot be empty")
	}

	_, err := s.db.ExecContext(ctx,
		"UPDATE pins SET size = $1 WHERE cid = $2 AND status != 'deleted'",
		size, cid,
	)
	if err != nil {
		return fmt.Errorf("failed to update pin size by CID: %w", err)
	}

	return nil
}

// UpdatePinStatusAndSize updates both status and size of a pin by request ID
func (s *PostgresService) UpdatePinStatusAndSize(ctx context.Context, requestID string, status string, size int64) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	var err error
	if size > 0 {
		_, err = s.db.ExecContext(ctx,
			"UPDATE pins SET status = $1, size = $2, updated_at = CURRENT_TIMESTAMP WHERE requestid = $3",
			status, size, requestID,
		)
	} else {
		_, err = s.db.ExecContext(ctx,
			"UPDATE pins SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE requestid = $2",
			status, requestID,
		)
	}

	if err != nil {
		return fmt.Errorf("failed to update pin status and size: %w", err)
	}

	return nil
}

// GetStorageBySessionToken returns total storage used by a specific session token
func (s *PostgresService) GetStorageBySessionToken(ctx context.Context, sessionToken string) (StorageUsage, error) {
	if sessionToken == "" {
		return StorageUsage{}, errors.New("sessionToken cannot be empty")
	}

	th := hashToken(sessionToken)
	query := `
		SELECT COALESCE(SUM(size), 0) as total_size, COUNT(*) as pin_count
		FROM pins
		WHERE (token_hash = $1 OR session_token = $2) AND status != 'deleted'
	`

	var usage StorageUsage
	err := s.db.QueryRowContext(ctx, query, th, sessionToken).Scan(&usage.TotalSize, &usage.PinCount)
	if err != nil {
		return StorageUsage{}, fmt.Errorf("failed to get storage by session token: %w", err)
	}

	usage.Identifier = sessionToken
	return usage, nil
}

// GetStorageByUser returns total storage used by a user
func (s *PostgresService) GetStorageByUser(ctx context.Context, username string) (StorageUsage, error) {
	if username == "" {
		return StorageUsage{}, errors.New("username cannot be empty")
	}

	uid := hashToken(username)
	query := `
		SELECT COALESCE(SUM(size), 0) as total_size, COUNT(*) as pin_count
		FROM pins
		WHERE (user_id = $1 OR username = $2) AND status != 'deleted'
	`

	var usage StorageUsage
	err := s.db.QueryRowContext(ctx, query, uid, username).Scan(&usage.TotalSize, &usage.PinCount)
	if err != nil {
		return StorageUsage{}, fmt.Errorf("failed to get storage by user: %w", err)
	}

	usage.Identifier = username
	return usage, nil
}

// GetStorageByUserSessions returns storage breakdown per session token for a user
func (s *PostgresService) GetStorageByUserSessions(ctx context.Context, username string) ([]StorageUsage, error) {
	if username == "" {
		return nil, errors.New("username cannot be empty")
	}

	uid := hashToken(username)
	query := `
		SELECT COALESCE(token_hash, session_token), COALESCE(SUM(size), 0) as total_size, COUNT(*) as pin_count
		FROM pins
		WHERE (user_id = $1 OR username = $2) AND status != 'deleted' AND session_token != ''
		GROUP BY COALESCE(token_hash, session_token)
		ORDER BY total_size DESC
	`

	rows, err := s.db.QueryContext(ctx, query, uid, username)
	if err != nil {
		return nil, fmt.Errorf("failed to get storage by user sessions: %w", err)
	}
	defer rows.Close()

	var usages []StorageUsage
	for rows.Next() {
		var usage StorageUsage
		if err := rows.Scan(&usage.Identifier, &usage.TotalSize, &usage.PinCount); err != nil {
			continue
		}
		usages = append(usages, usage)
	}

	return usages, nil
}

// GetTotalStorageStats returns overall storage statistics
func (s *PostgresService) GetTotalStorageStats(ctx context.Context) (map[string]int64, error) {
	stats := make(map[string]int64)

	var totalSize int64
	err := s.db.QueryRowContext(ctx, "SELECT COALESCE(SUM(size), 0) FROM pins WHERE status != 'deleted'").Scan(&totalSize)
	if err != nil {
		return nil, fmt.Errorf("failed to get total storage: %w", err)
	}
	stats["total_size"] = totalSize

	var pinsWithSize int64
	err = s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM pins WHERE status != 'deleted' AND size > 0").Scan(&pinsWithSize)
	if err != nil {
		return nil, fmt.Errorf("failed to get pins with size: %w", err)
	}
	stats["pins_with_size"] = pinsWithSize

	var usersWithStorage int64
	err = s.db.QueryRowContext(ctx, "SELECT COUNT(DISTINCT username) FROM pins WHERE status != 'deleted' AND size > 0").Scan(&usersWithStorage)
	if err != nil {
		return nil, fmt.Errorf("failed to get users with storage: %w", err)
	}
	stats["users_with_storage"] = usersWithStorage

	return stats, nil
}

// GetPinsNeedingSizeRecalc returns pins that may need size recalculation
func (s *PostgresService) GetPinsNeedingSizeRecalc(ctx context.Context, limit int, includeAll bool) ([]PinForRecalc, error) {
	var query string
	if includeAll {
		query = `
			SELECT requestid, cid, username, size, status
			FROM pins
			WHERE status IN ('pinned', 'pinning')
			ORDER BY size ASC, created_at DESC
			LIMIT $1
		`
	} else {
		query = `
			SELECT requestid, cid, username, size, status
			FROM pins
			WHERE status IN ('pinned', 'pinning') AND size = 0
			ORDER BY created_at DESC
			LIMIT $1
		`
	}

	rows, err := s.db.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query pins: %w", err)
	}
	defer rows.Close()

	var pins []PinForRecalc
	for rows.Next() {
		var p PinForRecalc
		if err := rows.Scan(&p.RequestID, &p.CID, &p.Username, &p.CurrentSize, &p.Status); err != nil {
			return nil, fmt.Errorf("failed to scan pin: %w", err)
		}
		pins = append(pins, p)
	}

	return pins, nil
}

// ============================================================================
// Credit/Quota Operations
// ============================================================================

// GetCreditStatus checks if a user can upload based on their storage usage and credit balance
func (s *PostgresService) GetCreditStatus(ctx context.Context, username string) (CreditStatus, error) {
	if username == "" {
		return CreditStatus{}, errors.New("username cannot be empty")
	}

	// Get current storage usage
	usage, err := s.GetStorageByUser(ctx, username)
	if err != nil {
		return CreditStatus{
			CanUpload:     true,
			FreeTierBytes: DefaultFreeTierBytes,
			Message:       "Storage check unavailable, allowing upload",
		}, nil
	}

	// Get user credit info
	var balanceFula float64
	var isSuspended int
	freeTierBytes := DefaultFreeTierBytes

	uid := hashToken(username)
	err = s.db.QueryRowContext(ctx, `
		SELECT COALESCE(balance_fula, 0), COALESCE(is_suspended, 0)
		FROM user_credits
		WHERE user_id = $1 OR user_email = $2
	`, uid, username).Scan(&balanceFula, &isSuspended)

	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return CreditStatus{
			CanUpload:     true,
			CurrentBytes:  usage.TotalSize,
			FreeTierBytes: freeTierBytes,
			Message:       "Credit check unavailable, allowing upload",
		}, nil
	}

	status := CreditStatus{
		CurrentBytes:  usage.TotalSize,
		FreeTierBytes: freeTierBytes,
		BalanceFula:   balanceFula,
		IsSuspended:   isSuspended == 1,
	}

	// Free tier users are ALWAYS allowed
	if usage.TotalSize < freeTierBytes {
		status.CanUpload = true
		usedMB := usage.TotalSize / (1024 * 1024)
		freeMB := freeTierBytes / (1024 * 1024)
		status.Message = fmt.Sprintf("Using free tier: %d/%d MB", usedMB, freeMB)
		return status, nil
	}

	// Over free tier - check if suspended
	if status.IsSuspended {
		status.CanUpload = false
		status.Message = "Account suspended. Please add FULA credits to continue."
		return status, nil
	}

	// Over free tier - check credit balance
	if balanceFula <= 0 {
		status.CanUpload = false
		status.Message = "Free tier exceeded. Please add FULA credits to continue."
		return status, nil
	}

	// Has credits - allow upload
	status.CanUpload = true
	status.Message = fmt.Sprintf("Using paid storage. Balance: %.2f FULA", balanceFula)
	return status, nil
}

// GetUserCredits returns credit information for a user
func (s *PostgresService) GetUserCredits(ctx context.Context, username string) (map[string]interface{}, error) {
	if username == "" {
		return nil, errors.New("username cannot be empty")
	}

	var balanceFula, totalDeposited, totalDeducted float64
	var isSuspended int
	var lastDeductionAt, suspendedAt, createdAt, updatedAt sql.NullTime

	uid2 := hashToken(username)
	err := s.db.QueryRowContext(ctx, `
		SELECT balance_fula, total_deposited_fula, total_deducted_fula,
		       is_suspended, last_deduction_at, suspended_at, created_at, updated_at
		FROM user_credits
		WHERE user_id = $1 OR user_email = $2
	`, uid2, username).Scan(&balanceFula, &totalDeposited, &totalDeducted,
		&isSuspended, &lastDeductionAt, &suspendedAt, &createdAt, &updatedAt)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return map[string]interface{}{
				"balance_fula":      0.0,
				"total_deposited":   0.0,
				"total_deducted":    0.0,
				"is_suspended":      false,
				"last_deduction_at": nil,
				"free_tier_bytes":   DefaultFreeTierBytes,
			}, nil
		}
		return nil, fmt.Errorf("failed to get user credits: %w", err)
	}

	result := map[string]interface{}{
		"balance_fula":    balanceFula,
		"total_deposited": totalDeposited,
		"total_deducted":  totalDeducted,
		"is_suspended":    isSuspended == 1,
		"free_tier_bytes": DefaultFreeTierBytes,
	}

	if lastDeductionAt.Valid {
		result["last_deduction_at"] = lastDeductionAt.Time
	}
	if suspendedAt.Valid {
		result["suspended_at"] = suspendedAt.Time
	}

	return result, nil
}
