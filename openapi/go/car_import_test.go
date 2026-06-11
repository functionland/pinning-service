package openapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	format "github.com/ipfs/go-ipld-format"

	merkledag "github.com/ipfs/boxo/ipld/merkledag"
	blocks "github.com/ipfs/go-block-format"
	cid "github.com/ipfs/go-cid"
	cbornode "github.com/ipfs/go-ipld-cbor"
	carv2 "github.com/ipld/go-car/v2"
	carbs "github.com/ipld/go-car/v2/blockstore"
	multihash "github.com/multiformats/go-multihash"
	varint "github.com/multiformats/go-varint"
)

// testCarLimits returns permissive limits for fixtures; individual tests
// tighten specific fields.
func testCarLimits() carImportLimits {
	return carImportLimits{MaxCarBytes: 1 << 30, MaxBlockBytes: 2 << 20, MaxBlocks: 250000}
}

// rawTestBlock builds a raw-codec (0x55) block over data.
func rawTestBlock(t *testing.T, data []byte) blocks.Block {
	t.Helper()
	pref := cid.Prefix{Version: 1, Codec: uint64(cid.Raw), MhType: multihash.SHA2_256, MhLength: -1}
	c, err := pref.Sum(data)
	if err != nil {
		t.Fatalf("raw cid: %v", err)
	}
	b, err := blocks.NewBlockWithCid(data, c)
	if err != nil {
		t.Fatalf("raw block: %v", err)
	}
	return b
}

// pbTestNode builds a dag-pb node carrying data with links to children.
func pbTestNode(t *testing.T, data []byte, children ...blocks.Block) *merkledag.ProtoNode {
	t.Helper()
	nd := merkledag.NodeWithData(data)
	for i, ch := range children {
		if err := nd.AddRawLink(fmt.Sprintf("l%d", i), &format.Link{Cid: ch.Cid()}); err != nil {
			t.Fatalf("AddRawLink: %v", err)
		}
	}
	return nd
}

// writeTestCar writes blocks to a CAR at path (v1 when asV1, else v2+index).
func writeTestCar(t *testing.T, path string, roots []cid.Cid, asV1 bool, blks ...blocks.Block) {
	t.Helper()
	var opts []carv2.Option
	if asV1 {
		opts = append(opts, carv2.WriteAsCarV1(true))
	}
	bs, err := carbs.OpenReadWrite(path, roots, opts...)
	if err != nil {
		t.Fatalf("OpenReadWrite: %v", err)
	}
	for _, b := range blks {
		if err := bs.Put(context.Background(), b); err != nil {
			t.Fatalf("Put: %v", err)
		}
	}
	if err := bs.Finalize(); err != nil {
		t.Fatalf("Finalize: %v", err)
	}
}

// appendCarSection appends one raw section (varint | cid | data) to a CARv1
// file — used to craft duplicate and hash-mismatched sections that the
// blockstore writer would never produce.
func appendCarSection(t *testing.T, path string, c cid.Cid, data []byte) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o666)
	if err != nil {
		t.Fatalf("open for append: %v", err)
	}
	defer f.Close()
	section := append(varint.ToUvarint(uint64(len(c.Bytes())+len(data))), c.Bytes()...)
	section = append(section, data...)
	if _, err := f.Write(section); err != nil {
		t.Fatalf("append section: %v", err)
	}
}

// validCarFixture is the standard 4-block dag-pb tree:
//
//	root ── mid ── leaf1
//	  │      └──── leaf2
//	  └─────────── leaf1   (diamond: leaf1 referenced twice, present once)
type validCarFixture struct {
	path        string
	root        cid.Cid
	blockCount  int64
	uniqueBytes int64
	blocks      []blocks.Block
}

func buildValidCar(t *testing.T, asV1 bool) validCarFixture {
	t.Helper()
	leaf1 := rawTestBlock(t, []byte("dag-import-test leaf one payload"))
	leaf2 := rawTestBlock(t, []byte("dag-import-test leaf two payload, a bit longer"))
	mid := pbTestNode(t, []byte("mid"), leaf1, leaf2)
	root := pbTestNode(t, []byte("root"), mid, leaf1)

	blks := []blocks.Block{root, mid, leaf1, leaf2}
	var unique int64
	for _, b := range blks {
		unique += int64(len(b.RawData()))
	}

	path := filepath.Join(t.TempDir(), "fixture.car")
	writeTestCar(t, path, []cid.Cid{root.Cid()}, asV1, blks...)
	return validCarFixture{path: path, root: root.Cid(), blockCount: int64(len(blks)), uniqueBytes: unique, blocks: blks}
}

