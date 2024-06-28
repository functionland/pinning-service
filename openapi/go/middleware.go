package openapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
)

type contextKey string

const authTokenKey = contextKey("authToken")
const requestContextKey contextKey = "httpRequest"

// InjectRequestIntoContext is a middleware to inject the http.Request into the context
func InjectRequestIntoContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set a timeout of 90 seconds for each request
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()

		ctx = context.WithValue(ctx, requestContextKey, r)
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
			// Allow unauthenticated access to /auth/token endpoint
			if r.Method == http.MethodPost && r.URL.Path == "/auth/token" {
				next.ServeHTTP(w, r)
				return
			}

			// Wrap the ResponseWriter
			wrappedWriter := &responseCaptureWriter{ResponseWriter: w, body: &bytes.Buffer{}}

			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				resp := createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", "no authorization header provided")
				createErrorResponseJSON(wrappedWriter, resp)
				logResponse(r, wrappedWriter)
				return
			}

			token := strings.TrimPrefix(authHeader, "Bearer ")
			if token == authHeader {
				resp := createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", "invalid token format")
				createErrorResponseJSON(wrappedWriter, resp)
				logResponse(r, wrappedWriter)
				return
			}

			firestoreCtx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
			defer cancel()
			_, err := firestoreService.GetUserIDFromToken(firestoreCtx, token, "middleware")
			if err != nil {
				resp := createErrorResponse(http.StatusUnauthorized, "UNAUTHORIZED", err.Error())
				createErrorResponseJSON(wrappedWriter, resp)
				logResponse(r, wrappedWriter)
				return
			}

			// Pass the request context with user ID down the chain
			ctx := context.WithValue(r.Context(), authTokenKey, token)
			next.ServeHTTP(wrappedWriter, r.WithContext(ctx))

			// Log the response after serving the request
			logResponse(r, wrappedWriter)
		})
	}
}

// responseCaptureWriter captures the response details
type responseCaptureWriter struct {
	http.ResponseWriter
	status int
	body   *bytes.Buffer
}

func (w *responseCaptureWriter) WriteHeader(statusCode int) {
	w.status = statusCode
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *responseCaptureWriter) Write(b []byte) (int, error) {
	w.body.Write(b)
	return w.ResponseWriter.Write(b)
}

func logResponse(r *http.Request, w *responseCaptureWriter) {
	// Log the response details
	log.Printf("Response: %d %s %s", w.status, r.RequestURI, w.body.String())
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
	if err := json.NewEncoder(w).Encode(resp.Body); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
	}
}
