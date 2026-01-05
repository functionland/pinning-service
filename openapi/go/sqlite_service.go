package openapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// SQLiteService provides database operations using SQLite
type SQLiteService struct {
	db   *sql.DB
	mu   sync.RWMutex
	path string
}

// NewSQLiteService creates a new SQLite service with optimized settings
func NewSQLiteService(dbPath string) (*SQLiteService, error) {
	// Open database with optimized connection string
	db, err := sql.Open("sqlite", dbPath+"?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=5000&_cache_size=-20000")
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Configure connection pool for better concurrency
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(1 * time.Minute)

	service := &SQLiteService{
		db:   db,
		path: dbPath,
	}

	// Initialize database schema
	if err := service.initSchema(); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to initialize schema: %w", err)
	}

	return service, nil
}

// initSchema creates all required tables with optimized indexes
func (s *SQLiteService) initSchema() error {
	schema := `
	-- Users table
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		pool_id INTEGER DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

	-- Sessions table
	CREATE TABLE IF NOT EXISTS sessions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL,
		session_token TEXT NOT NULL UNIQUE,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		expires_at DATETIME,
		FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
	CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
	CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

	-- Pins table with optimized schema
	CREATE TABLE IF NOT EXISTS pins (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		requestid TEXT NOT NULL UNIQUE,
		username TEXT NOT NULL,
		cid TEXT NOT NULL,
		name TEXT DEFAULT '',
		name_lowercase TEXT DEFAULT '',
		origins TEXT DEFAULT '[]',
		meta TEXT DEFAULT '{}',
		status TEXT DEFAULT 'queued' CHECK(status IN ('queued', 'pinning', 'pinned', 'failed', 'deleted')),
		upload_status TEXT DEFAULT 'pending',
		remove_status TEXT DEFAULT NULL,
		delegates TEXT DEFAULT '[]',
		info TEXT DEFAULT '{}',
		size INTEGER DEFAULT 0,
		session_token TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_pins_requestid ON pins(requestid);
	CREATE INDEX IF NOT EXISTS idx_pins_username ON pins(username);
	CREATE INDEX IF NOT EXISTS idx_pins_cid ON pins(cid);
	CREATE INDEX IF NOT EXISTS idx_pins_status ON pins(status);
	CREATE INDEX IF NOT EXISTS idx_pins_name ON pins(name);
	CREATE INDEX IF NOT EXISTS idx_pins_name_lower ON pins(name_lowercase);
	CREATE INDEX IF NOT EXISTS idx_pins_created ON pins(created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_pins_username_status ON pins(username, status);
	CREATE INDEX IF NOT EXISTS idx_pins_username_created ON pins(username, created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_pins_session_token ON pins(session_token);

	-- Add columns to existing table if they don't exist (for upgrades)
	-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we handle this in code

	-- Logins audit table (for tracking login attempts)
	CREATE TABLE IF NOT EXISTS logins (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL,
		status TEXT DEFAULT 'success' CHECK(status IN ('success', 'failed', 'locked')),
		ip_address TEXT,
		user_agent TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE INDEX IF NOT EXISTS idx_logins_username ON logins(username);
	CREATE INDEX IF NOT EXISTS idx_logins_created ON logins(created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_logins_status ON logins(status);

	-- Trigger to update updated_at on pins
	CREATE TRIGGER IF NOT EXISTS pins_updated_at 
	AFTER UPDATE ON pins
	BEGIN
		UPDATE pins SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
	END;

	-- Trigger to update updated_at on users
	CREATE TRIGGER IF NOT EXISTS users_updated_at 
	AFTER UPDATE ON users
	BEGIN
		UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
	END;
	`

	_, err := s.db.Exec(schema)
	if err != nil {
		return err
	}

	// Run migrations for existing databases
	if err := s.runMigrations(); err != nil {
		return fmt.Errorf("failed to run migrations: %w", err)
	}

	return nil
}

