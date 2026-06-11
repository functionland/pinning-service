package openapi

// DAG import (CAR upload) support — vendor extension to the IPFS Pinning
// Service API. The official spec is pin-by-CID only; importing a CAR is how a
// user pins data that exists nowhere on the IPFS network yet. The CAR is
// validated here (single root, per-block hash integrity, codec allowlist,
// completeness) and then handed to ipfs-cluster's /add?format=car, which
// places the blocks on allocated peers and cluster-pins the root with the
// configured replication factor.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ipfs-cluster/ipfs-cluster/api"
	clusterapi "github.com/ipfs-cluster/ipfs-cluster/api/rest/client"
	files "github.com/ipfs/boxo/files"
	merkledag "github.com/ipfs/boxo/ipld/merkledag"
	cid "github.com/ipfs/go-cid"
	ipldlegacy "github.com/ipfs/go-ipld-legacy"
	carv2 "github.com/ipld/go-car/v2"
	dagpb "github.com/ipld/go-codec-dagpb"
	"github.com/ipld/go-ipld-prime/codec/dagcbor"
	"github.com/ipld/go-ipld-prime/codec/raw"
	cidlink "github.com/ipld/go-ipld-prime/linking/cid"
	"github.com/ipld/go-ipld-prime/multicodec"
	"github.com/ipld/go-ipld-prime/node/basicnode"
	multihash "github.com/multiformats/go-multihash"
)

// Sentinel errors mapped to user-facing 400 details by the services.
var (
	ErrCARInvalid          = errors.New("invalid CAR file")
	ErrCARNoRoots          = errors.New("CAR file has no root CID")
	ErrCARMultipleRoots    = errors.New("CAR file has multiple roots; only single-root CARs can be imported")
	ErrCARRootMissing      = errors.New("CAR file does not contain the root block")
	ErrCARIncomplete       = errors.New("CAR file is missing blocks referenced by the DAG")
	ErrCARBlockTooLarge    = errors.New("CAR file contains a block larger than the maximum allowed size")
	ErrCARTooManyBlocks    = errors.New("CAR file contains too many blocks")
	ErrCARUnsupportedCodec = errors.New("CAR file contains a block with an unsupported codec")
)

// importDecoder mirrors the exact decoder registry ipfs-cluster's CAR adder
// builds (adder/adder.go init in ipfs-cluster v1.1.1): raw, dag-pb and
// dag-cbor only. Validation passing here guarantees the cluster can decode
// every block we forward.
var importDecoder *ipldlegacy.Decoder

func init() {
	mcReg := multicodec.Registry{}
	mcReg.RegisterDecoder(cid.DagProtobuf, dagpb.Decode)
	mcReg.RegisterDecoder(cid.Raw, raw.Decode)
	mcReg.RegisterDecoder(cid.DagCBOR, dagcbor.Decode)
	ls := cidlink.LinkSystemUsingMulticodecRegistry(mcReg)

	importDecoder = ipldlegacy.NewDecoderWithLS(ls)
	importDecoder.RegisterCodec(cid.DagProtobuf, dagpb.Type.PBNode, merkledag.ProtoNodeConverter)
	importDecoder.RegisterCodec(cid.Raw, basicnode.Prototype.Bytes, merkledag.RawNodeConverter)
}

// dagImportEnabled gates the whole feature (route returns 404 when off).
func dagImportEnabled() bool {
	v := strings.ToLower(os.Getenv("DAG_IMPORT_ENABLED"))
	return v == "true" || v == "1"
}

type carImportLimits struct {
	MaxCarBytes   int64 // whole-file cap (413)
	MaxBlockBytes int64 // per-block cap; blocks above the bitswap limit are unservable
	MaxBlocks     int64 // unique-block cap; also bounds validator memory
}