func TestValidateCAR_ValidV1(t *testing.T) {
	fx := buildValidCar(t, true)

	stats, err := validateCARFile(context.Background(), fx.path, testCarLimits())
	if err != nil {
		t.Fatalf("validateCARFile: %v", err)
	}
	if !stats.Root.Equals(fx.root) {
		t.Errorf("root = %s, want %s", stats.Root, fx.root)
	}
	if stats.Version != 1 {
		t.Errorf("version = %d, want 1", stats.Version)
	}
	if stats.BlockCount != fx.blockCount {
		t.Errorf("blockCount = %d, want %d", stats.BlockCount, fx.blockCount)
	}
	if stats.UniqueBytes != fx.uniqueBytes {
		t.Errorf("uniqueBytes = %d, want %d", stats.UniqueBytes, fx.uniqueBytes)
	}
}

func TestValidateCAR_DuplicateSectionCountedOnce(t *testing.T) {
	fx := buildValidCar(t, true)
	// Re-append leaf1's section verbatim: still a valid CAR, stats unchanged.
	leaf1 := fx.blocks[2]
	appendCarSection(t, fx.path, leaf1.Cid(), leaf1.RawData())

	stats, err := validateCARFile(context.Background(), fx.path, testCarLimits())
	if err != nil {
		t.Fatalf("validateCARFile: %v", err)
	}
	if stats.BlockCount != fx.blockCount || stats.UniqueBytes != fx.uniqueBytes {
		t.Errorf("duplicate section changed stats: blocks=%d bytes=%d, want %d/%d",
			stats.BlockCount, stats.UniqueBytes, fx.blockCount, fx.uniqueBytes)
	}
}

func TestValidateCAR_ExtraUnreferencedBlockAccepted(t *testing.T) {
	// Present-but-unreferenced blocks are imported but not pinned/billed —
	// documented wart; this locks the "accepted" semantics in.
	leafX := rawTestBlock(t, []byte("unreferenced extra block"))
	fx := buildValidCar(t, true)
	appendCarSection(t, fx.path, leafX.Cid(), leafX.RawData())

	stats, err := validateCARFile(context.Background(), fx.path, testCarLimits())
	if err != nil {
		t.Fatalf("validateCARFile: %v", err)
	}
	if stats.BlockCount != fx.blockCount+1 {
		t.Errorf("blockCount = %d, want %d", stats.BlockCount, fx.blockCount+1)
	}
}

func TestValidateCAR_V2NormalizesToV1(t *testing.T) {
	fx := buildValidCar(t, false) // CARv2 with index

	stats, err := validateCARFile(context.Background(), fx.path, testCarLimits())
	if err != nil {
		t.Fatalf("validateCARFile(v2): %v", err)
	}
	if stats.Version != 2 {
		t.Fatalf("version = %d, want 2", stats.Version)
	}
	if stats.BlockCount != fx.blockCount {
		t.Errorf("blockCount = %d, want %d", stats.BlockCount, fx.blockCount)
	}

	// The data reader must expose a pure CARv1 payload (what the cluster's
	// go-car v0.6.2 requires).
	dr, closeFn, err := openCARDataReader(fx.path, stats.Version)
	if err != nil {
		t.Fatalf("openCARDataReader: %v", err)
	}
	defer closeFn()
	inner, err := carv2.NewBlockReader(dr)
	if err != nil {
		t.Fatalf("reading normalized payload: %v", err)
	}
	if inner.Version != 1 {
		t.Errorf("normalized payload version = %d, want 1", inner.Version)
	}
	n := 0
	for {
		if _, err := inner.Next(); err == io.EOF {
			break
		} else if err != nil {
			t.Fatalf("normalized payload block read: %v", err)
		}
		n++
	}
	if int64(n) != fx.blockCount {
		t.Errorf("normalized payload has %d blocks, want %d", n, fx.blockCount)
	}
}

