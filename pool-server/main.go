package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/elazarl/goproxy"
	openapi "github.com/functionland/pinning-service"
	"github.com/joho/godotenv"
)

// User represents the structure of your user data in Firebase
type User struct {
	Pool string `json:"pool"`
}

type contextKey string

const authTokenKey = contextKey("authToken")
const requestContextKey contextKey = "httpRequest"

// ReverseProxyHandler creates a reverse proxy handler
func ReverseProxyHandler(userService *openapi.UserService) http.Handler {
	proxy := goproxy.NewProxyHttpServer()
	proxy.OnRequest().HandleConnect(goproxy.AlwaysMitm)
	proxy.OnRequest().DoFunc(
		func(req *http.Request, ctx *goproxy.ProxyCtx) (*http.Request, *http.Response) {
			var poolId int
			authToken, err := extractAuthTokenFromRequest(req)
			if err != nil {
				log.Printf("Error extracting the auth token: %v", err)
				poolId = 1
			}
			log.Printf("auth token: %s", authToken)

			poolId, err = userService.GetUserPoolFromSession(req.Context(), authToken)
			if err != nil {
				log.Printf("Error getting user pool: %v", err)
				poolId = 1
			}
			log.Printf("pool_id: %d", poolId)

			var backendServer string
			switch poolId {
			case 1:
				backendServer = "https://api1.cloud.fx.land"
			case 2:
				backendServer = "https://api2.cloud.fx.land"
			case 3:
				backendServer = "https://api3.cloud.fx.land"
			case 4:
				backendServer = "https://api4.cloud.fx.land"
			default:
				return req, goproxy.NewResponse(req, goproxy.ContentTypeText, http.StatusNotFound, "No backend server found for this pool")
			}

			// Modify the request URL to point to the backend server
			req.URL.Scheme = "https"
			req.URL.Host = strings.TrimPrefix(backendServer, "https://")
			return req, nil
		},
	)

	// Handle non-proxy requests
	proxy.NonproxyHandler = http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			var poolId int
			authToken, err := extractAuthTokenFromRequest(r)
			if err != nil {
				log.Printf("Error extracting the auth token: %v", err)
				poolId = 1
			}
			log.Printf("auth token: %s", authToken)

			poolId, err = userService.GetUserPoolFromSession(r.Context(), authToken)
			if err != nil {
				log.Printf("Error getting user pool: %v", err)
				poolId = 1
			}
			log.Printf("poolId: %d", poolId)

			var backendServer string
			switch poolId {
			case 1:
				backendServer = "https://api1.cloud.fx.land"
			case 2:
				backendServer = "https://api2.cloud.fx.land"
			case 3:
				backendServer = "https://api3.cloud.fx.land"
			case 4:
				backendServer = "https://api4.cloud.fx.land"
			default:
				http.Error(w, "No backend server found for this pool", http.StatusNotFound)
				return
			}

			// Create a reverse proxy to the backend server
			proxyURL, err := url.Parse(backendServer)
			if err != nil {
				http.Error(w, "Invalid backend server URL", http.StatusInternalServerError)
				return
			}
			r.URL.Scheme = proxyURL.Scheme
			r.URL.Host = proxyURL.Host
			r.Host = proxyURL.Host

			proxy := goproxy.NewProxyHttpServer()
			proxy.ServeHTTP(w, r)
		},
	)
	return proxy
}

func extractAuthTokenFromRequest(req *http.Request) (string, error) {
	authHeader := req.Header.Get("Authorization")
	if authHeader == "" {
		return "", errors.New("authorization token not found in context")
	}

	token := strings.TrimPrefix(authHeader, "Bearer ")
	if token == authHeader {
		return "", errors.New("malformed authorization token")
	}

	return token, nil
}

func main() {
	err := godotenv.Load()
	if err != nil {
		log.Fatalf("Error loading .env file")
		panic("no env found")
	}
	credentialsFile := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")

	ctx := context.Background()
	firestoreService, err := openapi.NewFirestoreService(ctx, credentialsFile)
	if err != nil {
		log.Fatalf("Error initializing Firestore service: %v", err)
		panic(err)
	}
	userService, err := openapi.NewUserService(firestoreService.Client)
	if err != nil {
		log.Fatalf("Error initializing User service: %v", err)
		panic(err)
	}

	http.Handle("/", ReverseProxyHandler(userService))
	log.Fatal(http.ListenAndServe(":7000", nil))
}