func envInt64(name string, def int64) int64 {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func carImportLimitsFromEnv() carImportLimits {
	return carImportLimits{
		MaxCarBytes:   envInt64("DAG_IMPORT_MAX_CAR_BYTES", 838860800), // 800 MB
		MaxBlockBytes: envInt64("DAG_IMPORT_MAX_BLOCK_BYTES", 2097152), // 2 MiB (bitswap limit)
		MaxBlocks:     envInt64("DAG_IMPORT_MAX_BLOCKS", 250000),
	}
}

// dagImportSpoolDir returns the directory CAR uploads are spooled to and
// makes sure it exists. Defaults to the OS temp dir; override with
// DAG_IMPORT_TMP_DIR when the service runs under systemd hardening
// (ProtectSystem=strict makes /tmp read-only unless the unit also sets
// PrivateTmp=true or whitelists a path via ReadWritePaths).
func dagImportSpoolDir() (string, error) {
	dir := os.Getenv("DAG_IMPORT_TMP_DIR")
	if dir == "" {
		return os.TempDir(), nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func envFloat(name string, def float64) float64 {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 {
		return def
	}
	return f
}

// dagImportRequiredBalance returns the minimum FULA balance required to accept
// an import that adds carSize bytes, plus the funding horizon used.
//
// Storage is billed as an hourly burn (FULA_PER_GB_MONTH × billable GB / 720,
// see pinning-webui's deductionJob), never as an upfront charge — so "enough
// balance to store it" is necessarily time-based: the balance must keep the
// PROJECTED over-free-tier storage funded for DAG_IMPORT_MIN_BALANCE_DAYS
// days. Unlike pin-by-CID (size unknown until after pinning), the upload size
// is known here, so this can be enforced before accepting the data. The CAR
// file size slightly overestimates the stored DAG size (framing overhead),
// which errs on the side of rejection.
//
// Returns required == 0 when the projection stays inside the free tier or the
// check is disabled (DAG_IMPORT_MIN_BALANCE_DAYS=0).
func dagImportRequiredBalance(currentBytes, carSize, freeTierBytes int64) (required float64, days float64) {
	days = envFloat("DAG_IMPORT_MIN_BALANCE_DAYS", 30)
	if days <= 0 {
		return 0, days
	}
	// Keep in sync with the webui deduction job's FULA_PER_GB_MONTH.
	rate := envFloat("FULA_PER_GB_MONTH", 3)
	billable := currentBytes + carSize - freeTierBytes
	if billable <= 0 {
		return 0, days
	}
	gb := float64(billable) / (1024 * 1024 * 1024) // GiB, matching the deduction job
	return gb * rate * days / 30, days
}

// importSlots bounds concurrent imports (temp disk and CPU amplification).
var (
	importSlotsOnce sync.Once
	importSlots     chan struct{}
)

// acquireImportSlot reserves a concurrent-import slot. It returns a release
// function and whether a slot was available (false → respond 429).
func acquireImportSlot() (func(), bool) {
	importSlotsOnce.Do(func() {
		importSlots = make(chan struct{}, envInt64("DAG_IMPORT_MAX_CONCURRENT", 2))
	})
	select {
	case importSlots <- struct{}{}:
		return func() { <-importSlots }, true
	default:
		return func() {}, false
	}
}

// CARStats summarizes a validated CAR.
type CARStats struct {
	Root        cid.Cid
	Version     uint64 // 1 or 2
	BlockCount  int64  // unique blocks
	UniqueBytes int64  // sum of unique block payload sizes (≈ dag/stat TotalSize for a complete DAG)
}

// validateCARFile makes a single streaming pass over the CAR at path:
// exactly one root, every block hash-verified (BlockReader default), size and
// count caps, codec allowlist identical to the cluster adder, and a DAG
// completeness check (every CID referenced by any block must be present as a
// block — otherwise the cluster pin would hang forever fetching blocks that
// may exist nowhere). Identity-multihash links are inline data and skipped.
func validateCARFile(ctx context.Context, path string, lim carImportLimits) (*CARStats, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Allow sections a bit above the block cap so oversized blocks surface as
	// our friendly error below; truly huge sections still abort the read with
	// bounded memory.
	br, err := carv2.NewBlockReader(bufio.NewReaderSize(f, 1<<20),
		carv2.MaxAllowedSectionSize(uint64(2*lim.MaxBlockBytes)+1024))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCARInvalid, err)
	}

	if len(br.Roots) == 0 {
		return nil, ErrCARNoRoots
	}
	if len(br.Roots) > 1 {
		return nil, fmt.Errorf("%w (%d roots)", ErrCARMultipleRoots, len(br.Roots))
	}
	root := br.Roots[0]

	stats := &CARStats{Root: root, Version: br.Version}
	seen := make(map[cid.Cid]struct{})
	links := make(map[cid.Cid]struct{})

	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		blk, err := br.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			// Section larger than the allowed maximum is an oversized block;
			// anything else (truncation, hash mismatch, bad varint) is invalid.
			if strings.Contains(err.Error(), "malformed car; header is bigger than") ||
				strings.Contains(err.Error(), "invalid section data") {
				return nil, fmt.Errorf("%w (max %d bytes)", ErrCARBlockTooLarge, lim.MaxBlockBytes)
			}
			return nil, fmt.Errorf("%w: %v", ErrCARInvalid, err)
		}

		c := blk.Cid()
		if _, dup := seen[c]; dup {
			continue // duplicate section; count once
		}

		data := blk.RawData()
		if int64(len(data)) > lim.MaxBlockBytes {
			return nil, fmt.Errorf("%w (block %s is %d bytes, max %d)", ErrCARBlockTooLarge, c, len(data), lim.MaxBlockBytes)
		}

		codec := c.Prefix().Codec
		switch codec {
		case uint64(cid.Raw), uint64(cid.DagProtobuf), uint64(cid.DagCBOR):
		default:
			return nil, fmt.Errorf("%w (codec 0x%x in block %s; supported: raw, dag-pb, dag-cbor)", ErrCARUnsupportedCodec, codec, c)
		}

		nd, err := importDecoder.DecodeNode(ctx, blk)
		if err != nil {
			return nil, fmt.Errorf("%w: block %s does not decode as its codec: %v", ErrCARInvalid, c, err)
		}
		for _, l := range nd.Links() {
			if l == nil || !l.Cid.Defined() {
				continue
			}
			if l.Cid.Prefix().MhType == multihash.IDENTITY {
				continue // inline block, nothing to fetch
			}
			links[l.Cid] = struct{}{}
		}
		// A complete single-root CAR cannot reference more unique CIDs than it
		// has blocks; bail early so a hostile CAR can't grow this map unbounded.
		if int64(len(links)) > lim.MaxBlocks {
			return nil, fmt.Errorf("%w (more than %d unique blocks referenced)", ErrCARTooManyBlocks, lim.MaxBlocks)
		}

		seen[c] = struct{}{}
		stats.BlockCount++
		stats.UniqueBytes += int64(len(data))
		if stats.BlockCount > lim.MaxBlocks {
			return nil, fmt.Errorf("%w (max %d)", ErrCARTooManyBlocks, lim.MaxBlocks)
		}
	}

	if _, ok := seen[root]; !ok {
		return nil, fmt.Errorf("%w (root %s)", ErrCARRootMissing, root)
	}

	missing := 0
	var firstMissing cid.Cid
	for l := range links {
		if _, ok := seen[l]; !ok {
			if missing == 0 {
				firstMissing = l
			}
			missing++
		}
	}
	if missing > 0 {
		return nil, fmt.Errorf("%w (%d missing, first: %s)", ErrCARIncomplete, missing, firstMissing)
	}

	return stats, nil
}

