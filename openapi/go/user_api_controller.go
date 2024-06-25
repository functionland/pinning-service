package openapi

import (
	"encoding/json"
	"net/http"
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

	ctx := r.Context()
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

	ctx := r.Context()
	err := c.service.DeleteSession(ctx, token)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	json.NewEncoder(w).Encode("ok")
}
