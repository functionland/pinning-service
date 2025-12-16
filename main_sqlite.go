// IPFS Pinning Service - SQLite Backend
// This is the main entry point using SQLite for data storage

package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	openapi "github.com/functionland/pinning-service"
	"github.com/gorilla/mux"
	ipfsCluster "github.com/ipfs-cluster/ipfs-cluster/api/rest/client"
	"github.com/ipfs/kubo/client/rpc"
	"github.com/joho/godotenv"
	ma "github.com/multiformats/go-multiaddr"
)

// Default test credentials for compliance testing
const (
	TestModeUsername = "test@pinning.local"
	TestModePassword = "test-password-for-compliance"
	TestModeToken    = "test-token-for-ipfs-pinning-compliance"
)

func main() {
	log.Printf("IPFS Pinning Service starting (SQLite backend)...")

	// Check for test mode
	testMode := strings.ToLower(os.Getenv("TEST_MODE")) == "true" || os.Getenv("TEST_MODE") == "1"
	if testMode {
		log.Printf("⚠️  TEST MODE ENABLED - Using test credentials")
		log.Printf("   Test Token: %s", TestModeToken)
	}

	// Load environment variables from .env file
	if err := godotenv.Load(); err != nil {
		log.Printf("Warning: .env file not found, using environment variables")
	}

	// Get and validate environment variables
	masterSeed := os.Getenv("MASTER_SEED")
	poolSeed := os.Getenv("POOL_SEED")
	blockchainAPIEndpoint := os.Getenv("BLOCKCHAIN_API_ENDPOINT")
	poolIdStr := os.Getenv("POOL_ID")
	dbPath := os.Getenv("DATABASE_PATH")

	// In test mode, use defaults if not provided
	if testMode {
		if masterSeed == "" {
			masterSeed = "test-master-seed-for-compliance-testing"
		}
		if poolSeed == "" {
			poolSeed = "test-pool-seed-for-compliance-testing"
		}
		if blockchainAPIEndpoint == "" {
			blockchainAPIEndpoint = "http://localhost:9999" // Dummy endpoint for test mode
		}
	}

	if masterSeed == "" || poolSeed == "" || blockchainAPIEndpoint == "" {
		log.Fatal("Missing required environment variables: MASTER_SEED, POOL_SEED, BLOCKCHAIN_API_ENDPOINT")
	}

	// Default database path
	if dbPath == "" {
		dbPath = filepath.Join(".", "data", "pinning.db")
	}

	// Ensure data directory exists
	dataDir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	poolId, err := strconv.Atoi(poolIdStr)
	if err != nil {
		log.Printf("Warning: Invalid POOL_ID, defaulting to 1")
		poolId = 1
	}

	// Initialize SQLite Service
	sqliteService, err := openapi.NewSQLiteService(dbPath)
	if err != nil {
		log.Fatalf("Error initializing SQLite service: %v", err)
	}
	defer func() {
		if err := sqliteService.Close(); err != nil {
			log.Printf("Error closing SQLite service: %v", err)
		}
	}()

	log.Printf("SQLite database initialized at: %s", dbPath)

	// Initialize User Service with SQLite backend
	userService, err := openapi.NewUserServiceSQLite(sqliteService)
	if err != nil {
		log.Fatalf("Error initializing User service: %v", err)
	}
	userAPIController := openapi.NewUserAPIControllerSQLite(userService)

	// In test mode, create test user and session
	if testMode {
		ctx := context.Background()
		if err := setupTestUser(ctx, sqliteService, userService); err != nil {
			log.Printf("Warning: Failed to setup test user: %v", err)
		} else {
			log.Printf("✓ Test user and token ready")
		}
	}

	// Initialize IPFS node connection
	ipfsAddr := os.Getenv("IPFS_API_ADDR")
	if ipfsAddr == "" {
		ipfsAddr = "/ip4/127.0.0.1/tcp/5001"
	}
	nodeMultiAddr, err := ma.NewMultiaddr(ipfsAddr)
	if err != nil {
		log.Fatalf("Invalid IPFS multiaddress %s: %v", ipfsAddr, err)
	}

	ipfsAPI, err := rpc.NewApi(nodeMultiAddr)
	if err != nil {
		log.Fatalf("Error connecting to IPFS API: %v", err)
	}

	// Initialize IPFS Cluster connection
	ipfsClusterConfig := ipfsCluster.Config{}
	ipfsClusterApi, err := ipfsCluster.NewDefaultClient(&ipfsClusterConfig)
	if err != nil {
		log.Fatalf("Error initializing IPFS cluster API: %v", err)
	}

	// Initialize PinsAPIService with SQLite backend
	pinsAPIService := openapi.NewPinsAPIServiceSQLite(sqliteService, userService, ipfsAPI, ipfsClusterApi, blockchainAPIEndpoint, masterSeed, poolSeed, poolId)

	// Create PinsAPIController
	pinsAPIController := openapi.NewPinsAPIController(pinsAPIService)

	// Create Admin API Controller (system-only endpoints)
	systemKey := os.Getenv("SYSTEM_KEY")
	if systemKey == "" {
		log.Printf("Warning: SYSTEM_KEY not set, admin endpoints will be inaccessible")
		systemKey = "disabled" // Effectively disables admin access
	}
	adminAPIController := openapi.NewAdminAPIController(sqliteService, systemKey)
	adminRouter := openapi.NewAdminRouter(adminAPIController)

	// Initialize router
	mainRouter := openapi.NewRouter(pinsAPIController)
	additionalRouter := openapi.NewAdditionalRouterSQLite(pinsAPIController, userAPIController)
	router := mux.NewRouter()
	router.PathPrefix("/admin/").Handler(adminRouter) // Admin routes (no auth middleware - uses system key)
	router.PathPrefix("/auth/").Handler(additionalRouter)
	router.PathPrefix("/").Handler(mainRouter)

	// Apply auth middleware
	authRouter := openapi.AuthMiddlewareSQLite(sqliteService)(router)

	// Apply CORS middleware (required for compliance tests)
	corsRouter := corsMiddleware(authRouter)

	// Apply request logging middleware (for debugging)
	loggingRouter := requestLoggingMiddleware(corsRouter, testMode)

	// Get server port from environment or default to 6000
	port := os.Getenv("PORT")
	if port == "" {
		port = "6000"
	}

	// Create server with timeouts for production
	server := &http.Server{
		Addr:         ":" + port,
		Handler:      openapi.InjectRequestIntoContext(loggingRouter),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 90 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Start server in a goroutine
	go func() {
		log.Printf("Server listening on port %s", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Wait for interrupt signal for graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	// Create shutdown context with timeout
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server exited gracefully")
}

// setupTestUser creates or updates the test user and session for compliance testing
func setupTestUser(ctx context.Context, db *openapi.SQLiteService, userService *openapi.UserServiceSQLite) error {
	// Try to create test user (ignore error if already exists)
	err := userService.CreateUser(ctx, TestModeUsername, TestModePassword)
	if err != nil && err.Error() != "user already exists" {
		return err
	}

	// Create or update the test session with fixed token
	err = db.CreateTestSession(ctx, TestModeUsername, TestModeToken)
	if err != nil {
		return err
	}

	log.Printf("   Test Username: %s", TestModeUsername)
	log.Printf("   Test Token: %s", TestModeToken)
	return nil
}

// corsMiddleware adds CORS headers required for compliance tests
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set CORS headers
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, X-Requested-With")
		w.Header().Set("Access-Control-Max-Age", "3600")

		// Handle preflight requests
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// requestLoggingMiddleware logs all incoming requests (verbose in test mode)
func requestLoggingMiddleware(next http.Handler, verbose bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if verbose {
			log.Printf("➡️  %s %s (from %s)", r.Method, r.URL.Path, r.RemoteAddr)
			if auth := r.Header.Get("Authorization"); auth != "" {
				if len(auth) > 20 {
					log.Printf("    Auth: %s...%s", auth[:15], auth[len(auth)-5:])
				} else {
					log.Printf("    Auth: %s", auth)
				}
			} else {
				log.Printf("    Auth: (none)")
			}
		}
		next.ServeHTTP(w, r)
	})
}
