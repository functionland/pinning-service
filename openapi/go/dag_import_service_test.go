package openapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ipfs-cluster/ipfs-cluster/api"
	clusterapi "github.com/ipfs-cluster/ipfs-cluster/api/rest/client"
	files "github.com/ipfs/boxo/files"
	cid "github.com/ipfs/go-cid"
)

// fakeClusterClient implements just enough of clusterapi.Client for ImportDag:
// AddMultiFile drains the multipart stream, optionally fails, and emits the
// configured root — honoring the real client's contract (it closes out itself).
type fakeClusterClient struct {
	clusterapi.Client // embed: unimplemented methods panic if called

	mu            sync.Mutex
	addCalls      int
	failAdd       bool
	rootToEmit    cid.Cid
	lastFormat    string
	lastName      string
	receivedBytes int64
}

func (f *fakeClusterClient) AddMultiFile(ctx context.Context, mfr *files.MultiFileReader, params api.AddParams, out chan<- api.AddedOutput) error {
	defer close(out)

	// Replicate the cluster's FromMultipart + carAdder.Add EXACTLY (adder.go
	// in ipfs-cluster v1.1.1): boxo's part reader treats part filenames as
	// paths ('/' creates nested directories), and the first entry must be a
	// plain file. A naive multipart drain here would miss framing bugs that
	// the real cluster rejects — as production did with base64 pin names.
	mpr := multipart.NewReader(mfr, mfr.Boundary())
	dir, err := files.NewFileFromPartReader(mpr, "multipart/form-data")
	if err != nil {
		return fmt.Errorf("fake cluster: bad multipart: %w", err)
	}
	defer dir.Close()
	it := dir.Entries()
	if !it.Next() {
		return errors.New("fake cluster: empty multipart")
	}
	file, ok := it.Node().(files.File)
	if !ok {
		return errors.New("expected CAR file is not of type file")
	}
	payloadBytes, _ := io.Copy(io.Discard, file)

	f.mu.Lock()
	f.addCalls++
	f.lastFormat = params.Format
	f.lastName = params.Name
	f.receivedBytes = payloadBytes
	fail := f.failAdd
	root := f.rootToEmit
	f.mu.Unlock()

	if fail {
		return errors.New("fake cluster add failure")
	}
	out <- api.AddedOutput{Name: params.Name, Cid: api.NewCid(root)}
	return nil
}

func (f *fakeClusterClient) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.addCalls
}

// fakeKubo serves POST /api/v0/dag/stat with a fixed TotalSize (or a 500).
func fakeKubo(t *testing.T, totalSize int64, fail bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			http.Error(w, "dag stat broken", http.StatusInternalServerError)
			return
		}
		fmt.Fprintf(w, `{"TotalSize": %d}`, totalSize)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newImportTestEnv wires a SQLite-backed service with a fake cluster client
// and fake kubo, and seeds a session userA/tokenA.
func newImportTestEnv(t *testing.T, fake *fakeClusterClient, kuboURL string) (*PinsAPIServiceSQLite, *SQLiteService) {
	t.Helper()
	dbsvc := newTestSQLiteSvc(t)
	if _, err := dbsvc.db.ExecContext(context.Background(),
		"INSERT INTO sessions (username, session_token) VALUES (?, ?)", "userA", "tokenA"); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	svc := &PinsAPIServiceSQLite{db: dbsvc, ipfsClusterAPI: fake, ipfsHTTPURL: kuboURL}
	return svc, dbsvc
}

// sacrificialCopy copies the fixture to a path the service may delete.
func sacrificialCopy(t *testing.T, fixturePath string) string {
	t.Helper()
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	path := filepath.Join(t.TempDir(), "upload.car")
	if err := os.WriteFile(path, data, 0o666); err != nil {
		t.Fatalf("copy fixture: %v", err)
	}
	return path
}

// importDone returns an onDone callback and a wait func that fails the test
// if the import lifecycle doesn't finish in time.
func importDone(t *testing.T) (func(), func()) {
	t.Helper()
	done := make(chan struct{})
	return func() { close(done) }, func() {
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Fatal("import lifecycle did not finish (onDone not called)")
		}
	}
}

func pinRow(t *testing.T, dbsvc *SQLiteService, requestID string) (status string, size int64) {
	t.Helper()
	err := dbsvc.db.QueryRowContext(context.Background(),
		"SELECT status, size FROM pins WHERE requestid = ?", requestID).Scan(&status, &size)
	if err != nil {
		t.Fatalf("query pin row %s: %v", requestID, err)
	}
	return status, size
}