// runMigrations adds new columns to existing tables (for upgrades)
func (s *SQLiteService) runMigrations() error {
	// Check if size column exists in pins table
	var count int
	err := s.db.QueryRow("SELECT COUNT(*) FROM pragma_table_info('pins') WHERE name='size'").Scan(&count)
	if err != nil {
		return err
	}
	if count == 0 {
		_, err = s.db.Exec("ALTER TABLE pins ADD COLUMN size INTEGER DEFAULT 0")
		if err != nil {
			return fmt.Errorf("failed to add size column: %w", err)
		}
	}

	// Check if session_token column exists in pins table
	err = s.db.QueryRow("SELECT COUNT(*) FROM pragma_table_info('pins') WHERE name='session_token'").Scan(&count)
	if err != nil {
		return err
	}
	if count == 0 {
		_, err = s.db.Exec("ALTER TABLE pins ADD COLUMN session_token TEXT DEFAULT ''")
		if err != nil {
			return fmt.Errorf("failed to add session_token column: %w", err)
		}
		// Create index for session_token
		_, _ = s.db.Exec("CREATE INDEX IF NOT EXISTS idx_pins_session_token ON pins(session_token)")
	}

	return nil
}

// Close closes the database connection
func (s *SQLiteService) Close() error {
	return s.db.Close()
}

// GetDB returns the underlying database connection for advanced use
func (s *SQLiteService) GetDB() *sql.DB {
	return s.db
}

// ============================================================================
// Pin Operations
// ============================================================================

// AddPin adds a new pin to the database
func (s *SQLiteService) AddPin(ctx context.Context, username string, pin Pin, uploadStatus string) (string, error) {
	return s.AddPinWithSize(ctx, username, pin, uploadStatus, 0, "")
}

// AddPinWithSize adds a new pin to the database with size and session tracking
func (s *SQLiteService) AddPinWithSize(ctx context.Context, username string, pin Pin, uploadStatus string, size int64, sessionToken string) (string, error) {
	requestId := generateRequestID(pin)

	originsJSON, err := json.Marshal(pin.Origins)
	if err != nil {
		originsJSON = []byte("[]")
	}

	metaJSON, err := json.Marshal(pin.Meta)
	if err != nil {
		metaJSON = []byte("{}")
	}

	// Use Go's time.Now() for high-precision timestamps (nanoseconds)
	// SQLite's CURRENT_TIMESTAMP only has second precision which breaks pagination
	createdAt := time.Now().UTC()

	query := `
		INSERT INTO pins (requestid, username, cid, name, name_lowercase, origins, meta, status, upload_status, size, session_token, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
	`

	_, err = s.db.ExecContext(ctx, query,
		requestId,
		username,
		pin.Cid,
		pin.Name,
		strings.ToLower(pin.Name),
		string(originsJSON),
		string(metaJSON),
		uploadStatus,
		size,
		sessionToken,
		createdAt,
	)
	if err != nil {
		return "", fmt.Errorf("failed to add pin: %w", err)
	}

	return requestId, nil
}

