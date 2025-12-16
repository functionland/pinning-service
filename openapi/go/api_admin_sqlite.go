package openapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/mux"
)

// AdminAPIController handles admin/system-only endpoints
type AdminAPIController struct {
	db        *SQLiteService
	systemKey string // System API key for authentication
}

// NewAdminAPIController creates a new admin API controller
func NewAdminAPIController(db *SQLiteService, systemKey string) *AdminAPIController {
	return &AdminAPIController{
		db:        db,
		systemKey: systemKey,
	}
}

// Routes returns the admin API routes
func (c *AdminAPIController) Routes() Routes {
	return Routes{
		"GetPendingPins": Route{
			Method:      "GET",
			Pattern:     "/admin/pins/pending",
			HandlerFunc: c.authMiddleware(c.GetPendingPins),
		},
		"BatchUpdatePinStatus": Route{
			Method:      "POST",
			Pattern:     "/admin/pins/status",
			HandlerFunc: c.authMiddleware(c.BatchUpdatePinStatus),
		},
		"BatchUpdatePinSize": Route{
			Method:      "POST",
			Pattern:     "/admin/pins/size",
			HandlerFunc: c.authMiddleware(c.BatchUpdatePinSize),
		},
		"GetSystemStats": Route{
			Method:      "GET",
			Pattern:     "/admin/stats",
			HandlerFunc: c.authMiddleware(c.GetSystemStats),
		},
		"GetStorageByUser": Route{
			Method:      "GET",
			Pattern:     "/admin/storage/user/{username}",
			HandlerFunc: c.authMiddleware(c.GetStorageByUser),
		},
		"GetStorageBySession": Route{
			Method:      "GET",
			Pattern:     "/admin/storage/session/{token}",
			HandlerFunc: c.authMiddleware(c.GetStorageBySession),
		},
		"GetTotalStorage": Route{
			Method:      "GET",
			Pattern:     "/admin/storage",
			HandlerFunc: c.authMiddleware(c.GetTotalStorage),
		},
	}
}

// authMiddleware validates system API key
func (c *AdminAPIController) authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		apiKey := r.Header.Get("X-System-Key")
		if apiKey == "" {
			apiKey = r.Header.Get("Authorization")
			if len(apiKey) > 7 && apiKey[:7] == "Bearer " {
				apiKey = apiKey[7:]
			}
		}

		if apiKey == "" || apiKey != c.systemKey {
			w.Header().Set("Content-Type", "application/json; charset=UTF-8")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(Failure{
				Error: FailureError{
					Reason:  "UNAUTHORIZED",
					Details: "Invalid or missing system API key",
				},
			})
			return
		}

		next(w, r)
	}
}

// PendingPinsRequest represents the query parameters for GetPendingPins
type PendingPinsRequest struct {
	After    time.Time `json:"after"`              // Mandatory: start time filter
	Before   time.Time `json:"before,omitempty"`   // Optional: end time filter
	Username string    `json:"username,omitempty"` // Optional: filter by username
	Limit    int       `json:"limit,omitempty"`    // Optional: default 200
	Status   string    `json:"status,omitempty"`   // Optional: default "pending", can be "queued", "pinning", etc.
}

// PendingPinsResponse represents the response for GetPendingPins
type PendingPinsResponse struct {
	Count int                   `json:"count"`
	Pins  []PendingPinInfoAdmin `json:"pins"`
}

// PendingPinInfoAdmin represents a single pending pin for admin API response
type PendingPinInfoAdmin struct {
	RequestID    string            `json:"requestid"`
	CID          string            `json:"cid"`
	Name         string            `json:"name,omitempty"`
	Username     string            `json:"username"`
	Status       string            `json:"status"`
	UploadStatus string            `json:"upload_status"`
	CreatedAt    time.Time         `json:"created_at"`
	Meta         map[string]string `json:"meta,omitempty"`
}

