package openapi

import (
	"context"
	"net/http"
	"strings"
	"time"
)

// defaultTimeout for database operations
const defaultTimeout = 30 * time.Second

// usernameContextKeySQLite is the context key for username in SQLite middleware
const usernameContextKeySQLite = contextKey("username_sqlite")

// AuthMiddlewareSQLite creates authentication middleware using SQLite backend
func AuthMiddlewareSQLite(db *SQLiteService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip auth for login/register endpoints
			if strings.HasPrefix(r.URL.Path, "/auth/") {
				next.ServeHTTP(w, r)
				return
			}

			// Extract token from Authorization header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				writeSQLiteErrorResponse(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing authorization header")
				return
			}

			token := strings.TrimPrefix(authHeader, "Bearer ")
			if token == authHeader {
				writeSQLiteErrorResponse(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid authorization format")
				return
			}

			// Validate session
			ctx, cancel := context.WithTimeout(r.Context(), defaultTimeout)
			defer cancel()

			username, err := db.ValidateSession(ctx, token)
			if err != nil {
				writeSQLiteErrorResponse(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid or expired session")
				return
			}

			// Add username to context for downstream handlers
			ctx = context.WithValue(r.Context(), usernameContextKeySQLite, username)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetUsernameFromContextSQLite retrieves the username from context
func GetUsernameFromContextSQLite(ctx context.Context) (string, bool) {
	username, ok := ctx.Value(usernameContextKeySQLite).(string)
	return username, ok
}

// writeSQLiteErrorResponse writes a JSON error response
func writeSQLiteErrorResponse(w http.ResponseWriter, statusCode int, reason, details string) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	EncodeJSONResponse(Failure{
		Error: FailureError{
			Reason:  reason,
			Details: details,
		},
	}, &statusCode, w)
}