// DeletePin permanently removes a pin from the database
func (s *SQLiteService) DeletePin(ctx context.Context, requestID string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx, "DELETE FROM pins WHERE requestid = ?", requestID)
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
func (s *SQLiteService) MarkPinAsDeleted(ctx context.Context, requestID string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx,
		"UPDATE pins SET status = 'deleted', remove_status = 'pending' WHERE requestid = ?",
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
func (s *SQLiteService) MarkPinAsDeleteFailed(ctx context.Context, requestID string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx,
		"UPDATE pins SET status = 'deleted', remove_status = 'failed' WHERE requestid = ?",
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
func (s *SQLiteService) UpdatePinStatus(ctx context.Context, requestID, status string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx,
		"UPDATE pins SET upload_status = ? WHERE requestid = ?",
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
func (s *SQLiteService) UpdatePinPinningStatus(ctx context.Context, requestID, status string) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx,
		"UPDATE pins SET status = ? WHERE requestid = ?",
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
// Returns nil if no existing pin is found
func (s *SQLiteService) GetExistingPinByCID(ctx context.Context, username, cid string) (*PinStatus, error) {
	if username == "" || cid == "" {
		return nil, nil
	}

	query := `
		SELECT requestid, cid, name, origins, meta, status, delegates, info, created_at
		FROM pins
		WHERE username = ? AND cid = ? AND status != 'deleted'
		ORDER BY created_at DESC
		LIMIT 1
	`

	var (
		reqID, cidVal, name, status string
		originsJSON, metaJSON       string
		delegatesJSON, infoJSON     string
		createdAt                   time.Time
	)

	err := s.db.QueryRowContext(ctx, query, username, cid).Scan(
		&reqID, &cidVal, &name, &originsJSON, &metaJSON,
		&status, &delegatesJSON, &infoJSON, &createdAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil // No existing pin found
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

// GetPinByRequestID retrieves a pin by its request ID
func (s *SQLiteService) GetPinByRequestID(ctx context.Context, requestID string) (PinStatus, string, error) {
	if requestID == "" {
		return PinStatus{}, "", errors.New("requestID cannot be empty")
	}

	query := `
		SELECT requestid, username, cid, name, origins, meta, status, delegates, info, created_at
		FROM pins
		WHERE requestid = ? AND status != 'deleted'
	`

	var (
		reqID, username, cid, name, status string
		originsJSON, metaJSON              string
		delegatesJSON, infoJSON            string
		createdAt                          time.Time
	)

	err := s.db.QueryRowContext(ctx, query, requestID).Scan(
		&reqID, &username, &cid, &name, &originsJSON, &metaJSON,
		&status, &delegatesJSON, &infoJSON, &createdAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return PinStatus{}, "", errors.New("pin not found")
		}
		return PinStatus{}, "", fmt.Errorf("failed to query pin: %w", err)
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

	return pinStatus, username, nil
}

// GetPins retrieves pins with filtering options
func (s *SQLiteService) GetPins(ctx context.Context, username string, cid []string, name string, match TextMatchingStrategy, statuses []Status, before time.Time, after time.Time, limit int, metaFilter map[string]string) ([]PinWithRequest, int, error) {
	if username == "" {
		return nil, 0, errors.New("username cannot be empty")
	}

	// Build WHERE clause (shared between count and select queries)
	whereClause := "username = ? AND status != 'deleted'"
	whereArgs := []interface{}{username}

	// CID filter
	if len(cid) > 0 {
		placeholders := make([]string, len(cid))
		for i, c := range cid {
			placeholders[i] = "?"
			whereArgs = append(whereArgs, c)
		}
		whereClause += " AND cid IN (" + strings.Join(placeholders, ",") + ")"
	}

	// Name filter
	if name != "" {
		switch match {
		case "exact", "":
			whereClause += " AND name = ?"
			whereArgs = append(whereArgs, name)
		case "iexact":
			whereClause += " AND name_lowercase = ?"
			whereArgs = append(whereArgs, strings.ToLower(name))
		case "partial":
			whereClause += " AND name LIKE ?"
			whereArgs = append(whereArgs, "%"+name+"%")
		case "ipartial":
			whereClause += " AND name_lowercase LIKE ?"
			whereArgs = append(whereArgs, "%"+strings.ToLower(name)+"%")
		}
	}

	// Status filter
	if len(statuses) > 0 {
		placeholders := make([]string, len(statuses))
		for i, st := range statuses {
			placeholders[i] = "?"
			whereArgs = append(whereArgs, string(st))
		}
		whereClause += " AND status IN (" + strings.Join(placeholders, ",") + ")"
	}

	// Time filters - NOTE: for count, we don't apply before/after to get TRUE total
	// But the spec says "total number of pin objects that exist for passed query filters"
	// So we need to include time filters in count too
	if !before.IsZero() {
		whereClause += " AND created_at < ?"
		whereArgs = append(whereArgs, before)
	}
	if !after.IsZero() {
		whereClause += " AND created_at > ?"
		whereArgs = append(whereArgs, after)
	}

	// Get total count FIRST (without LIMIT) - this is required by the spec
	countQuery := "SELECT COUNT(*) FROM pins WHERE " + whereClause
	var totalCount int
	if err := s.db.QueryRowContext(ctx, countQuery, whereArgs...).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("failed to count pins: %w", err)
	}

	// Now build select query with ORDER and LIMIT
	if limit <= 0 {
		limit = 10
	}
	if limit > 1000 {
		limit = 1000
	}

	selectQuery := "SELECT requestid, cid, name, origins, meta, status, created_at FROM pins WHERE " + whereClause + " ORDER BY created_at DESC LIMIT ?"
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

// GetUserIDFromToken retrieves the username from a session token
func (s *SQLiteService) GetUserIDFromToken(ctx context.Context, token string, tag string) (string, error) {
	var username string
	err := s.db.QueryRowContext(ctx,
		"SELECT username FROM sessions WHERE session_token = ?",
		token,
	).Scan(&username)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", fmt.Errorf("GetUserIDFromToken: no session found for token in %s", tag)
		}
		if ctx.Err() == context.Canceled {
			return "", fmt.Errorf("GetUserIDFromToken: context canceled in %s: %v", tag, err)
		}
		return "", fmt.Errorf("GetUserIDFromToken: error querying database in %s: %v", tag, err)
	}

	return username, nil
}

// ============================================================================
// User Operations
// ============================================================================

// CreateUser creates a new user
func (s *SQLiteService) CreateUser(ctx context.Context, username, passwordHash string, poolId int) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO users (username, password_hash, pool_id) VALUES (?, ?, ?)",
		username, passwordHash, poolId,
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return errors.New("user already exists")
		}
		return fmt.Errorf("failed to create user: %w", err)
	}
	return nil
}

