package openapi

import (
	"context"
	"errors"
	"net/http"
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