// TestImportDag_QuotaCounted is THE core requirement: an imported DAG must be
// pinned through the normal lifecycle and its size must land in pins.size so
// storage/credit accounting picks it up automatically.
func TestImportDag_QuotaCounted(t *testing.T) {
	fx := buildValidCar(t, true)
	const dagStatSize = int64(4242)

	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, dagStatSize, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	carPath := sacrificialCopy(t, fx.path)
	carSize := int64(len(mustRead(t, fx.path)))
	onDone, wait := importDone(t)

	resp, err := svc.ImportDag(authCtx("tokenA"), carPath, "my import", onDone)
	if err != nil {
		t.Fatalf("ImportDag: %v", err)
	}
	if resp.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202", resp.Code)
	}
	status, ok := resp.Body.(PinStatus)
	if !ok {
		t.Fatalf("body type = %T, want PinStatus", resp.Body)
	}
	if status.Pin.Cid != fx.root.String() {
		t.Errorf("pin cid = %s, want %s", status.Pin.Cid, fx.root)
	}
	if status.Pin.Meta["source"] != "car_import" {
		t.Errorf("meta source = %q, want car_import", status.Pin.Meta["source"])
	}

	wait()

	// Async import completed: cluster got the CAR, row advanced, size landed.
	if fake.calls() != 1 {
		t.Errorf("cluster add calls = %d, want 1", fake.calls())
	}
	if fake.lastFormat != "car" {
		t.Errorf("cluster add format = %q, want car", fake.lastFormat)
	}
	if fake.receivedBytes != carSize {
		t.Errorf("cluster received %d bytes, want %d (whole v1 CAR)", fake.receivedBytes, carSize)
	}
	rowStatus, rowSize := pinRow(t, dbsvc, status.Requestid)
	if rowStatus != "pinning" {
		t.Errorf("row status = %q, want pinning", rowStatus)
	}
	if rowSize != dagStatSize {
		t.Errorf("row size = %d, want %d (dag/stat)", rowSize, dagStatSize)
	}

	// Quota accounting is automatic: both the storage sum and the credit
	// gatekeeper must now see the imported bytes.
	usage, err := dbsvc.GetStorageByUser(context.Background(), "userA")
	if err != nil {
		t.Fatalf("GetStorageByUser: %v", err)
	}
	if usage.TotalSize != dagStatSize {
		t.Errorf("GetStorageByUser = %d, want %d", usage.TotalSize, dagStatSize)
	}
	credit, err := dbsvc.GetCreditStatus(context.Background(), "userA")
	if err != nil {
		t.Fatalf("GetCreditStatus: %v", err)
	}
	if credit.CurrentBytes != dagStatSize {
		t.Errorf("GetCreditStatus.CurrentBytes = %d, want %d", credit.CurrentBytes, dagStatSize)
	}

	// The service owned the temp CAR and must have removed it.
	if _, err := os.Stat(carPath); !os.IsNotExist(err) {
		t.Errorf("temp CAR still exists after import (stat err=%v)", err)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
}

// TestImportDag_NameWithSlashes: client-side-encrypted pin names are standard
// base64 and routinely contain '/'. The multipart filename must NOT be
// derived from the name — boxo's path-splitting parser on the cluster side
// would see a nested directory and reject the add with "expected CAR file is
// not of type file" (the first production failure). The pin name must still
// reach the cluster via params.Name.
func TestImportDag_NameWithSlashes(t *testing.T) {
	fx := buildValidCar(t, true)
	const dagStatSize = int64(2024)

	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, dagStatSize, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	encryptedish := "xK9/2bQ+frL/Aw==" // base64-like, slashes included
	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), sacrificialCopy(t, fx.path), encryptedish, onDone)
	if err != nil {
		t.Fatalf("ImportDag: %v", err)
	}
	if resp.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202", resp.Code)
	}
	status := resp.Body.(PinStatus)
	wait()

	rowStatus, rowSize := pinRow(t, dbsvc, status.Requestid)
	if rowStatus != "pinning" || rowSize != dagStatSize {
		t.Errorf("row = (%s, %d), want (pinning, %d) — slashed name must not break the cluster add", rowStatus, rowSize, dagStatSize)
	}
	if fake.calls() != 1 {
		t.Errorf("cluster add calls = %d, want 1", fake.calls())
	}
	if fake.lastName != encryptedish {
		t.Errorf("cluster pin name = %q, want %q (must travel via params.Name)", fake.lastName, encryptedish)
	}
}

