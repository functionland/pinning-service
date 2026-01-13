package openapi

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"
)

// UserAPIControllerPostgres handles user-related HTTP requests with PostgreSQL backend
type UserAPIControllerPostgres struct {
	service *UserServicePostgres
}

// NewUserAPIControllerPostgres creates a new user API controller
func NewUserAPIControllerPostgres(service *UserServicePostgres) *UserAPIControllerPostgres {
	return &UserAPIControllerPostgres{service: service}
}

// Routes returns the routes for the user API
func (c *UserAPIControllerPostgres) Routes() Routes {
	return Routes{
		"Register": Route{
			Method:      http.MethodPost,
			Pattern:     "/auth/register",
			HandlerFunc: c.Register,
		},
		"Login": Route{
			Method:      http.MethodPost,
			Pattern:     "/auth/login",
			HandlerFunc: c.Login,
		},
		"Logout": Route{
			Method:      http.MethodPost,
			Pattern:     "/auth/logout",
			HandlerFunc: c.Logout,
		},
	}
}

// Register handles user registration
func (c *UserAPIControllerPostgres) Register(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writePostgresErrorResponse(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return
	}

	if req.Username == "" || req.Password == "" {
		writePostgresErrorResponse(w, http.StatusBadRequest, "BAD_REQUEST", "Username and password are required")
		return
	}

	ctx := r.Context()
	if err := c.service.CreateUser(ctx, req.Username, req.Password); err != nil {
		if err.Error() == "user already exists" {
			writePostgresErrorResponse(w, http.StatusConflict, "CONFLICT", "User already exists")
			return
		}
		writePostgresErrorResponse(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to create user")
		return
	}

	// Create session for the new user
	token, err := c.service.CreateSession(ctx, req.Username)
	if err != nil {
		writePostgresErrorResponse(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to create session")
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(LoginResponse{
		Token:    token,
		Username: req.Username,
	})
}

// Login handles user login
func (c *UserAPIControllerPostgres) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writePostgresErrorResponse(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return
	}

	if req.Username == "" || req.Password == "" {
		writePostgresErrorResponse(w, http.StatusBadRequest, "BAD_REQUEST", "Username and password are required")
		return
	}

	ctx := r.Context()

	// Authenticate user
	_, err := c.service.AuthenticateUser(ctx, req.Username, req.Password)
	if err != nil {
		// Record failed login attempt
		c.service.RecordLoginAttempt(ctx, req.Username, "failed", r.RemoteAddr, r.UserAgent())
		writePostgresErrorResponse(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid credentials")
		return
	}

	// Create session
	token, err := c.service.CreateSession(ctx, req.Username)
	if err != nil {
		writePostgresErrorResponse(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to create session")
		return
	}

	// Record successful login
	c.service.RecordLoginAttempt(ctx, req.Username, "success", r.RemoteAddr, r.UserAgent())

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(LoginResponse{
		Token:    token,
		Username: req.Username,
	})
}

// Logout handles user logout
func (c *UserAPIControllerPostgres) Logout(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		writePostgresErrorResponse(w, http.StatusBadRequest, "BAD_REQUEST", "Missing authorization header")
		return
	}

	token := authHeader
	if len(authHeader) > 7 && authHeader[:7] == "Bearer " {
		token = authHeader[7:]
	}

	ctx := r.Context()
	if err := c.service.DeleteSession(ctx, token); err != nil {
		// Session might already be deleted, just return success
	}

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"message": "Logged out successfully"})
}

// NewAdditionalRouterPostgres creates a router for additional endpoints (auth)
func NewAdditionalRouterPostgres(pinsController *PinsAPIController, userController *UserAPIControllerPostgres) *mux.Router {
	router := mux.NewRouter().StrictSlash(true)

	// Add user routes
	for name, route := range userController.Routes() {
		router.
			Methods(route.Method).
			Path(route.Pattern).
			Name(name).
			Handler(route.HandlerFunc)
	}

	return router
}