// GetUserPasswordHash retrieves the password hash for a user
func (s *SQLiteService) GetUserPasswordHash(ctx context.Context, username string) (string, error) {
	var passwordHash string
	err := s.db.QueryRowContext(ctx,
		"SELECT password_hash FROM users WHERE username = ?",
		username,
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
func (s *SQLiteService) GetUserPoolID(ctx context.Context, username string) (int, error) {
	var poolId int
	err := s.db.QueryRowContext(ctx,
		"SELECT pool_id FROM users WHERE username = ?",
		username,
	).Scan(&poolId)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 1, nil // Default pool ID
		}
		return 1, fmt.Errorf("failed to get pool ID: %w", err)
	}

	return poolId, nil
}

// ============================================================================
// Session Operations
// ============================================================================

// CreateSession creates a new session for a user
func (s *SQLiteService) CreateSession(ctx context.Context, username, sessionToken string) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO sessions (username, session_token) VALUES (?, ?)",
		username, sessionToken,
	)
	if err != nil {
		return fmt.Errorf("failed to create session: %w", err)
	}
	return nil
}

// CreateTestSession creates or replaces a test session with a fixed token (for compliance testing)
func (s *SQLiteService) CreateTestSession(ctx context.Context, username, sessionToken string) error {
	// First, delete any existing session with this token
	_, _ = s.db.ExecContext(ctx,
		"DELETE FROM sessions WHERE session_token = ?",
		sessionToken,
	)

	// Create the test session
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO sessions (username, session_token) VALUES (?, ?)",
		username, sessionToken,
	)
	if err != nil {
		return fmt.Errorf("failed to create test session: %w", err)
	}
	return nil
}

// ValidateSession validates a session token and returns the username
func (s *SQLiteService) ValidateSession(ctx context.Context, sessionToken string) (string, error) {
	var username string
	err := s.db.QueryRowContext(ctx,
		"SELECT username FROM sessions WHERE session_token = ?",
		sessionToken,
	).Scan(&username)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", errors.New("invalid or expired session token")
		}
		return "", fmt.Errorf("failed to validate session: %w", err)
	}

	return username, nil
}

// DeleteSession deletes a session
func (s *SQLiteService) DeleteSession(ctx context.Context, sessionToken string) error {
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM sessions WHERE session_token = ?",
		sessionToken,
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
func (s *SQLiteService) GetPasswordHashFromAuthToken(ctx context.Context, authToken string) (string, error) {
	username, err := s.ValidateSession(ctx, authToken)
	if err != nil {
		return "", fmt.Errorf("GetPasswordHashFromAuthToken: %w", err)
	}
	return s.GetUserPasswordHash(ctx, username)
}

// GetUserPoolFromSession retrieves pool ID from session token
func (s *SQLiteService) GetUserPoolFromSession(ctx context.Context, authToken string) (int, error) {
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
func (s *SQLiteService) RecordLogin(ctx context.Context, username, status, ipAddress, userAgent string) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO logins (username, status, ip_address, user_agent) VALUES (?, ?, ?, ?)",
		username, status, ipAddress, userAgent,
	)
	if err != nil {
		return fmt.Errorf("failed to record login: %w", err)
	}
	return nil
}

// GetRecentFailedLogins gets count of recent failed logins for rate limiting
func (s *SQLiteService) GetRecentFailedLogins(ctx context.Context, username string, since time.Time) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM logins WHERE username = ? AND status = 'failed' AND created_at > ?",
		username, since,
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
func (s *SQLiteService) CleanupExpiredSessions(ctx context.Context) (int64, error) {
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP",
	)
	if err != nil {
		return 0, fmt.Errorf("failed to cleanup sessions: %w", err)
	}

	return result.RowsAffected()
}

// CleanupOldLogins removes old login records (older than 30 days)
func (s *SQLiteService) CleanupOldLogins(ctx context.Context) (int64, error) {
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM logins WHERE created_at < datetime('now', '-30 days')",
	)
	if err != nil {
		return 0, fmt.Errorf("failed to cleanup old logins: %w", err)
	}

	return result.RowsAffected()
}

// Vacuum performs database maintenance
func (s *SQLiteService) Vacuum(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, "VACUUM")
	return err
}

