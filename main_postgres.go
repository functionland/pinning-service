// IPFS Pinning Service - PostgreSQL Backend
// This is the main entry point using PostgreSQL for data storage
//
// Build with: go build -o pinning-server-postgres main_postgres.go
// Or use build tag: go build -tags postgres -o pinning-server

package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
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
	log.Printf("IPFS Pinning Service starting (PostgreSQL backend)...")

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

	// Initialize PostgreSQL Service
	postgresService, err := openapi.NewPostgresServiceFromEnv()
	if err != nil {
		log.Fatalf("Error initializing PostgreSQL service: %v", err)
	}
	defer func() {
		if err := postgresService.Close(); err != nil {
			log.Printf("Error closing PostgreSQL service: %v", err)
		}
	}()

	log.Printf("PostgreSQL database connected successfully")

	// Initialize User Service with PostgreSQL backend
	userService, err := openapi.NewUserServicePostgres(postgresService)
	if err != nil {
		log.Fatalf("Error initializing User service: %v", err)
	}
	userAPIController := openapi.NewUserAPIControllerPostgres(userService)

	// In test mode, create test user and session
	if testMode {
		ctx := context.Background()
		if err := setupTestUserPostgres(ctx, postgresService, userService); err != nil {
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
	ipfsClusterAddr := os.Getenv("IPFS_CLUSTER_API_ADDR")
	if ipfsClusterAddr == "" {
		ipfsClusterAddr = "/ip4/127.0.0.1/tcp/9094"
	}
	clusterMultiAddr, err := ma.NewMultiaddr(ipfsClusterAddr)
	if err != nil {
		log.Fatalf("Invalid IPFS Cluster multiaddress %s: %v", ipfsClusterAddr, err)
	}
	ipfsClusterConfig := ipfsCluster.Config{
		APIAddr: clusterMultiAddr,
	}
	ipfsClusterApi, err := ipfsCluster.NewDefaultClient(&ipfsClusterConfig)
	if err != nil {
		log.Fatalf("Error initializing IPFS cluster API: %v", err)
	}
	log.Printf("IPFS Cluster API connected at: %s", ipfsClusterAddr)

	// Check if direct IPFS pinning is enabled
	enableIPFSPinning := strings.ToLower(os.Getenv("ENABLE_IPFS_PINNING")) == "true" || os.Getenv("ENABLE_IPFS_PINNING") == "1"
	if enableIPFSPinning {
		log.Printf("Direct IPFS pinning ENABLED")
	} else {
		log.Printf("Direct IPFS pinning DISABLED")
	}

	// Get IPFS HTTP URL for dag/stat API
	ipfsHTTPURL := os.Getenv("IPFS_HTTP_URL")

	// Initialize PinsAPIService with PostgreSQL backend
	pinsAPIService := openapi.NewPinsAPIServicePostgres(postgresService, userService, ipfsAPI, ipfsClusterApi, enableIPFSPinning, ipfsHTTPURL)

	// Create PinsAPIController
	pinsAPIController := openapi.NewPinsAPIController(pinsAPIService)

	// Create Admin API Controller
	systemKey := os.Getenv("SYSTEM_KEY")
	if systemKey == "" {
		log.Printf("Warning: SYSTEM_KEY not set, admin endpoints will be inaccessible")
		systemKey = "disabled"
	}
	adminAPIController := openapi.NewAdminAPIControllerPostgres(postgresService, systemKey)
	adminRouter := openapi.NewAdminRouterPostgres(adminAPIController)

	// Initialize router
	mainRouter := openapi.NewRouter(pinsAPIController)
	additionalRouter := openapi.NewAdditionalRouterPostgres(pinsAPIController, userAPIController)
	router := mux.NewRouter()
	router.PathPrefix("/admin/").Handler(adminRouter)
	router.PathPrefix("/auth/").Handler(additionalRouter)
	router.PathPrefix("/").Handler(mainRouter)

	// Apply auth middleware
	authRouter := openapi.AuthMiddlewarePostgres(postgresService)(router)

	// Apply CORS middleware
	corsRouter := corsMiddleware(authRouter)

	// Apply request logging middleware
	loggingRouter := requestLoggingMiddleware(corsRouter, testMode)

	// Get server port
	port := os.Getenv("PORT")
	if port == "" {
		port = "6000"
	}

	// Bind host. Default 127.0.0.1 — nginx (api.cloud.fx.land) is the only
	// intended ingress; raw direct access on the published port bypasses TLS
	// and rate limits. Set BIND_HOST=0.0.0.0 for local/dev without a proxy.
	bindHost := os.Getenv("BIND_HOST")
	if bindHost == "" {
		bindHost = "127.0.0.1"
	}

	// Create server
	server := &http.Server{
		Addr:         bindHost + ":" + port,
		Handler:      openapi.InjectRequestIntoContext(loggingRouter),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 90 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Start server
	go func() {
		log.Printf("Server listening on port %s", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server exited gracefully")
}

// setupTestUserPostgres creates or updates the test user and session
func setupTestUserPostgres(ctx context.Context, db *openapi.PostgresService, userService *openapi.UserServicePostgres) error {
	// Try to create test user (ignore error if already exists)
	err := userService.CreateUser(ctx, TestModeUsername, TestModePassword)
	if err != nil && err.Error() != "user already exists" {
		return err
	}

	// Create or update the test session
	err = db.CreateTestSession(ctx, TestModeUsername, TestModeToken)
	if err != nil {
		return err
	}

	log.Printf("   Test Username: %s", TestModeUsername)
	log.Printf("   Test Token: %s", TestModeToken)
	return nil
}

// corsMiddleware adds CORS headers
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, X-Requested-With")
		w.Header().Set("Access-Control-Max-Age", "3600")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// requestLoggingMiddleware logs incoming requests
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