// TestImportDag_SizeFallback: if dag/stat is unavailable the validated
// unique-bytes sum is used — quota is never silently zero.
func TestImportDag_SizeFallback(t *testing.T) {
	fx := buildValidCar(t, true)

	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, 0, true) // dag/stat 500s
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), sacrificialCopy(t, fx.path), "", onDone)
	if err != nil {
		t.Fatalf("ImportDag: %v", err)
	}
	status := resp.Body.(PinStatus)
	wait()

	_, rowSize := pinRow(t, dbsvc, status.Requestid)
	if rowSize != fx.uniqueBytes {
		t.Errorf("fallback size = %d, want validated unique bytes %d", rowSize, fx.uniqueBytes)
	}
}

// TestImportDag_DedupAlreadyPinned: an actively pinned CID is returned as-is
// (200), no import is performed, and the temp CAR is cleaned up.
func TestImportDag_DedupAlreadyPinned(t *testing.T) {
	fx := buildValidCar(t, true)

	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, 1234, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	existingReq := addActivePin(t, dbsvc, "userA", fx.root.String(), "pinned")

	carPath := sacrificialCopy(t, fx.path)
	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), carPath, "", onDone)
	if err != nil {
		t.Fatalf("ImportDag: %v", err)
	}
	wait() // sync path must still fire onDone

	if resp.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", resp.Code)
	}
	if got := resp.Body.(PinStatus).Requestid; got != existingReq {
		t.Errorf("requestid = %s, want existing %s", got, existingReq)
	}
	if fake.calls() != 0 {
		t.Errorf("cluster add calls = %d, want 0 (dedup skips import)", fake.calls())
	}
	if _, err := os.Stat(carPath); !os.IsNotExist(err) {
		t.Errorf("temp CAR not cleaned up on dedup path")
	}
}

// TestImportDag_HealsStuckPin: a failed/stuck row for the same CID is reused
// and the import supplies the blocks.
func TestImportDag_HealsStuckPin(t *testing.T) {
	fx := buildValidCar(t, true)
	const dagStatSize = int64(9999)

	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, dagStatSize, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	stuckReq := addActivePin(t, dbsvc, "userA", fx.root.String(), "failed")

	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), sacrificialCopy(t, fx.path), "", onDone)
	if err != nil {
		t.Fatalf("ImportDag: %v", err)
	}
	if resp.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202", resp.Code)
	}
	if got := resp.Body.(PinStatus).Requestid; got != stuckReq {
		t.Errorf("requestid = %s, want reused %s", got, stuckReq)
	}
	wait()

	if fake.calls() != 1 {
		t.Errorf("cluster add calls = %d, want 1 (heal re-imports)", fake.calls())
	}
	rowStatus, rowSize := pinRow(t, dbsvc, stuckReq)
	if rowStatus != "pinning" || rowSize != dagStatSize {
		t.Errorf("healed row = (%s, %d), want (pinning, %d)", rowStatus, rowSize, dagStatSize)
	}
}

// TestImportDag_ClusterFailure: a cluster add error marks the pin failed and
// the temp CAR is removed.
func TestImportDag_ClusterFailure(t *testing.T) {
	fx := buildValidCar(t, true)

	fake := &fakeClusterClient{rootToEmit: fx.root, failAdd: true}
	kubo := fakeKubo(t, 1, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	carPath := sacrificialCopy(t, fx.path)
	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), carPath, "", onDone)
	if err != nil {
		t.Fatalf("ImportDag: %v", err)
	}
	status := resp.Body.(PinStatus)
	wait()

	rowStatus, _ := pinRow(t, dbsvc, status.Requestid)
	if rowStatus != "failed" {
		t.Errorf("row status = %q, want failed", rowStatus)
	}
	if _, err := os.Stat(carPath); !os.IsNotExist(err) {
		t.Errorf("temp CAR not cleaned up after cluster failure")
	}
}

