package openapi

import (
	"context"
	"net/http"
	"path/filepath"
	"testing"
)

// newTestSQLiteSvc spins up a throwaway file-backed SQLite service (pure
// in-memory SQLite is unreliable across connections in the pool).
func newTestSQLiteSvc(t *testing.T) *SQLiteService {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "refcount_test.db")
	svc, err := NewSQLiteService(dbPath)
	if err != nil {
		t.Fatalf("NewSQLiteService: %v", err)
	}
	t.Cleanup(func() { _ = svc.db.Close() })
	return svc
}

// addActivePin inserts a pin for user/cid then moves it to `status`
// ("queued"/"" leaves it as inserted). Returns the requestid.
func addActivePin(t *testing.T, svc *SQLiteService, user, cid, status string) string {
	t.Helper()
	ctx := context.Background()
	reqID, err := svc.AddPin(ctx, user, Pin{Cid: cid, Name: "n"}, "uploaded")
	if err != nil {
		t.Fatalf("AddPin(%s,%s): %v", user, cid, err)
	}
	if status != "" && status != "queued" {
		if err := svc.UpdatePinPinningStatus(ctx, reqID, status); err != nil {
			t.Fatalf("UpdatePinPinningStatus(%s,%s): %v", reqID, status, err)
		}
	}
	return reqID
}

// TestCountActivePinsByCID verifies the F6 ref-count counts only active pins
// (queued/pinning/pinned) across ALL users and ignores deleted/failed.
func TestCountActivePinsByCID(t *testing.T) {
	svc := newTestSQLiteSvc(t)
	ctx := context.Background()

	// cidX: pinned + queued = active(2); one deleted + one failed = inactive.
	addActivePin(t, svc, "userA", "cidX", "pinned")
	addActivePin(t, svc, "userB", "cidX", "queued")
	delReq := addActivePin(t, svc, "userC", "cidX", "pinned")
	if err := svc.MarkPinAsDeleted(ctx, delReq); err != nil {
		t.Fatalf("MarkPinAsDeleted: %v", err)
	}
	addActivePin(t, svc, "userD", "cidX", "failed")

	if got, err := svc.CountActivePinsByCID(ctx, "cidX"); err != nil || got != 2 {
		t.Fatalf("CountActivePinsByCID(cidX) = %d (err=%v), want 2", got, err)
	}
	if got, err := svc.CountActivePinsByCID(ctx, "cidUNKNOWN"); err != nil || got != 0 {
		t.Fatalf("CountActivePinsByCID(unknown) = %d (err=%v), want 0", got, err)
	}
	if _, err := svc.CountActivePinsByCID(ctx, ""); err == nil {
		t.Fatalf("CountActivePinsByCID(\"\"): expected error")
	}
}

// authCtx returns a context carrying an *http.Request with a Bearer token —
// the exact shape extractAuthTokenFromContext expects.
func authCtx(token string) context.Context {
	req, _ := http.NewRequest(http.MethodDelete, "/pins/x", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return context.WithValue(context.Background(), requestContextKey, req)
}

// TestDeletePinRefcountGuard_SQLite is the end-to-end F6 guarantee: when two
// users pin the same CID, one user deleting their pin must NOT unpin the CID
// the other user still holds. We assert on the ref-count the guard reads (the
// gate for the cluster unpin); the cluster client is nil so the async unpin is a
// harmless no-op.
func TestDeletePinRefcountGuard_SQLite(t *testing.T) {
	dbsvc := newTestSQLiteSvc(t)
	ctx := context.Background()

	// Map bearer tokens → usernames (extractUserIDFromAuth resolves via sessions).
	for _, s := range []struct{ user, token string }{{"userA", "tokenA"}, {"userB", "tokenB"}} {
		if _, err := dbsvc.db.ExecContext(ctx,
			"INSERT INTO sessions (username, session_token) VALUES (?, ?)", s.user, s.token); err != nil {
			t.Fatalf("seed session %s: %v", s.user, err)
		}
	}

	// Two DIFFERENT users pin the SAME cid.
	reqA := addActivePin(t, dbsvc, "userA", "cidShared", "pinned")
	reqB := addActivePin(t, dbsvc, "userB", "cidShared", "pinned")

	svc := &PinsAPIServiceSQLite{db: dbsvc} // nil cluster client → unpin is a no-op

	// userA deletes their pin. cidShared is STILL held by userB → the guard must
	// keep the cluster pin (active count stays 1).
	resp, err := svc.DeletePinByRequestId(authCtx("tokenA"), reqA)
	if err != nil {
		t.Fatalf("delete A: %v", err)
	}
	if resp.Code != http.StatusAccepted {
		t.Fatalf("delete A: code %d, want %d", resp.Code, http.StatusAccepted)
	}
	if n, _ := dbsvc.CountActivePinsByCID(ctx, "cidShared"); n != 1 {
		t.Fatalf("after A delete: active count = %d, want 1 (B still holds it)", n)
	}

	// userB deletes too → now zero references; the CID is free to be unpinned.
	if _, err := svc.DeletePinByRequestId(authCtx("tokenB"), reqB); err != nil {
		t.Fatalf("delete B: %v", err)
	}
	if n, _ := dbsvc.CountActivePinsByCID(ctx, "cidShared"); n != 0 {
		t.Fatalf("after B delete: active count = %d, want 0", n)
	}
}
