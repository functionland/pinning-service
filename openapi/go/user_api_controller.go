package openapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type UserAPIController struct {
	service *UserService
}

func NewUserAPIController(service *UserService) *UserAPIController {
	return &UserAPIController{service: service}
}

func (c *UserAPIController) CreateSession(w http.ResponseWriter, r *http.Request) {
	var credentials struct {
		Username string `json:"username"`
	}

	if err := json.NewDecoder(r.Body).Decode(&credentials); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Set a timeout for the context
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	response, err := c.service.CreateSession(ctx, credentials.Username)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	json.NewEncoder(w).Encode(response)
}

func (c *UserAPIController) DeleteSession(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("Authorization")
	if token == "" {
		http.Error(w, "Authorization token not provided", http.StatusUnauthorized)
		return
	}

	// Set a timeout for the context
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	err := c.service.DeleteSession(ctx, token)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	json.NewEncoder(w).Encode("ok")
}