// TestImportDag_RootMismatch: cluster returning a different root than the CAR
// header is treated as a failed import.
func TestImportDag_RootMismatch(t *testing.T) {
	fx := buildValidCar(t, true)
	otherRoot := rawTestBlock(t, []byte("a different root entirely")).Cid()

	fake := &fakeClusterClient{rootToEmit: otherRoot}
	kubo := fakeKubo(t, 1, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), sacrificialCopy(t, fx.path), "", onDone)
	if err != nil {
		t.Fatalf("ImportDag: %v", err)
	}
	status := resp.Body.(PinStatus)
	wait()

	rowStatus, _ := pinRow(t, dbsvc, status.Requestid)
	if rowStatus != "failed" {
		t.Errorf("row status = %q, want failed (root mismatch)", rowStatus)
	}
}

// TestImportDag_InvalidCar: validation failures are 400s, the temp file is
// removed, and nothing reaches the cluster.
func TestImportDag_InvalidCar(t *testing.T) {
	fake := &fakeClusterClient{}
	kubo := fakeKubo(t, 1, false)
	svc, _ := newImportTestEnv(t, fake, kubo.URL)

	junkPath := filepath.Join(t.TempDir(), "junk.car")
	if err := os.WriteFile(junkPath, []byte("not a car"), 0o666); err != nil {
		t.Fatalf("write junk: %v", err)
	}

	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), junkPath, "", onDone)
	wait()

	if err == nil || resp.Code != http.StatusBadRequest {
		t.Fatalf("code = %d (err=%v), want 400", resp.Code, err)
	}
	if fake.calls() != 0 {
		t.Errorf("cluster add calls = %d, want 0", fake.calls())
	}
	if _, statErr := os.Stat(junkPath); !os.IsNotExist(statErr) {
		t.Errorf("temp CAR not cleaned up on validation failure")
	}
}

// TestImportDag_Unauthorized: no bearer → 401, temp removed, onDone called.
func TestImportDag_Unauthorized(t *testing.T) {
	fx := buildValidCar(t, true)
	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, 1, false)
	svc, _ := newImportTestEnv(t, fake, kubo.URL)

	carPath := sacrificialCopy(t, fx.path)
	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(context.Background(), carPath, "", onDone)
	wait()

	if err == nil || resp.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d (err=%v), want 401", resp.Code, err)
	}
	if _, statErr := os.Stat(carPath); !os.IsNotExist(statErr) {
		t.Errorf("temp CAR not cleaned up on auth failure")
	}
}

// TestImportDag_402_StrictPreflight: a free-tier user (zero FULA balance)
// whose import would cross the free-tier boundary is rejected up front —
// stricter than pin-by-CID, where the size is unknown until after pinning.
func TestImportDag_402_StrictPreflight(t *testing.T) {
	fx := buildValidCar(t, true)
	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, 1, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	// Park the user just below the free tier: still CanUpload, but any
	// non-trivial import would cross the boundary with no credits.
	filler := addActivePin(t, dbsvc, "userA", "cidFiller", "pinned")
	if err := dbsvc.UpdatePinSize(context.Background(), filler, DefaultFreeTierBytes-10); err != nil {
		t.Fatalf("UpdatePinSize: %v", err)
	}

	carPath := sacrificialCopy(t, fx.path)
	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), carPath, "", onDone)
	wait()

	if err == nil || resp.Code != http.StatusPaymentRequired {
		t.Fatalf("code = %d (err=%v), want 402", resp.Code, err)
	}
	if fake.calls() != 0 {
		t.Errorf("cluster add calls = %d, want 0", fake.calls())
	}
	if _, statErr := os.Stat(carPath); !os.IsNotExist(statErr) {
		t.Errorf("temp CAR not cleaned up on 402 path")
	}
}

