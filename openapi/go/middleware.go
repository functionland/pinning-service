package openapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

type contextKey string

const requestContextKey contextKey = "httpRequest"

// InjectRequestIntoContext is a middleware to inject the http.Request into the context
func InjectRequestIntoContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), requestContextKey, r)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GetRequestFromContext extracts the http.Request from the context
func GetRequestFromContext(ctx context.Context) (*http.Request, error) {
	req, ok := ctx.Value(requestContextKey).(*http.Request)
	if !ok {
		return nil, errors.New("no request found in context")
	}
	return req, nil
}

// AuthMiddleware checks for a valid auth token in the request and validates it
func AuthMiddleware(firestoreService *FirestoreService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, "Unauthorized: no authorization header provided", http.StatusUnauthorized)
				return
			}

			token := strings.TrimPrefix(authHeader, "Bearer ")
			if token == authHeader {
				http.Error(w, "Unauthorized: invalid token format", http.StatusUnauthorized)
				return
			}

			ctx := r.Context()
			_, err := firestoreService.GetUserIDFromToken(ctx, token)
			if err != nil {
				http.Error(w, "Unauthorized: "+err.Error(), http.StatusUnauthorized)
				return
			}

			// Pass the request context with user ID down the chain
			ctx = context.WithValue(ctx, "authToken", token)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