// GetPendingPins retrieves pins with pending/queued status for batch processing
// GET /admin/pins/pending?after=RFC3339&before=RFC3339&username=xxx&limit=200&status=pending
func (c *AdminAPIController) GetPendingPins(w http.ResponseWriter, r *http.Request) {
	// Parse query parameters
	query := r.URL.Query()

	// Mandatory: after (start time)
	afterStr := query.Get("after")
	if afterStr == "" {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Parameter 'after' is required (RFC3339 format)")
		return
	}
	after, err := time.Parse(time.RFC3339, afterStr)
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid 'after' time format. Use RFC3339 (e.g., 2024-01-01T00:00:00Z)")
		return
	}

	// Optional: before (end time)
	var before time.Time
	beforeStr := query.Get("before")
	if beforeStr != "" {
		before, err = time.Parse(time.RFC3339, beforeStr)
		if err != nil {
			writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid 'before' time format. Use RFC3339")
			return
		}
	}

	// Optional: username filter
	username := query.Get("username")

	// Optional: limit (default 200)
	limit := 200
	limitStr := query.Get("limit")
	if limitStr != "" {
		limit, err = strconv.Atoi(limitStr)
		if err != nil || limit <= 0 {
			writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid 'limit' parameter")
			return
		}
		if limit > 1000 {
			limit = 1000 // Cap at 1000
		}
	}

	// Optional: status filter (default: query both "pending" upload_status and "queued" status)
	statusFilter := query.Get("status")
	if statusFilter == "" {
		statusFilter = "pending" // Default to pending upload_status
	}

	// Query database
	ctx := r.Context()
	pins, err := c.db.GetPendingPinsAdmin(ctx, after, before, username, statusFilter, limit)
	if err != nil {
		writeAdminError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to query pins: "+err.Error())
		return
	}

	// Convert to API response type
	adminPins := make([]PendingPinInfoAdmin, len(pins))
	for i, pin := range pins {
		adminPins[i] = PendingPinInfoAdmin{
			RequestID:    pin.RequestID,
			CID:          pin.CID,
			Name:         pin.Name,
			Username:     pin.Username,
			Status:       pin.Status,
			UploadStatus: pin.UploadStatus,
			CreatedAt:    pin.CreatedAt,
			Meta:         pin.Meta,
		}
	}

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(PendingPinsResponse{
		Count: len(adminPins),
		Pins:  adminPins,
	})
}

// BatchUpdateRequest represents a batch status update request
type BatchUpdateRequest struct {
	Updates []PinStatusUpdate `json:"updates"`
}

// PinStatusUpdate represents a single CID status update
type PinStatusUpdate struct {
	CID          string `json:"cid"`
	Status       string `json:"status,omitempty"`        // Pin status: queued, pinning, pinned, failed
	UploadStatus string `json:"upload_status,omitempty"` // Upload status: pending, uploaded, failed
}

// BatchUpdateResponse represents the response for batch updates
type BatchUpdateResponse struct {
	Updated int      `json:"updated"`
	Failed  int      `json:"failed"`
	Errors  []string `json:"errors,omitempty"`
}