func TestValidateCAR_MultipleRoots(t *testing.T) {
	a := rawTestBlock(t, []byte("root a"))
	b := rawTestBlock(t, []byte("root b"))
	path := filepath.Join(t.TempDir(), "multiroot.car")
	writeTestCar(t, path, []cid.Cid{a.Cid(), b.Cid()}, true, a, b)

	_, err := validateCARFile(context.Background(), path, testCarLimits())
	if !errors.Is(err, ErrCARMultipleRoots) {
		t.Fatalf("err = %v, want ErrCARMultipleRoots", err)
	}
}

func TestValidateCAR_ZeroRoots(t *testing.T) {
	// The blockstore writer refuses empty roots, so hand-encode the header:
	// varint(len) | dag-cbor {"roots": [], "version": 1}.
	header, err := cbornode.DumpObject(map[string]interface{}{"version": 1, "roots": []cid.Cid{}})
	if err != nil {
		t.Fatalf("encode header: %v", err)
	}
	path := filepath.Join(t.TempDir(), "zeroroots.car")
	if err := os.WriteFile(path, append(varint.ToUvarint(uint64(len(header))), header...), 0o666); err != nil {
		t.Fatalf("write: %v", err)
	}

	_, err = validateCARFile(context.Background(), path, testCarLimits())
	if !errors.Is(err, ErrCARNoRoots) {
		t.Fatalf("err = %v, want ErrCARNoRoots", err)
	}
}

func TestValidateCAR_JunkFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "junk.car")
	if err := os.WriteFile(path, []byte("this is definitely not a CAR file, just some text"), 0o666); err != nil {
		t.Fatalf("write: %v", err)
	}

	_, err := validateCARFile(context.Background(), path, testCarLimits())
	if !errors.Is(err, ErrCARInvalid) {
		t.Fatalf("err = %v, want ErrCARInvalid", err)
	}
}

func TestValidateCAR_CorruptedBlock(t *testing.T) {
	fx := buildValidCar(t, true)
	// A section whose CID does not match its payload must be rejected
	// (BlockReader verifies multihashes by default).
	leaf1 := fx.blocks[2]
	appendCarSection(t, fx.path, leaf1.Cid(), []byte("tampered payload that does not hash to leaf1's cid"))

	_, err := validateCARFile(context.Background(), fx.path, testCarLimits())
	if !errors.Is(err, ErrCARInvalid) {
		t.Fatalf("err = %v, want ErrCARInvalid (hash mismatch)", err)
	}
}

func TestValidateCAR_MissingLeaf(t *testing.T) {
	leaf1 := rawTestBlock(t, []byte("present leaf"))
	leaf2 := rawTestBlock(t, []byte("absent leaf"))
	mid := pbTestNode(t, []byte("mid"), leaf1, leaf2)
	root := pbTestNode(t, []byte("root"), mid)

	path := filepath.Join(t.TempDir(), "incomplete.car")
	writeTestCar(t, path, []cid.Cid{root.Cid()}, true, root, mid, leaf1) // leaf2 omitted

	_, err := validateCARFile(context.Background(), path, testCarLimits())
	if !errors.Is(err, ErrCARIncomplete) {
		t.Fatalf("err = %v, want ErrCARIncomplete", err)
	}
}

func TestValidateCAR_RootBlockAbsent(t *testing.T) {
	leaf1 := rawTestBlock(t, []byte("leaf one"))
	leaf2 := rawTestBlock(t, []byte("leaf two"))
	mid := pbTestNode(t, []byte("mid"), leaf1, leaf2)
	root := pbTestNode(t, []byte("root"), mid)

	path := filepath.Join(t.TempDir(), "rootless.car")
	writeTestCar(t, path, []cid.Cid{root.Cid()}, true, mid, leaf1, leaf2) // root omitted

	_, err := validateCARFile(context.Background(), path, testCarLimits())
	if !errors.Is(err, ErrCARRootMissing) {
		t.Fatalf("err = %v, want ErrCARRootMissing", err)
	}
}

