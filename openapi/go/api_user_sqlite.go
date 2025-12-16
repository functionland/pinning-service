package openapi

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"
)

// UserAPIControllerSQLite handles user-related HTTP requests with SQLite backend
type UserAPIControllerSQLite struct {
	service *UserServiceSQLite
}

// NewUserAPIControllerSQLite creates a new user API controller
func NewUserAPIControllerSQLite(service *UserServiceSQLite) *UserAPIControllerSQLite {
	return &UserAPIControllerSQLite{service: service}
}

// Routes returns the routes for the user API
func (c *UserAPIControllerSQLite) Routes() Routes {
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

// LoginRequest represents login/register request body
type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// LoginResponse represents login response body
type LoginResponse struct {
	Token    string `json:"token"`
	Username string `json:"username"`
}

// Register handles user registration
func (c *UserAPIControllerSQLite) Register(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeSQLiteErrorResponse(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return
	}

	if req.Username == "" || req.Password == "" {
		writeSQLiteErrorResponse(w, http.StatusBadRequest, "BAD_REQUEST", "Username and password are required")
		return
	}

	ctx := r.Context()
	if err := c.service.CreateUser(ctx, req.Username, req.Password); err != nil {
		if err.Error() == "user already exists" {
			writeSQLiteErrorResponse(w, http.StatusConflict, "CONFLICT", "User already exists")
			return
		}
		writeSQLiteErrorResponse(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to create user")
		return
	}

	// Create session for the new user
	token, err := c.service.CreateSession(ctx, req.Username)
	if err != nil {
		writeSQLiteErrorResponse(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to create session")
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
func (c *UserAPIControllerSQLite) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeSQLiteErrorResponse(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return
	}

	if req.Username == "" || req.Password == "" {
		writeSQLiteErrorResponse(w, http.StatusBadRequest, "BAD_REQUEST", "Username and password are required")
		return
	}

	ctx := r.Context()

	// Authenticate user
	_, err := c.service.AuthenticateUser(ctx, req.Username, req.Password)
	if err != nil {
		// Record failed login attempt
		c.service.RecordLoginAttempt(ctx, req.Username, "failed", r.RemoteAddr, r.UserAgent())
		writeSQLiteErrorResponse(w, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid credentials")
		return
	}

	// Create session
	token, err := c.service.CreateSession(ctx, req.Username)
	if err != nil {
		writeSQLiteErrorResponse(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to create session")
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
func (c *UserAPIControllerSQLite) Logout(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		writeSQLiteErrorResponse(w, http.StatusBadRequest, "BAD_REQUEST", "Missing authorization header")
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

// NewAdditionalRouterSQLite creates a router for additional endpoints (auth)
func NewAdditionalRouterSQLite(pinsController *PinsAPIController, userController *UserAPIControllerSQLite) *mux.Router {
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
