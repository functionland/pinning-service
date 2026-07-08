package openapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/mux"
)

// co2KgSavedPerGB is a ROUGH, UNVERIFIED display estimate: kilograms of CO2
// notionally saved per GB stored on the decentralized network versus a
// centralized cloud. It is NOT an audited figure — the public UI labels the
// resulting number as "approximate". Replace with a real methodology before
// presenting it as anything more than an illustrative estimate.
const co2KgSavedPerGB = 0.5

// publicStatsTTL is how long a computed snapshot is served from memory before
// the next request recomputes it — keeps this public, unauthenticated endpoint
// from hammering the database.
const publicStatsTTL = 60 * time.Second

// PublicStatsTotals holds all-time platform totals.
type PublicStatsTotals struct {
	Users       int64   `json:"users"`
	StoredBytes int64   `json:"stored_bytes"`
	Uploads     int64   `json:"uploads"`
	Cids        int64   `json:"cids"`
	Websites    int64   `json:"websites"`
	FulaSpent   float64 `json:"fula_spent"`
	Co2SavedKg  float64 `json:"co2_saved_kg"`
}

// PublicStatsWindow holds new-in-window activity (today / 7d / 30d). Every
// field is an exact sum of the daily buckets except Cids, which is the sum of
// per-day distinct CIDs (a CID pinned on two different days counts twice) — an
// acceptable approximation for a dashboard, since content-addressed CIDs are
// almost always pinned once.
type PublicStatsWindow struct {
	Users       int64   `json:"users"`
	Uploads     int64   `json:"uploads"`
	StoredBytes int64   `json:"stored_bytes"`
	Cids        int64   `json:"cids"`
	Websites    int64   `json:"websites"`
	FulaSpent   float64 `json:"fula_spent"`
}

// PublicStatsDay is one UTC-day bucket of new activity.
type PublicStatsDay struct {
	Day         string  `json:"day"` // YYYY-MM-DD (UTC)
	Users       int64   `json:"users"`
	Uploads     int64   `json:"uploads"`
	StoredBytes int64   `json:"stored_bytes"`
	Cids        int64   `json:"cids"`
	Websites    int64   `json:"websites"`
	FulaSpent   float64 `json:"fula_spent"`
}

// PublicStatsResponse is the public dashboard payload.
type PublicStatsResponse struct {
	GeneratedAt string                       `json:"generated_at"`
	Totals      PublicStatsTotals            `json:"totals"`
	Windows     map[string]PublicStatsWindow `json:"windows"`
	Daily       []PublicStatsDay             `json:"daily"`
}

// PublicStatsControllerPostgres serves the cached public stats endpoint.
type PublicStatsControllerPostgres struct {
	db *PostgresService
	// mu guards the cached snapshot and is only held briefly (read or write) —
	// never across the DB compute, so cache hits are never blocked by a refresh.
	mu       sync.RWMutex
	cached   *PublicStatsResponse
	cachedAt time.Time
	// computeMu single-flights the recompute: at most one goroutine runs the
	// query set at a time; the rest wait, then serve the snapshot it just filled.
	computeMu sync.Mutex
}

// NewPublicStatsControllerPostgres creates the controller.
func NewPublicStatsControllerPostgres(db *PostgresService) *PublicStatsControllerPostgres {
	return &PublicStatsControllerPostgres{db: db}
}

// Routes returns the public stats routes. This endpoint is intentionally
// unauthenticated — the global auth middleware skips its path prefix (see
// AuthMiddlewarePostgres); it exposes only aggregate counts, never per-user data.
func (c *PublicStatsControllerPostgres) Routes() Routes {
	return Routes{
		"GetPublicStats": Route{
			Method:      "GET",
			Pattern:     "/api/v1/public-stats",
			HandlerFunc: c.GetPublicStats,
		},
	}
}

// NewPublicStatsRouterPostgres builds the sub-router.
func NewPublicStatsRouterPostgres(controller *PublicStatsControllerPostgres) *mux.Router {
	router := mux.NewRouter().StrictSlash(true)
	for name, route := range controller.Routes() {
		router.Methods(route.Method).Path(route.Pattern).Name(name).Handler(route.HandlerFunc)
	}
	return router
}