func TestValidateCAR_OversizedBlock(t *testing.T) {
	big := rawTestBlock(t, make([]byte, 2048))
	path := filepath.Join(t.TempDir(), "bigblock.car")
	writeTestCar(t, path, []cid.Cid{big.Cid()}, true, big)

	lim := testCarLimits()
	lim.MaxBlockBytes = 1024
	_, err := validateCARFile(context.Background(), path, lim)
	if !errors.Is(err, ErrCARBlockTooLarge) {
		t.Fatalf("err = %v, want ErrCARBlockTooLarge", err)
	}
}

func TestValidateCAR_TooManyBlocks(t *testing.T) {
	fx := buildValidCar(t, true) // 4 unique blocks

	lim := testCarLimits()
	lim.MaxBlocks = 2
	_, err := validateCARFile(context.Background(), fx.path, lim)
	if !errors.Is(err, ErrCARTooManyBlocks) {
		t.Fatalf("err = %v, want ErrCARTooManyBlocks", err)
	}
}

func TestValidateCAR_UnsupportedCodec(t *testing.T) {
	data := []byte(`{"hello":"dag-json"}`)
	pref := cid.Prefix{Version: 1, Codec: uint64(cid.DagJSON), MhType: multihash.SHA2_256, MhLength: -1}
	c, err := pref.Sum(data)
	if err != nil {
		t.Fatalf("dag-json cid: %v", err)
	}
	b, err := blocks.NewBlockWithCid(data, c)
	if err != nil {
		t.Fatalf("dag-json block: %v", err)
	}
	path := filepath.Join(t.TempDir(), "dagjson.car")
	writeTestCar(t, path, []cid.Cid{b.Cid()}, true, b)

	_, err = validateCARFile(context.Background(), path, testCarLimits())
	if !errors.Is(err, ErrCARUnsupportedCodec) {
		t.Fatalf("err = %v, want ErrCARUnsupportedCodec", err)
	}
}

func TestValidateCAR_DagCborLinksHonored(t *testing.T) {
	leaf := rawTestBlock(t, []byte("cbor-linked leaf"))
	node, err := cbornode.WrapObject(map[string]interface{}{"child": leaf.Cid()}, multihash.SHA2_256, -1)
	if err != nil {
		t.Fatalf("WrapObject: %v", err)
	}

	// Complete: cbor root + leaf → valid.
	okPath := filepath.Join(t.TempDir(), "cbor-ok.car")
	writeTestCar(t, okPath, []cid.Cid{node.Cid()}, true, node, leaf)
	if _, err := validateCARFile(context.Background(), okPath, testCarLimits()); err != nil {
		t.Fatalf("complete dag-cbor CAR rejected: %v", err)
	}

	// The same root without the leaf must be caught by the completeness walk
	// (proves links are extracted from dag-cbor, not just dag-pb).
	badPath := filepath.Join(t.TempDir(), "cbor-bad.car")
	writeTestCar(t, badPath, []cid.Cid{node.Cid()}, true, node)
	_, err = validateCARFile(context.Background(), badPath, testCarLimits())
	if !errors.Is(err, ErrCARIncomplete) {
		t.Fatalf("err = %v, want ErrCARIncomplete", err)
	}
}

func TestOpenCARDataReader_V1PassesThrough(t *testing.T) {
	fx := buildValidCar(t, true)
	want, err := os.ReadFile(fx.path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	dr, closeFn, err := openCARDataReader(fx.path, 1)
	if err != nil {
		t.Fatalf("openCARDataReader: %v", err)
	}
	defer closeFn()
	got, err := io.ReadAll(dr)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got) != len(want) {
		t.Errorf("v1 pass-through changed payload: %d bytes, want %d", len(got), len(want))
	}
}

func TestClusterImportTimeoutBounds(t *testing.T) {
	if d := clusterImportTimeout(0); d != 2*time.Minute {
		t.Errorf("timeout(0) = %v, want 2m", d)
	}
	// 100 MB at 512 KiB/s ≈ 200s on top of the 2m floor.
	if d := clusterImportTimeout(100 << 20); d <= 2*time.Minute || d > 30*time.Minute {
		t.Errorf("timeout(100MB) = %v, want within (2m, 30m]", d)
	}
	if d := clusterImportTimeout(100 << 30); d != 30*time.Minute {
		t.Errorf("timeout(100GB) = %v, want capped at 30m", d)
	}
}
