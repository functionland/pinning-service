package openapi

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/ipfs/boxo/files"
	ipfspath "github.com/ipfs/boxo/path"
	ipfsrpc "github.com/ipfs/kubo/client/rpc"
)

// TestSizeFetchWithLocalIPFS tests the size fetch functionality with a local IPFS instance.
// Prerequisites:
//   - Local IPFS daemon running (ipfs daemon)
//   - A CID that exists in your local IPFS node
//
// Run with:
//
//	go test -v -run TestSizeFetchWithLocalIPFS ./go/
//
// Or with a specific CID:
//
//	TEST_CID=bafkr4ihy2zyowc2mlnuwdg5u7h5ohcjokt2ezwhbrkudwxgrgsqxp64cny go test -v -run TestSizeFetchWithLocalIPFS ./go/
func TestSizeFetchWithLocalIPFS(t *testing.T) {
	// Skip if not running integration tests
	if os.Getenv("INTEGRATION_TEST") == "" && os.Getenv("TEST_CID") == "" {
		t.Skip("Skipping integration test. Set INTEGRATION_TEST=1 or TEST_CID=<cid> to run")
	}

	// Connect to local IPFS
	ipfsAPI, err := ipfsrpc.NewLocalApi()
	if err != nil {
		t.Fatalf("Failed to connect to local IPFS: %v\nMake sure IPFS daemon is running (ipfs daemon)", err)
	}

	// Test CID - use env var or default
	testCID := os.Getenv("TEST_CID")
	if testCID == "" {
		// Create a test file and get its CID
		t.Log("No TEST_CID provided, creating test content...")
		testContent := []byte("This is a test file for size fetch testing")

		// Add content to IPFS using proper files interface
		addResult, err := ipfsAPI.Unixfs().Add(context.Background(),
			files.NewBytesFile(testContent))
		if err != nil {
			t.Fatalf("Failed to add test content to IPFS: %v", err)
		}
		testCID = addResult.RootCid().String()
		t.Logf("Created test content with CID: %s (size: %d bytes)", testCID, len(testContent))
	}

	t.Logf("Testing size fetch for CID: %s", testCID)

	// Create path
	path, err := ipfspath.NewPath("/ipfs/" + testCID)
	if err != nil {
		t.Fatalf("Failed to create path: %v", err)
	}

	// Test 1: Block.Stat (what we use in getCIDSize)
	t.Run("BlockStat", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		blockStat, err := ipfsAPI.Block().Stat(ctx, path)
		if err != nil {
			t.Fatalf("Block.Stat failed: %v", err)
		}

		size := blockStat.Size()
		t.Logf("Block size: %d bytes", size)

		if size <= 0 {
			t.Errorf("Expected size > 0, got %d", size)
		}
	})

	// Test 2: Test with timeout (simulating slow network)
	t.Run("BlockStatWithTimeout", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		blockStat, err := ipfsAPI.Block().Stat(ctx, path)
		if err != nil {
			if ctx.Err() == context.DeadlineExceeded {
				t.Log("Request timed out (expected for remote content)")
				return
			}
			t.Fatalf("Block.Stat failed: %v", err)
		}

		t.Logf("Block size (with 5s timeout): %d bytes", blockStat.Size())
	})

	// Test 3: Test the actual getCIDSize function from PinsAPIServiceSQLite
	t.Run("GetCIDSizeFunction", func(t *testing.T) {
		// Create a minimal service just for testing getCIDSize
		service := &PinsAPIServiceSQLite{
			ipfsAPI: ipfsAPI,
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		size, err := service.getCIDSize(ctx, testCID)
		if err != nil {
			t.Fatalf("getCIDSize failed: %v", err)
		}

		t.Logf("getCIDSize returned: %d bytes", size)

		if size <= 0 {
			t.Errorf("Expected size > 0, got %d", size)
		}
	})
}

// TestSizeFetchRemoteCID tests fetching size for a remote CID (may timeout)
func TestSizeFetchRemoteCID(t *testing.T) {
	if os.Getenv("INTEGRATION_TEST") == "" {
		t.Skip("Skipping integration test. Set INTEGRATION_TEST=1 to run")
	}

	ipfsAPI, err := ipfsrpc.NewLocalApi()
	if err != nil {
		t.Fatalf("Failed to connect to local IPFS: %v", err)
	}

	// A known public CID (IPFS logo)
	remoteCID := "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"

	t.Logf("Testing remote CID (may timeout): %s", remoteCID)

	path, err := ipfspath.NewPath("/ipfs/" + remoteCID)
	if err != nil {
		t.Fatalf("Failed to create path: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	blockStat, err := ipfsAPI.Block().Stat(ctx, path)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			t.Log("Request timed out - this is expected for remote content not in local cache")
			return
		}
		t.Logf("Block.Stat failed (may be expected): %v", err)
		return
	}

	t.Logf("Remote CID block size: %d bytes", blockStat.Size())
}

// BenchmarkSizeFetch benchmarks the size fetch operation
func BenchmarkSizeFetch(b *testing.B) {
	if os.Getenv("INTEGRATION_TEST") == "" {
		b.Skip("Skipping benchmark. Set INTEGRATION_TEST=1 to run")
	}

	ipfsAPI, err := ipfsrpc.NewLocalApi()
	if err != nil {
		b.Fatalf("Failed to connect to local IPFS: %v", err)
	}

	// Create test content
	testContent := []byte("Benchmark test content")
	addResult, err := ipfsAPI.Unixfs().Add(context.Background(),
		files.NewBytesFile(testContent))
	if err != nil {
		b.Fatalf("Failed to add test content: %v", err)
	}

	testCID := addResult.RootCid().String()
	path, _ := ipfspath.NewPath("/ipfs/" + testCID)

	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, err := ipfsAPI.Block().Stat(ctx, path)
		cancel()
		if err != nil {
			b.Fatalf("Block.Stat failed: %v", err)
		}
	}
}
