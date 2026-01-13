package openapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/mux"
)

// AdminAPIControllerPostgres handles admin/system-only endpoints with PostgreSQL backend
type AdminAPIControllerPostgres struct {
	db        *PostgresService
	systemKey string
}

// NewAdminAPIControllerPostgres creates a new admin API controller with PostgreSQL backend
func NewAdminAPIControllerPostgres(db *PostgresService, systemKey string) *AdminAPIControllerPostgres {
	return &AdminAPIControllerPostgres{
		db:        db,
		systemKey: systemKey,
	}
}

// Routes returns the admin API routes
func (c *AdminAPIControllerPostgres) Routes() Routes {
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
		"GetPinsNeedingSizeRecalc": Route{
			Method:      "GET",
			Pattern:     "/admin/pins/needs-size-recalc",
			HandlerFunc: c.authMiddleware(c.GetPinsNeedingSizeRecalc),
		},
	}
}

// authMiddleware validates system API key
func (c *AdminAPIControllerPostgres) authMiddleware(next http.HandlerFunc) http.HandlerFunc {
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

// GetPendingPins retrieves pins with pending/queued status for batch processing
func (c *AdminAPIControllerPostgres) GetPendingPins(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	afterStr := query.Get("after")
	if afterStr == "" {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Parameter 'after' is required (RFC3339 format)")
		return
	}
	after, err := time.Parse(time.RFC3339, afterStr)
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid 'after' time format. Use RFC3339")
		return
	}

	var before time.Time
	beforeStr := query.Get("before")
	if beforeStr != "" {
		before, err = time.Parse(time.RFC3339, beforeStr)
		if err != nil {
			writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid 'before' time format. Use RFC3339")
			return
		}
	}

	username := query.Get("username")

	limit := 200
	limitStr := query.Get("limit")
	if limitStr != "" {
		limit, err = strconv.Atoi(limitStr)
		if err != nil || limit <= 0 {
			writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid 'limit' parameter")
			return
		}
		if limit > 1000 {
			limit = 1000
		}
	}

	statusFilter := query.Get("status")
	if statusFilter == "" {
		statusFilter = "pending"
	}

	ctx := r.Context()
	pins, err := c.db.GetPendingPinsAdmin(ctx, after, before, username, statusFilter, limit)
	if err != nil {
		writeAdminError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to query pins: "+err.Error())
		return
	}

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

// BatchUpdatePinStatus updates the status of multiple pins by CID
func (c *AdminAPIControllerPostgres) BatchUpdatePinStatus(w http.ResponseWriter, r *http.Request) {
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

// GetSystemStats returns system statistics
func (c *AdminAPIControllerPostgres) GetSystemStats(w http.ResponseWriter, r *http.Request) {
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

// BatchUpdatePinSize updates the size of multiple pins by CID
func (c *AdminAPIControllerPostgres) BatchUpdatePinSize(w http.ResponseWriter, r *http.Request) {
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

// GetStorageByUser returns storage usage for a specific user
func (c *AdminAPIControllerPostgres) GetStorageByUser(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	username := vars["username"]
	if username == "" {
		writeAdminError(w, http.StatusBadRequest, "BAD_REQUEST", "Username is required")
		return
	}

	ctx := r.Context()

	usage, err := c.db.GetStorageByUser(ctx, username)
	if err != nil {
		writeAdminError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to get storage: "+err.Error())
		return
	}

	sessions, err := c.db.GetStorageByUserSessions(ctx, username)
	if err != nil {
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

// GetStorageBySession returns storage usage for a specific session token
func (c *AdminAPIControllerPostgres) GetStorageBySession(w http.ResponseWriter, r *http.Request) {
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

// GetTotalStorage returns total storage statistics
func (c *AdminAPIControllerPostgres) GetTotalStorage(w http.ResponseWriter, r *http.Request) {
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

// GetPinsNeedingSizeRecalc returns pins that may need size recalculation
func (c *AdminAPIControllerPostgres) GetPinsNeedingSizeRecalc(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	limit := 100
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 {
			limit = l
		}
	}

	includeAll := r.URL.Query().Get("include_all") == "true"

	dbPins, err := c.db.GetPinsNeedingSizeRecalc(ctx, limit, includeAll)
	if err != nil {
		writeAdminError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to get pins: "+err.Error())
		return
	}

	pins := make([]PinNeedingRecalc, len(dbPins))
	for i, p := range dbPins {
		pins[i] = PinNeedingRecalc{
			RequestID:   p.RequestID,
			CID:         p.CID,
			Username:    p.Username,
			CurrentSize: p.CurrentSize,
			Status:      p.Status,
		}
	}

	note := "Pins with size=0 that need size calculation."
	if includeAll {
		note = "All pinned CIDs. Size values may need recalculation."
	}

	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(PinsNeedingRecalcResponse{
		Count: int64(len(pins)),
		Pins:  pins,
		Note:  note,
	})
}

// NewAdminRouterPostgres creates a router for admin endpoints with PostgreSQL backend
func NewAdminRouterPostgres(controller *AdminAPIControllerPostgres) *mux.Router {
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