// BatchUpdatePinStatus updates the status of multiple pins by CID
// POST /admin/pins/status
// Body: {"updates": [{"cid": "Qm...", "status": "pinned"}, ...]}
func (c *AdminAPIController) BatchUpdatePinStatus(w http.ResponseWriter, r *http.Request) {
	var req BatchUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body: "+err.Error())
		return
	}

	if len(req.Updates) == 0 {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "No updates provided")
		return
	}

	if len(req.Updates) > 1000 {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Maximum 1000 updates per request")
		return
	}

	// Validate status values
	validStatuses := map[string]bool{"queued": true, "pinning": true, "pinned": true, "failed": true}
	validUploadStatuses := map[string]bool{"pending": true, "uploaded": true, "failed": true, "manifest_uploaded": true}

	for i, update := range req.Updates {
		if update.CID == "" {
			writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Update at index "+strconv.Itoa(i)+" missing CID")
			return
		}
		if update.Status != "" && !validStatuses[update.Status] {
			writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid status '"+update.Status+"' at index "+strconv.Itoa(i))
			return
		}
		if update.UploadStatus != "" && !validUploadStatuses[update.UploadStatus] {
			writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid upload_status '"+update.UploadStatus+"' at index "+strconv.Itoa(i))
			return
		}
		if update.Status == "" && update.UploadStatus == "" {
			writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Update at index "+strconv.Itoa(i)+" must specify status or upload_status")
			return
		}
	}

	// Convert to database type and perform batch update
	ctx := r.Context()
	dbUpdates := make([]PinStatusUpdateDB, len(req.Updates))
	for i, u := range req.Updates {
		dbUpdates[i] = PinStatusUpdateDB{
			CID:          u.CID,
			Status:       u.Status,
			UploadStatus: u.UploadStatus,
		}
	}
	updated, failed, errors := c.db.BatchUpdatePinStatusByCID(ctx, dbUpdates)

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(BatchUpdateResponse{
		Updated: updated,
		Failed:  failed,
		Errors:  errors,
	})
}

// SystemStatsResponse represents system statistics
type SystemStatsResponse struct {
	TotalUsers    int64            `json:"total_users"`
	TotalPins     int64            `json:"total_pins"`
	TotalSessions int64            `json:"total_sessions"`
	PinsByStatus  map[string]int64 `json:"pins_by_status"`
}

// GetSystemStats returns system statistics
// GET /admin/stats
func (c *AdminAPIController) GetSystemStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	stats, err := c.db.GetStats(ctx)
	if err != nil {
		writeAdminError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to get stats: "+err.Error())
		return
	}

	pinsByStatus, err := c.db.GetPinCountsByStatus(ctx)
	if err != nil {
		writeAdminError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to get pin stats: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(SystemStatsResponse{
		TotalUsers:    stats["users"],
		TotalPins:     stats["pins"],
		TotalSessions: stats["sessions"],
		PinsByStatus:  pinsByStatus,
	})
}

// writeAdminError writes a JSON error response for admin endpoints
func writeAdminError(w http.ResponseWriter, statusCode int, reason, details string) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(Failure{
		Error: FailureError{
			Reason:  reason,
			Details: details,
		},
	})
}

// ============================================================================
// Storage Tracking Endpoints
// ============================================================================

// PinSizeUpdate represents a single CID size update
type PinSizeUpdate struct {
	CID  string `json:"cid"`
	Size int64  `json:"size"`
}

// BatchSizeUpdateRequest represents a batch size update request
type BatchSizeUpdateRequest struct {
	Updates []PinSizeUpdate `json:"updates"`
}

// BatchUpdatePinSize updates the size of multiple pins by CID
// POST /admin/pins/size
// Body: {"updates": [{"cid": "Qm...", "size": 12345}, ...]}
func (c *AdminAPIController) BatchUpdatePinSize(w http.ResponseWriter, r *http.Request) {
	var req BatchSizeUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body: "+err.Error())
		return
	}

	if len(req.Updates) == 0 {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "No updates provided")
		return
	}

	if len(req.Updates) > 1000 {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Maximum 1000 updates per request")
		return
	}

	ctx := r.Context()
	updated := 0
	failed := 0
	var errors []string

	for _, update := range req.Updates {
		if update.CID == "" {
			failed++
			errors = append(errors, "Missing CID in update")
			continue
		}
		if update.Size < 0 {
			failed++
			errors = append(errors, "Invalid size for CID: "+update.CID)
			continue
		}

		err := c.db.UpdatePinSizeByCID(ctx, update.CID, update.Size)
		if err != nil {
			failed++
			errors = append(errors, "Failed to update CID "+update.CID+": "+err.Error())
		} else {
			updated++
		}
	}

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(BatchUpdateResponse{
		Updated: updated,
		Failed:  failed,
		Errors:  errors,
	})
}