// GetPublicStats serves the cached snapshot, recomputing at most once per TTL.
func (c *PublicStatsControllerPostgres) GetPublicStats(w http.ResponseWriter, r *http.Request) {
	// Fast path: serve a fresh snapshot under only a brief read lock — cache
	// hits are never blocked by an in-progress recompute.
	if resp := c.freshCached(); resp != nil {
		writePublicStats(w, resp)
		return
	}

	// Single-flight the recompute so an unauthenticated flood triggers at most
	// one query set per TTL. The cache lock is NOT held during the DB work.
	c.computeMu.Lock()
	defer c.computeMu.Unlock()
	if resp := c.freshCached(); resp != nil { // another goroutine may have filled it
		writePublicStats(w, resp)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), defaultTimeout)
	defer cancel()
	fresh, err := c.db.computePublicStats(ctx)
	if err != nil {
		// Do not echo internal error detail on a public, unauthenticated
		// endpoint — log it server-side and return a generic message.
		log.Printf("[public-stats] compute error: %v", err)
		writePostgresErrorResponse(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Failed to compute public stats")
		return
	}
	c.mu.Lock()
	c.cached = fresh
	c.cachedAt = time.Now()
	c.mu.Unlock()
	writePublicStats(w, fresh)
}

// freshCached returns the cached snapshot if still within the TTL, else nil.
func (c *PublicStatsControllerPostgres) freshCached() *PublicStatsResponse {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.cached != nil && time.Since(c.cachedAt) < publicStatsTTL {
		return c.cached
	}
	return nil
}

