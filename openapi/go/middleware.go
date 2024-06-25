package openapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type contextKey string

const authTokenKey = contextKey("authToken")

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
				resp := createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", "no authorization header provided")
				createErrorResponseJSON(w, resp)
				return
			}

			token := strings.TrimPrefix(authHeader, "Bearer ")
			if token == authHeader {
				resp := createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", "invalid token format")
				createErrorResponseJSON(w, resp)
				return
			}

			ctx := r.Context()
			_, err := firestoreService.GetUserIDFromToken(ctx, token)
			if err != nil {
				resp := createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error())
				createErrorResponseJSON(w, resp)
				return
			}

			// Pass the request context with user ID down the chain
			ctx = context.WithValue(ctx, authTokenKey, token)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func createErrorResponse(statusCode int, reason, details string) ImplResponse {
	return Response(statusCode, Failure{
		Error: FailureError{
			Reason:  reason,
			Details: details,
		},
	})
}

func createErrorResponseJSON(w http.ResponseWriter, resp ImplResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.Code)
	// Use json.Marshal instead of json.NewEncoder to avoid adding new line
	jsonData, err := json.Marshal(resp.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Write(jsonData)
}
