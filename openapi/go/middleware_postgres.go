package openapi

import (
	"context"
	"net/http"
	"os"
	"strings"
)

// usernameContextKeyPostgres is the context key for username in PostgreSQL middleware
const usernameContextKeyPostgres = contextKey("username_postgres")

// AuthMiddlewarePostgres creates authentication middleware using PostgreSQL backend
func AuthMiddlewarePostgres(db *PostgresService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip auth for login/register endpoints
			if strings.HasPrefix(r.URL.Path, "/auth/") {
				next.ServeHTTP(w, r)
				return
			}

			// Service-auth (MCP/AI writes from the co-located Fula S3 gateway):
			// the gateway asserts the user via an HMAC over (user_id, exp) in the
			// X-Fula-Service-Auth header instead of a session bearer (its token is
			// a gateway-scoped JWT, not a session, so ValidateSession below would
			// reject it). FAIL-CLOSED: a present-but-invalid header is rejected and
			// never falls through to the session path. ABSENT => the normal
			// Authorization/session path below, unchanged (normal users untouched).
			if svc := r.Header.Get(ServiceAuthHeader); svc != "" {
				uid, err := verifyServiceAuthValue(svc, os.Getenv(ServiceSecretEnv))
				if err != nil {
					writePostgresErrorResponse(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid service authentication")
					return
				}
				ctx := context.WithValue(r.Context(), usernameContextKeyPostgres, uid)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			// Extract token from Authorization header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				writePostgresErrorResponse(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing authorization header")
				return
			}

			token := strings.TrimPrefix(authHeader, "Bearer ")
			if token == authHeader {
				writePostgresErrorResponse(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid authorization format")
				return
			}

			// Validate session
			ctx, cancel := context.WithTimeout(r.Context(), defaultTimeout)
			defer cancel()

			username, err := db.ValidateSession(ctx, token)
			if err != nil {
				writePostgresErrorResponse(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid or expired session")
				return
			}

			// Add username to context for downstream handlers
			ctx = context.WithValue(r.Context(), usernameContextKeyPostgres, username)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetUsernameFromContextPostgres retrieves the username from context
func GetUsernameFromContextPostgres(ctx context.Context) (string, bool) {
	username, ok := ctx.Value(usernameContextKeyPostgres).(string)
	return username, ok
}

// writePostgresErrorResponse writes a JSON error response
func writePostgresErrorResponse(w http.ResponseWriter, statusCode int, reason, details string) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	EncodeJSONResponse(Failure{
		Error: FailureError{
			Reason:  reason,
			Details: details,
		},
	}, &statusCode, w)
}