func writePublicStats(w http.ResponseWriter, resp *PublicStatsResponse) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.Header().Set("Cache-Control", "public, max-age=60")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// computePublicStats runs the aggregate queries and assembles the snapshot.
// Postgres-only: these tables (webui_users, credit_history, user_credits,
// ai_generations) do not exist in the SQLite build.
func (s *PostgresService) computePublicStats(ctx context.Context) (*PublicStatsResponse, error) {
	var totals PublicStatsTotals

	// Users (cloud.fx.land dashboard accounts — the FxFiles user base).
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM webui_users`).Scan(&totals.Users); err != nil {
		return nil, fmt.Errorf("users count: %w", err)
	}

	// Pins: uploads, distinct CIDs, stored bytes (exclude deleted, matching
	// every other aggregate in this codebase).
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*), COUNT(DISTINCT cid), COALESCE(SUM(size), 0) FROM pins WHERE status != 'deleted'`,
	).Scan(&totals.Uploads, &totals.Cids, &totals.StoredBytes); err != nil {
		return nil, fmt.Errorf("pins aggregate: %w", err)
	}

	// FULA spent (all-time, cheap rollup column).
	if err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(total_deducted_fula), 0) FROM user_credits`,
	).Scan(&totals.FulaSpent); err != nil {
		return nil, fmt.Errorf("fula spent: %w", err)
	}

	// Websites generated. ai_generations lives in the same DB but is owned by
	// the AI service's own migrations — degrade to 0 if it isn't present yet.
	aiGen := aiGenExists(ctx, s.db)
	if aiGen {
		if err := s.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM ai_generations WHERE status = 'completed'`,
		).Scan(&totals.Websites); err != nil {
			return nil, fmt.Errorf("websites count: %w", err)
		}
	}

	totals.Co2SavedKg = float64(totals.StoredBytes) / 1e9 * co2KgSavedPerGB

	// Daily series over the trailing 30 UTC days, pre-filled so charts have a
	// point for every day even when nothing happened.
	now := time.Now().UTC()
	windowStart := now.Truncate(24 * time.Hour).AddDate(0, 0, -29)

	days := make(map[string]*PublicStatsDay, 30)
	order := make([]string, 0, 30)
	for i := 0; i < 30; i++ {
		key := windowStart.AddDate(0, 0, i).Format("2006-01-02")
		days[key] = &PublicStatsDay{Day: key}
		order = append(order, key)
	}

	// Pins per day: uploads, distinct CIDs, bytes.
	if err := s.queryDaily(ctx,
		`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS d, COUNT(*), COUNT(DISTINCT cid), COALESCE(SUM(size),0)
		 FROM pins WHERE status != 'deleted' AND created_at >= $1 GROUP BY d`,
		windowStart,
		func(rows *sql.Rows) error {
			var d string
			var uploads, cids, bytes int64
			if err := rows.Scan(&d, &uploads, &cids, &bytes); err != nil {
				return err
			}
			if e := days[d]; e != nil {
				e.Uploads, e.Cids, e.StoredBytes = uploads, cids, bytes
			}
			return nil
		}); err != nil {
		return nil, fmt.Errorf("pins daily: %w", err)
	}

	// New users per day.
	if err := s.queryDaily(ctx,
		`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS d, COUNT(*)
		 FROM webui_users WHERE created_at >= $1 GROUP BY d`,
		windowStart,
		func(rows *sql.Rows) error {
			var d string
			var n int64
			if err := rows.Scan(&d, &n); err != nil {
				return err
			}
			if e := days[d]; e != nil {
				e.Users = n
			}
			return nil
		}); err != nil {
		return nil, fmt.Errorf("users daily: %w", err)
	}

	// FULA spent per day (hourly storage deductions).
	if err := s.queryDaily(ctx,
		`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS d, COALESCE(SUM(amount_fula),0)
		 FROM credit_history WHERE tx_type = 'hourly_deduction' AND created_at >= $1 GROUP BY d`,
		windowStart,
		func(rows *sql.Rows) error {
			var d string
			var f float64
			if err := rows.Scan(&d, &f); err != nil {
				return err
			}
			if e := days[d]; e != nil {
				e.FulaSpent = f
			}
			return nil
		}); err != nil {
		return nil, fmt.Errorf("fula daily: %w", err)
	}

	// Websites generated per day (guarded).
	if aiGen {
		if err := s.queryDaily(ctx,
			`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS d, COUNT(*)
			 FROM ai_generations WHERE status = 'completed' AND created_at >= $1 GROUP BY d`,
			windowStart,
			func(rows *sql.Rows) error {
				var d string
				var n int64
				if err := rows.Scan(&d, &n); err != nil {
					return err
				}
				if e := days[d]; e != nil {
					e.Websites = n
				}
				return nil
			}); err != nil {
			return nil, fmt.Errorf("websites daily: %w", err)
		}
	}

	daily := make([]PublicStatsDay, 0, len(order))
	for _, k := range order {
		daily = append(daily, *days[k])
	}

	return &PublicStatsResponse{
		GeneratedAt: now.Format(time.RFC3339),
		Totals:      totals,
		Windows: map[string]PublicStatsWindow{
			"today": sumWindow(daily, 1),
			"7d":    sumWindow(daily, 7),
			"30d":   sumWindow(daily, 30),
		},
		Daily: daily,
	}, nil
}

// queryDaily runs a day-bucketed query and applies scan to each row.
func (s *PostgresService) queryDaily(ctx context.Context, query string, arg interface{}, scan func(*sql.Rows) error) error {
	rows, err := s.db.QueryContext(ctx, query, arg)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// aiGenExists reports whether the ai_generations table is present (it is created
// by the AI service's migrations, not the Go backend's).
func aiGenExists(ctx context.Context, db *sql.DB) bool {
	var reg sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT to_regclass('public.ai_generations')`).Scan(&reg); err != nil {
		return false
	}
	return reg.Valid
}

// sumWindow sums the last n days of the chronologically-ascending daily slice.
func sumWindow(daily []PublicStatsDay, n int) PublicStatsWindow {
	var w PublicStatsWindow
	start := len(daily) - n
	if start < 0 {
		start = 0
	}
	for _, d := range daily[start:] {
		w.Users += d.Users
		w.Uploads += d.Uploads
		w.StoredBytes += d.StoredBytes
		w.Cids += d.Cids
		w.Websites += d.Websites
		w.FulaSpent += d.FulaSpent
	}
	return w
}