// seedCredits creates the user_credits table (the sqlite test schema doesn't
// ship it) and inserts a balance row, so GetCreditStatus sees a real balance
// instead of its fail-open default.
func seedCredits(t *testing.T, dbsvc *SQLiteService, userEmail string, balance float64) {
	t.Helper()
	ctx := context.Background()
	if _, err := dbsvc.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS user_credits (
			user_email TEXT,
			balance_fula REAL DEFAULT 0,
			is_suspended INTEGER DEFAULT 0
		)`); err != nil {
		t.Fatalf("create user_credits: %v", err)
	}
	if _, err := dbsvc.db.ExecContext(ctx,
		"INSERT INTO user_credits (user_email, balance_fula) VALUES (?, ?)", userEmail, balance); err != nil {
		t.Fatalf("seed credits: %v", err)
	}
}

// parkUserOverFreeTier seeds an existing pinned row that puts the user's
// storage at free tier + extraBytes.
func parkUserOverFreeTier(t *testing.T, dbsvc *SQLiteService, user string, extraBytes int64) {
	t.Helper()
	filler := addActivePin(t, dbsvc, user, "cidFiller", "pinned")
	if err := dbsvc.UpdatePinSize(context.Background(), filler, DefaultFreeTierBytes+extraBytes); err != nil {
		t.Fatalf("UpdatePinSize: %v", err)
	}
}

// TestImportDag_402_InsufficientProjectedBalance: a paid user whose balance
// cannot fund the projected post-import storage for the configured horizon is
// rejected up front — a dust balance must not buy an 800MB import that would
// suspend the account hours later with the data already pinned.
func TestImportDag_402_InsufficientProjectedBalance(t *testing.T) {
	fx := buildValidCar(t, true)
	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, 1, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	// 10 GiB over the free tier → at 3 FULA/GB-month and a 30-day horizon the
	// import requires ≈30 FULA; the user has only dust.
	parkUserOverFreeTier(t, dbsvc, "userA", 10<<30)
	seedCredits(t, dbsvc, "userA", 0.5)

	carPath := sacrificialCopy(t, fx.path)
	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), carPath, "", onDone)
	wait()

	if err == nil || resp.Code != http.StatusPaymentRequired {
		t.Fatalf("code = %d (err=%v), want 402", resp.Code, err)
	}
	failure, ok := resp.Body.(Failure)
	if !ok {
		t.Fatalf("body type = %T, want Failure", resp.Body)
	}
	if !strings.Contains(failure.Error.Details, "requires at least") {
		t.Errorf("details = %q, want projected-balance message", failure.Error.Details)
	}
	if fake.calls() != 0 {
		t.Errorf("cluster add calls = %d, want 0", fake.calls())
	}
	if _, statErr := os.Stat(carPath); !os.IsNotExist(statErr) {
		t.Errorf("temp CAR not cleaned up on projected-balance 402")
	}
}

// TestImportDag_ProjectedBalanceSufficient: the same projection passes when
// the balance covers the horizon — paid users with real balances import fine.
func TestImportDag_ProjectedBalanceSufficient(t *testing.T) {
	fx := buildValidCar(t, true)
	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, 1234, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	parkUserOverFreeTier(t, dbsvc, "userA", 10<<30)
	seedCredits(t, dbsvc, "userA", 50) // ≈30 FULA required

	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), sacrificialCopy(t, fx.path), "", onDone)
	if err != nil {
		t.Fatalf("ImportDag: %v", err)
	}
	if resp.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202", resp.Code)
	}
	wait()
	if fake.calls() != 1 {
		t.Errorf("cluster add calls = %d, want 1", fake.calls())
	}
}

// TestImportDag_ProjectedBalanceDisabled: DAG_IMPORT_MIN_BALANCE_DAYS=0 turns
// the projection off — any positive balance suffices (pre-existing behavior).
func TestImportDag_ProjectedBalanceDisabled(t *testing.T) {
	t.Setenv("DAG_IMPORT_MIN_BALANCE_DAYS", "0")

	fx := buildValidCar(t, true)
	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, 1234, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	parkUserOverFreeTier(t, dbsvc, "userA", 10<<30)
	seedCredits(t, dbsvc, "userA", 0.5) // dust, but the check is disabled

	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), sacrificialCopy(t, fx.path), "", onDone)
	if err != nil {
		t.Fatalf("ImportDag: %v", err)
	}
	if resp.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202", resp.Code)
	}
	wait()
}

// TestImportDag_402_OverFreeTier: a user already over the free tier with no
// balance is blocked by the regular credit gate.
func TestImportDag_402_OverFreeTier(t *testing.T) {
	fx := buildValidCar(t, true)
	fake := &fakeClusterClient{rootToEmit: fx.root}
	kubo := fakeKubo(t, 1, false)
	svc, dbsvc := newImportTestEnv(t, fake, kubo.URL)

	filler := addActivePin(t, dbsvc, "userA", "cidFiller", "pinned")
	if err := dbsvc.UpdatePinSize(context.Background(), filler, DefaultFreeTierBytes+10); err != nil {
		t.Fatalf("UpdatePinSize: %v", err)
	}

	onDone, wait := importDone(t)
	resp, err := svc.ImportDag(authCtx("tokenA"), sacrificialCopy(t, fx.path), "", onDone)
	wait()

	if err == nil || resp.Code != http.StatusPaymentRequired {
		t.Fatalf("code = %d (err=%v), want 402", resp.Code, err)
	}
}
