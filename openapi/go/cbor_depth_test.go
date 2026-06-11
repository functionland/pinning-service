package openapi

import (
	"context"
	"errors"
	"path/filepath"
	"runtime"
	"testing"

	blocks "github.com/ipfs/go-block-format"
	cid "github.com/ipfs/go-cid"
	multihash "github.com/multiformats/go-multihash"
)

// nestedCbor returns `depth` nested single-element CBOR arrays (0x81) wrapping
// a null — the cheapest way to maximize nesting per byte.
func nestedCbor(depth int) []byte {
	b := make([]byte, 0, depth+1)
	for i := 0; i < depth; i++ {
		b = append(b, 0x81)
	}
	return append(b, 0xf6)
}

func TestDagCborWithinDepth(t *testing.T) {
	tests := []struct {
		name    string
		data    []byte
		max     int
		wantErr error
	}{
		{"shallow ok", nestedCbor(10), 1024, nil},
		{"exactly at limit", nestedCbor(8), 8, nil},
		{"one past limit", nestedCbor(9), 8, ErrCARBlockTooDeep},
		{"deep bomb rejected", nestedCbor(100000), 1024, ErrCARBlockTooDeep},
		{"flat null", []byte{0xf6}, 1024, nil},
		{"flat int", []byte{0x01}, 1024, nil},
		{"empty array", []byte{0x80}, 1024, nil},
		{"small map", []byte{0xa1, 0x61, 0x6b, 0x61, 0x76}, 1024, nil}, // {"k":"v"}
		{"truncated", []byte{0x81}, 1024, ErrCARInvalid},               // array(1) with no child
		{"indefinite array forbidden", []byte{0x9f, 0xff}, 1024, ErrCARInvalid},
		{"reserved additional-info", []byte{0x1c}, 1024, ErrCARInvalid},
		{"string length overrun", []byte{0x44, 0x01, 0x02}, 1024, ErrCARInvalid}, // bytes(4) with 2 bytes
		// Huge container headers (no backing bytes) must be rejected as
		// malformed — never accepted, never overflow the scanner.
		{"array count overrun u64max", []byte{0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, 1024, ErrCARInvalid}, // array(2^64-1)
		{"map count overflow on double", []byte{0xbb, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, 1024, ErrCARInvalid}, // map(2^63) → arg*2 would wrap
		{"array count modest but unbacked", []byte{0x9a, 0x00, 0x10, 0x00, 0x00}, 1024, ErrCARInvalid}, // array(1M) with no children
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := dagCborWithinDepth(tt.data, tt.max)
			if tt.wantErr == nil {
				if err != nil {
					t.Fatalf("got error %v, want nil", err)
				}
				return
			}
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("got %v, want errors.Is %v", err, tt.wantErr)
			}
		})
	}
}

// TestDagCborWithinDepth_Cheap proves the guard rejects a 2 MiB nesting bomb
// using a trivial amount of work — the whole point of scanning instead of
// decoding (the eager decode cost ~240 MiB / ~1.7 s in profiling).
func TestDagCborWithinDepth_Cheap(t *testing.T) {
	bomb := nestedCbor(2 << 20) // ~2 MiB of nesting
	var m0, m1 runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&m0)

	err := dagCborWithinDepth(bomb, 1024)

	runtime.ReadMemStats(&m1)
	if !errors.Is(err, ErrCARBlockTooDeep) {
		t.Fatalf("got %v, want ErrCARBlockTooDeep", err)
	}
	allocMiB := float64(m1.TotalAlloc-m0.TotalAlloc) / (1024 * 1024)
	if allocMiB > 5 {
		t.Errorf("guard allocated %.1f MiB rejecting a bomb; expected ~0 (it must abort after ~maxDepth bytes)", allocMiB)
	}
}

// mkDagCborBlock builds a dag-cbor block over data (CID = its real hash, so
// go-car's per-block verification passes).
func mkDagCborBlock(t *testing.T, data []byte) blocks.Block {
	t.Helper()
	pref := cid.Prefix{Version: 1, Codec: uint64(cid.DagCBOR), MhType: multihash.SHA2_256, MhLength: -1}
	c, err := pref.Sum(data)
	if err != nil {
		t.Fatalf("cid: %v", err)
	}
	blk, err := blocks.NewBlockWithCid(data, c)
	if err != nil {
		t.Fatalf("block: %v", err)
	}
	return blk
}

// TestValidateCAR_DeeplyNestedCborRejected: a CAR whose single dag-cbor root is
// nested beyond the limit is rejected with ErrCARBlockTooDeep, before the
// expensive decode.
func TestValidateCAR_DeeplyNestedCborRejected(t *testing.T) {
	blk := mkDagCborBlock(t, nestedCbor(5000)) // no links → completeness trivially ok if it got that far
	path := filepath.Join(t.TempDir(), "deep.car")
	writeTestCar(t, path, []cid.Cid{blk.Cid()}, true, blk)

	lim := testCarLimits()
	lim.MaxDagDepth = 1024
	_, err := validateCARFile(context.Background(), path, lim)
	if !errors.Is(err, ErrCARBlockTooDeep) {
		t.Fatalf("err = %v, want ErrCARBlockTooDeep", err)
	}
}

// TestValidateCAR_DepthGuardDisabled: MaxDagDepth=0 turns the guard off (the
// block then decodes normally — still valid, just unguarded).
func TestValidateCAR_DepthGuardDisabled(t *testing.T) {
	blk := mkDagCborBlock(t, nestedCbor(5000))
	path := filepath.Join(t.TempDir(), "deep-unguarded.car")
	writeTestCar(t, path, []cid.Cid{blk.Cid()}, true, blk)

	lim := testCarLimits()
	lim.MaxDagDepth = 0
	if _, err := validateCARFile(context.Background(), path, lim); err != nil {
		t.Fatalf("with guard disabled a 5000-deep block should still validate, got %v", err)
	}
}

// Sanity: a normal shallow dag-cbor CAR (the existing links fixture depth) is
// unaffected by the guard. (Complements TestValidateCAR_DagCborLinksHonored.)
func TestValidateCAR_ShallowCborPassesGuard(t *testing.T) {
	leaf := rawTestBlock(t, []byte("leaf"))
	node := mkDagCborBlock(t, func() []byte {
		// {"child": <cid>} — depth 2, well under the limit.
		b := []byte{0xa1, 0x65, 'c', 'h', 'i', 'l', 'd', 0xd8, 0x2a}
		cb := append([]byte{0x00}, leaf.Cid().Bytes()...)
		b = append(b, 0x58, byte(len(cb)))
		return append(b, cb...)
	}())
	path := filepath.Join(t.TempDir(), "shallow.car")
	writeTestCar(t, path, []cid.Cid{node.Cid()}, true, node, leaf)

	if _, err := validateCARFile(context.Background(), path, testCarLimits()); err != nil {
		t.Fatalf("shallow dag-cbor CAR rejected by guard: %v", err)
	}
}