// StorageResponse represents storage usage response
type StorageResponse struct {
	TotalSize   int64  `json:"total_size"`
	TotalSizeHR string `json:"total_size_human"` // Human readable
	PinCount    int64  `json:"pin_count"`
	Identifier  string `json:"identifier,omitempty"`
}

// UserStorageResponse represents user storage with session breakdown
type UserStorageResponse struct {
	Username    string            `json:"username"`
	TotalSize   int64             `json:"total_size"`
	TotalSizeHR string            `json:"total_size_human"`
	PinCount    int64             `json:"pin_count"`
	BySession   []StorageResponse `json:"by_session,omitempty"`
}

// formatBytes converts bytes to human readable string
func formatBytes(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return strconv.FormatInt(bytes, 10) + " B"
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return strconv.FormatFloat(float64(bytes)/float64(div), 'f', 2, 64) + " " + []string{"KB", "MB", "GB", "TB", "PB"}[exp]
}

// GetStorageByUser returns storage usage for a specific user
// GET /admin/storage/user/{username}
func (c *AdminAPIController) GetStorageByUser(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	username := vars["username"]
	if username == "" {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Username is required")
		return
	}

	ctx := r.Context()

	// Get total usage for user
	usage, err := c.db.GetStorageByUser(ctx, username)
	if err != nil {
		writeAdminError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to get storage: "+err.Error())
		return
	}

	// Get breakdown by session
	sessions, err := c.db.GetStorageByUserSessions(ctx, username)
	if err != nil {
		// Non-fatal, just return without session breakdown
		sessions = nil
	}

	var sessionResponses []StorageResponse
	for _, s := range sessions {
		sessionResponses = append(sessionResponses, StorageResponse{
			TotalSize:   s.TotalSize,
			TotalSizeHR: formatBytes(s.TotalSize),
			PinCount:    s.PinCount,
			Identifier:  s.Identifier,
		})
	}

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(UserStorageResponse{
		Username:    username,
		TotalSize:   usage.TotalSize,
		TotalSizeHR: formatBytes(usage.TotalSize),
		PinCount:    usage.PinCount,
		BySession:   sessionResponses,
	})
}

// GetStorageBySession returns storage usage for a specific session token (API key)
// GET /admin/storage/session/{token}
func (c *AdminAPIController) GetStorageBySession(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	token := vars["token"]
	if token == "" {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Session token is required")
		return
	}

	ctx := r.Context()

	usage, err := c.db.GetStorageBySessionToken(ctx, token)
	if err != nil {
		writeAdminError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to get storage: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(StorageResponse{
		TotalSize:   usage.TotalSize,
		TotalSizeHR: formatBytes(usage.TotalSize),
		PinCount:    usage.PinCount,
		Identifier:  token,
	})
}

// TotalStorageResponse represents total storage statistics
type TotalStorageResponse struct {
	TotalSize        int64  `json:"total_size"`
	TotalSizeHR      string `json:"total_size_human"`
	PinsWithSize     int64  `json:"pins_with_size"`
	UsersWithStorage int64  `json:"users_with_storage"`
}

// GetTotalStorage returns total storage statistics across all users
// GET /admin/storage
func (c *AdminAPIController) GetTotalStorage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	stats, err := c.db.GetTotalStorageStats(ctx)
	if err != nil {
		writeAdminError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to get storage stats: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(TotalStorageResponse{
		TotalSize:        stats["total_size"],
		TotalSizeHR:      formatBytes(stats["total_size"]),
		PinsWithSize:     stats["pins_with_size"],
		UsersWithStorage: stats["users_with_storage"],
	})
}

// NewAdminRouter creates a router for admin endpoints
func NewAdminRouter(controller *AdminAPIController) *mux.Router {
	router := mux.NewRouter().StrictSlash(true)

	for name, route := range controller.Routes() {
		router.
			Methods(route.Method).
			Path(route.Pattern).
			Name(name).
			Handler(route.HandlerFunc)
	}

	return router
}