// GetStats returns database statistics
func (s *SQLiteService) GetStats(ctx context.Context) (map[string]int64, error) {
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

// PendingPinInfo represents a pending pin for admin queries
type PendingPinInfo struct {
	RequestID    string
	CID          string
	Name         string
	Username     string
	Status       string
	UploadStatus string
	CreatedAt    time.Time
	Meta         map[string]string
}

// GetPendingPinsAdmin retrieves pins with pending status for admin batch processing
func (s *SQLiteService) GetPendingPinsAdmin(ctx context.Context, after time.Time, before time.Time, username string, statusFilter string, limit int) ([]PendingPinInfo, error) {
	query := `
		SELECT requestid, cid, name, username, status, upload_status, created_at, meta
		FROM pins
		WHERE created_at > ? AND status != 'deleted'
	`
	args := []interface{}{after}

	// Add status filter
	if statusFilter == "pending" || statusFilter == "uploaded" || statusFilter == "failed" || statusFilter == "manifest_uploaded" {
		query += " AND upload_status = ?"
		args = append(args, statusFilter)
	} else if statusFilter == "queued" || statusFilter == "pinning" || statusFilter == "pinned" {
		query += " AND status = ?"
		args = append(args, statusFilter)
	}

	// Optional: before time filter
	if !before.IsZero() {
		query += " AND created_at < ?"
		args = append(args, before)
	}

	// Optional: username filter
	if username != "" {
		query += " AND username = ?"
		args = append(args, username)
	}

	query += " ORDER BY created_at ASC LIMIT ?"
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

// PinStatusUpdate represents a status update for a CID
type PinStatusUpdateDB struct {
	CID          string
	Status       string
	UploadStatus string
}

// BatchUpdatePinStatusByCID updates the status of multiple pins by CID
func (s *SQLiteService) BatchUpdatePinStatusByCID(ctx context.Context, updates []PinStatusUpdateDB) (int, int, []string) {
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
			query = "UPDATE pins SET status = ?, upload_status = ? WHERE cid = ? AND status != 'deleted'"
			args = []interface{}{update.Status, update.UploadStatus, update.CID}
		} else if update.Status != "" {
			query = "UPDATE pins SET status = ? WHERE cid = ? AND status != 'deleted'"
			args = []interface{}{update.Status, update.CID}
		} else if update.UploadStatus != "" {
			query = "UPDATE pins SET upload_status = ? WHERE cid = ? AND status != 'deleted'"
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
func (s *SQLiteService) GetPinCountsByStatus(ctx context.Context) (map[string]int64, error) {
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
		return counts, nil // Return what we have
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
func (s *SQLiteService) UpdatePinSize(ctx context.Context, requestID string, size int64) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	result, err := s.db.ExecContext(ctx,
		"UPDATE pins SET size = ? WHERE requestid = ?",
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
func (s *SQLiteService) UpdatePinSizeByCID(ctx context.Context, cid string, size int64) error {
	if cid == "" {
		return errors.New("cid cannot be empty")
	}

	_, err := s.db.ExecContext(ctx,
		"UPDATE pins SET size = ? WHERE cid = ? AND status != 'deleted'",
		size, cid,
	)
	if err != nil {
		return fmt.Errorf("failed to update pin size by CID: %w", err)
	}

	return nil
}

// UpdatePinStatusAndSize updates both status and size of a pin by request ID
func (s *SQLiteService) UpdatePinStatusAndSize(ctx context.Context, requestID string, status string, size int64) error {
	if requestID == "" {
		return errors.New("requestID cannot be empty")
	}

	// Only update size if it's greater than 0
	var err error
	if size > 0 {
		_, err = s.db.ExecContext(ctx,
			"UPDATE pins SET status = ?, size = ?, updated_at = CURRENT_TIMESTAMP WHERE requestid = ?",
			status, size, requestID,
		)
	} else {
		_, err = s.db.ExecContext(ctx,
			"UPDATE pins SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE requestid = ?",
			status, requestID,
		)
	}

	if err != nil {
		return fmt.Errorf("failed to update pin status and size: %w", err)
	}

	return nil
}

// StorageUsage represents storage usage statistics
type StorageUsage struct {
	TotalSize  int64  `json:"total_size"`
	PinCount   int64  `json:"pin_count"`
	Identifier string `json:"identifier,omitempty"` // session_token or username
}

// GetStorageBySessionToken returns total storage used by a specific session token (API key)
func (s *SQLiteService) GetStorageBySessionToken(ctx context.Context, sessionToken string) (StorageUsage, error) {
	if sessionToken == "" {
		return StorageUsage{}, errors.New("sessionToken cannot be empty")
	}

	query := `
		SELECT COALESCE(SUM(size), 0) as total_size, COUNT(*) as pin_count
		FROM pins
		WHERE session_token = ? AND status != 'deleted'
	`

	var usage StorageUsage
	err := s.db.QueryRowContext(ctx, query, sessionToken).Scan(&usage.TotalSize, &usage.PinCount)
	if err != nil {
		return StorageUsage{}, fmt.Errorf("failed to get storage by session token: %w", err)
	}

	usage.Identifier = sessionToken
	return usage, nil
}

// GetStorageByUser returns total storage used by a user (across all their sessions/API keys)
func (s *SQLiteService) GetStorageByUser(ctx context.Context, username string) (StorageUsage, error) {
	if username == "" {
		return StorageUsage{}, errors.New("username cannot be empty")
	}

	query := `
		SELECT COALESCE(SUM(size), 0) as total_size, COUNT(*) as pin_count
		FROM pins
		WHERE username = ? AND status != 'deleted'
	`

	var usage StorageUsage
	err := s.db.QueryRowContext(ctx, query, username).Scan(&usage.TotalSize, &usage.PinCount)
	if err != nil {
		return StorageUsage{}, fmt.Errorf("failed to get storage by user: %w", err)
	}

	usage.Identifier = username
	return usage, nil
}

// GetStorageByUserSessions returns storage breakdown per session token for a user
func (s *SQLiteService) GetStorageByUserSessions(ctx context.Context, username string) ([]StorageUsage, error) {
	if username == "" {
		return nil, errors.New("username cannot be empty")
	}

	query := `
		SELECT session_token, COALESCE(SUM(size), 0) as total_size, COUNT(*) as pin_count
		FROM pins
		WHERE username = ? AND status != 'deleted' AND session_token != ''
		GROUP BY session_token
		ORDER BY total_size DESC
	`

	rows, err := s.db.QueryContext(ctx, query, username)
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
func (s *SQLiteService) GetTotalStorageStats(ctx context.Context) (map[string]int64, error) {
	stats := make(map[string]int64)

	// Total storage
	var totalSize int64
	err := s.db.QueryRowContext(ctx, "SELECT COALESCE(SUM(size), 0) FROM pins WHERE status != 'deleted'").Scan(&totalSize)
	if err != nil {
		return nil, fmt.Errorf("failed to get total storage: %w", err)
	}
	stats["total_size"] = totalSize

	// Total pins with size > 0
	var pinsWithSize int64
	err = s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM pins WHERE status != 'deleted' AND size > 0").Scan(&pinsWithSize)
	if err != nil {
		return nil, fmt.Errorf("failed to get pins with size: %w", err)
	}
	stats["pins_with_size"] = pinsWithSize

	// Unique users with storage
	var usersWithStorage int64
	err = s.db.QueryRowContext(ctx, "SELECT COUNT(DISTINCT username) FROM pins WHERE status != 'deleted' AND size > 0").Scan(&usersWithStorage)
	if err != nil {
		return nil, fmt.Errorf("failed to get users with storage: %w", err)
	}
	stats["users_with_storage"] = usersWithStorage

	return stats, nil
}

// PinForRecalc represents a pin that may need size recalculation
type PinForRecalc struct {
	RequestID   string
	CID         string
	Username    string
	CurrentSize int64
	Status      string
}

// GetPinsNeedingSizeRecalc returns pins that may need size recalculation
// If includeAll is false, only returns pins with size=0
// If includeAll is true, returns all non-deleted pins (useful when switching from block to DAG size)
func (s *SQLiteService) GetPinsNeedingSizeRecalc(ctx context.Context, limit int, includeAll bool) ([]PinForRecalc, error) {
	var query string
	if includeAll {
		// Return all pinned CIDs (for recalculating all sizes after changing to cumulative size)
		query = `
			SELECT requestid, cid, username, size, status
			FROM pins
			WHERE status IN ('pinned', 'pinning')
			ORDER BY size ASC, created_at DESC
			LIMIT ?
		`
	} else {
		// Return only pins with size=0 (need initial size calculation)
		query = `
			SELECT requestid, cid, username, size, status
			FROM pins
			WHERE status IN ('pinned', 'pinning') AND size = 0
			ORDER BY created_at DESC
			LIMIT ?
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
