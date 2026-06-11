package openapi

import (
	"context"
	"net/http"
	"testing"

	"github.com/ipfs-cluster/ipfs-cluster/api"
)

// pm builds a PeerMap from statuses (peer ids are irrelevant to aggregation).
func pm(statuses ...api.TrackerStatus) map[string]api.PinInfoShort {
	m := make(map[string]api.PinInfoShort, len(statuses))
	for i, st := range statuses {
		m[string(rune('a'+i))] = api.PinInfoShort{Status: st}
	}
	return m
}

// TestAggregateClusterStatus locks in the peer-map reduction. The old
// behavior returned a RANDOM peer's status (Go map iteration), which made
// refreshes a lottery between pinned/queued/failed on multi-peer clusters.
func TestAggregateClusterStatus(t *testing.T) {
	tests := []struct {
		name string
		m    map[string]api.PinInfoShort
		want string
	}{
		{"empty map", pm(), "unpinned"},
		{"all remote says nothing", pm(api.TrackerStatusRemote, api.TrackerStatusRemote), "unpinned"},
		{"one pinned wins over everything", pm(api.TrackerStatusRemote, api.TrackerStatusUnpinned, api.TrackerStatusPinError, api.TrackerStatusPinned), "pinned"},
		{"pinning beats queued and unpinned", pm(api.TrackerStatusUnpinned, api.TrackerStatusPinQueued, api.TrackerStatusPinning), "pinning"},
		{"queued beats errors and unpinned", pm(api.TrackerStatusUnpinned, api.TrackerStatusPinError, api.TrackerStatusPinQueued), "pin_queued"},
		{"errors beat plain unpinned", pm(api.TrackerStatusUnpinned, api.TrackerStatusPinError), "pin_error"},
		{"only unpinned", pm(api.TrackerStatusUnpinned, api.TrackerStatusUnpinned), "unpinned"},
		// The production case: ~30 peers, mostly remote, two allocated
		// followers not converged yet, four holding the data.
		{"production mix", pm(
			api.TrackerStatusRemote, api.TrackerStatusRemote, api.TrackerStatusRemote,
			api.TrackerStatusUnpinned, api.TrackerStatusUnpinned,
			api.TrackerStatusPinned, api.TrackerStatusPinned, api.TrackerStatusPinned, api.TrackerStatusPinned,
		), "pinned"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := aggregateClusterStatus(tt.m); got != tt.want {
				t.Errorf("aggregateClusterStatus = %q, want %q", got, tt.want)
			}
		})
	}
}

// withStatuses configures the fake cluster client's Status() response.
func (f *fakeClusterClient) withStatuses(statuses ...api.TrackerStatus) *fakeClusterClient {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statusPeerMap = pm(statuses...)
	return f
}

func refreshPin(t *testing.T, svc *PinsAPIServiceSQLite, token, requestID string) Status {
	t.Helper()
	resp, err := svc.GetPinByRequestId(authCtx(token), requestID)
	if err != nil {
		t.Fatalf("GetPinByRequestId: %v", err)
	}
	if resp.Code != http.StatusOK {
		t.Fatalf("GetPinByRequestId code = %d, want 200", resp.Code)
	}
	return resp.Body.(PinStatus).Status
}

func seedSession(t *testing.T, dbsvc *SQLiteService, user, token string) {
	t.Helper()
	if _, err := dbsvc.db.ExecContext(context.Background(),
		"INSERT INTO sessions (username, session_token) VALUES (?, ?)", user, token); err != nil {
		t.Fatalf("seed session: %v", err)
	}
}

// TestRefresh_NoDowngradeWhileInFlight: a refresh during an in-flight import
// (cluster reports only unpinned/remote) must NOT persist failed over
// queued/pinning — this is exactly what bit the first production import.
func TestRefresh_NoDowngradeWhileInFlight(t *testing.T) {
	dbsvc := newTestSQLiteSvc(t)
	seedSession(t, dbsvc, "userA", "tokenA")
	fake := (&fakeClusterClient{}).withStatuses(
		api.TrackerStatusRemote, api.TrackerStatusUnpinned, api.TrackerStatusUnpinned)
	svc := &PinsAPIServiceSQLite{db: dbsvc, ipfsClusterAPI: fake}

	cidStr := rawTestBlock(t, []byte("in-flight content")).Cid().String()
	reqID := addActivePin(t, dbsvc, "userA", cidStr, "pinning")

	if got := refreshPin(t, svc, "tokenA", reqID); got != PINNING {
		t.Errorf("refresh mid-import returned %s, want pinning (no downgrade)", got)
	}
	rowStatus, _ := pinRow(t, dbsvc, reqID)
	if rowStatus != "pinning" {
		t.Errorf("row status = %q, want pinning untouched in DB", rowStatus)
	}
}

// TestRefresh_AggregatesPinnedAcrossPeers: one pinned allocation among many
// remote/unpinned peers means the content IS pinned — the lottery is gone.
func TestRefresh_AggregatesPinnedAcrossPeers(t *testing.T) {
	dbsvc := newTestSQLiteSvc(t)
	seedSession(t, dbsvc, "userA", "tokenA")
	fake := (&fakeClusterClient{}).withStatuses(
		api.TrackerStatusRemote, api.TrackerStatusRemote, api.TrackerStatusRemote,
		api.TrackerStatusUnpinned, api.TrackerStatusPinned)
	svc := &PinsAPIServiceSQLite{db: dbsvc, ipfsClusterAPI: fake}

	cidStr := rawTestBlock(t, []byte("mixed-status content")).Cid().String()
	reqID := addActivePin(t, dbsvc, "userA", cidStr, "pinning")

	// Deterministic across many refreshes (the old code was map-order random).
	for i := 0; i < 8; i++ {
		if got := refreshPin(t, svc, "tokenA", reqID); got != PINNED {
			t.Fatalf("refresh %d returned %s, want pinned", i, got)
		}
	}
	rowStatus, _ := pinRow(t, dbsvc, reqID)
	if rowStatus != "pinned" {
		t.Errorf("row status = %q, want pinned persisted", rowStatus)
	}
}

// TestRefresh_RecoversWronglyFailedRow: a row that was wrongly persisted as
// failed (by the old random-peer status) must flip to pinned on the next
// refresh once the cluster holds the content — this is how existing stuck
// rows heal after deploying this fix, with no DB surgery.
func TestRefresh_RecoversWronglyFailedRow(t *testing.T) {
	dbsvc := newTestSQLiteSvc(t)
	seedSession(t, dbsvc, "userA", "tokenA")
	fake := (&fakeClusterClient{}).withStatuses(
		api.TrackerStatusRemote, api.TrackerStatusUnpinned,
		api.TrackerStatusPinned, api.TrackerStatusPinned)
	svc := &PinsAPIServiceSQLite{db: dbsvc, ipfsClusterAPI: fake}

	cidStr := rawTestBlock(t, []byte("stuck content")).Cid().String()
	reqID := addActivePin(t, dbsvc, "userA", cidStr, "failed")

	if got := refreshPin(t, svc, "tokenA", reqID); got != PINNED {
		t.Errorf("refresh returned %s, want pinned (recovery)", got)
	}
	rowStatus, _ := pinRow(t, dbsvc, reqID)
	if rowStatus != "pinned" {
		t.Errorf("row status = %q, want pinned persisted over stale failed", rowStatus)
	}
}