// openCARDataReader returns a reader over the CARv1 payload of the file at
// path. CARv2 files are unwrapped to their inner v1 payload (the cluster's
// go-car v0.6.2 rejects version 2); v1 files are returned as-is. The returned
// close function must be called when done.
func openCARDataReader(path string, version uint64) (io.Reader, func() error, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	if version != 2 {
		return f, f.Close, nil
	}
	v2r, err := carv2.NewReader(f)
	if err != nil {
		f.Close()
		return nil, nil, fmt.Errorf("%w: %v", ErrCARInvalid, err)
	}
	dr, err := v2r.DataReader()
	if err != nil {
		f.Close()
		return nil, nil, fmt.Errorf("%w: %v", ErrCARInvalid, err)
	}
	return dr, f.Close, nil
}

// addCARToCluster streams the (v1-normalized) CAR to ipfs-cluster's
// /add?format=car, which imports the blocks to the allocated peers and
// cluster-pins the single root. The returned root is verified against
// expectedRoot.
func addCARToCluster(ctx context.Context, client clusterapi.Client, carPath string, version uint64, pinName string, expectedRoot cid.Cid) error {
	if client == nil {
		return errors.New("IPFS Cluster API not available")
	}

	dataReader, closeFn, err := openCARDataReader(carPath, version)
	if err != nil {
		return err
	}
	defer closeFn()

	// The multipart entry name MUST be a fixed, path-safe constant — never the
	// pin name. Boxo's multipart parser (used by the cluster's FromMultipart)
	// treats the part filename as a PATH: any '/' creates a nested directory,
	// and the cluster's carAdder then rejects the upload with "expected CAR
	// file is not of type file". Pin names regularly contain '/' here because
	// the webui client-side-encrypts them to standard base64. The real pin
	// name travels separately (and URL-encoded) in params.Name.
	sliceDir := files.NewSliceDirectory([]files.DirEntry{
		files.FileEntry("import.car", files.NewReaderFile(dataReader)),
	})
	mfr := files.NewMultiFileReader(sliceDir, true, false)

	params := api.DefaultAddParams()
	params.Format = "car"
	params.Name = pinName

	// The client closes out itself when AddMultiFile returns; drain
	// concurrently or the client blocks forever on the channel send.
	out := make(chan api.AddedOutput, 16)
	var last api.AddedOutput
	gotOutput := false
	done := make(chan struct{})
	go func() {
		defer close(done)
		for o := range out {
			last = o
			gotOutput = true
		}
	}()

	err = client.AddMultiFile(ctx, mfr, params, out)
	<-done
	if err != nil {
		return fmt.Errorf("cluster CAR add failed: %w", err)
	}
	if !gotOutput {
		return errors.New("cluster CAR add returned no output")
	}
	if !last.Cid.Cid.Equals(expectedRoot) {
		return fmt.Errorf("cluster CAR add returned root %s, expected %s", last.Cid, expectedRoot)
	}
	return nil
}

// clusterImportTimeout scales the async import deadline with the CAR size
// (the flat 60s used for pin-by-CID is not enough for large CARs): 2 minutes
// minimum, plus time to move the payload at a conservative 512 KiB/s, capped
// at 30 minutes.
func clusterImportTimeout(carSize int64) time.Duration {
	d := 2*time.Minute + time.Duration(carSize/(512*1024))*time.Second
	if d > 30*time.Minute {
		return 30 * time.Minute
	}
	return d
}

// carImportErrorResponse maps validation sentinels to the Pinning Service
// API failure shape. All validation failures are client errors (the CAR came
// from the user; server faults are handled separately by callers).
func carImportErrorResponse(err error) ImplResponse {
	return createErrorResponse(http.StatusBadRequest, "BAD_REQUEST", err.Error())
}
