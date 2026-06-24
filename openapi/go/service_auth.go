package openapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

// ServiceAuthHeader is how a trusted CO-LOCATED caller (the Fula S3 gateway)
// asserts a user identity to the pinning service WITHOUT a session token — used
// for AI/MCP writes whose bearer is a gateway-scoped JWT (token_use=mcp_s3,
// aud=fula-s3-gateway), which is deliberately NOT a login session and so fails
// the normal session lookup.
//
// Format (v1):  "v1.<b64url(user_id)>.<exp_unix>.<b64url(hmac)>"
// where         hmac = HMAC-SHA256(secret, "v1." + b64url(user_id) + "." + exp_unix)
//
// Security properties (this is the whole trust boundary — keep it exact):
//   - The user_id is bound INTO the signature, so a public client cannot forge
//     or swap it without the shared secret. The /pins endpoint is reachable via
//     the public nginx vhost, so a plaintext user_id header would be injectable;
//     binding it via HMAC removes that class of risk.
//   - The SECRET never transits — only the HMAC does — so capture (logs, a future
//     proxy) yields at most a short-lived replay of the SAME user, never the
//     ability to mint a different user. (B1's "static secret + plaintext id"
//     was rejected for exactly this; see the design notes in the PR.)
//   - Short-lived (exp) bounds replay; constant-time compare (hmac.Equal).
//   - FAIL-CLOSED: a present-but-invalid header is an error — the caller must
//     NOT fall back to session auth on a bad service-auth. An ABSENT header is a
//     distinct sentinel so the caller falls through to the unchanged session path.
const ServiceAuthHeader = "X-Fula-Service-Auth"

// ServiceSecretEnv is the env var holding the shared secret (gateway side sets
// the same value). Unset/empty disables the service-auth path (fail-closed: a
// present header is then rejected, never trusted).
const ServiceSecretEnv = "FULA_PIN_SERVICE_SECRET"

// ErrServiceAuthAbsent — no X-Fula-Service-Auth header; caller falls through to
// the normal session-token auth (normal users are 100% unaffected).
var ErrServiceAuthAbsent = errors.New("service-auth header absent")

// ErrServiceAuthInvalid — header PRESENT but malformed / expired / bad signature
// / disabled secret. Fail-closed: caller MUST reject, never fall back to session.
var ErrServiceAuthInvalid = errors.New("service-auth header invalid")

// verifyServiceAuth validates ServiceAuthHeader against secret and returns the
// asserted user_id. See ServiceAuthHeader for the fail-closed/absent contract.
func verifyServiceAuth(ctx context.Context, secret string) (string, error) {
	req, err := GetRequestFromContext(ctx)
	if err != nil {
		// No request in context ⇒ cannot inspect headers ⇒ treat as absent so the
		// caller takes the normal session path (which will then fail as it does today).
		return "", ErrServiceAuthAbsent
	}
	raw := req.Header.Get(ServiceAuthHeader)
	if raw == "" {
		return "", ErrServiceAuthAbsent
	}
	return verifyServiceAuthValue(raw, secret)
}

// verifyServiceAuthValue is the pure verifier (no context) for a PRESENT,
// non-empty header value — the cross-language interop point, locked by a shared
// test vector. The header is PRESENT, so every path is fail-closed (returns
// ErrServiceAuthInvalid; never a silent fall-through).
func verifyServiceAuthValue(raw, secret string) (string, error) {
	if secret == "" || secret == "disabled" {
		return "", ErrServiceAuthInvalid
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 4 || parts[0] != "v1" {
		return "", ErrServiceAuthInvalid
	}
	uidB64, expStr, sigB64 := parts[1], parts[2], parts[3]

	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || time.Now().Unix() >= exp {
		return "", ErrServiceAuthInvalid
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("v1." + uidB64 + "." + expStr))
	want := mac.Sum(nil)
	got, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil || !hmac.Equal(want, got) {
		return "", ErrServiceAuthInvalid
	}

	uid, err := base64.RawURLEncoding.DecodeString(uidB64)
	if err != nil || len(uid) == 0 {
		return "", ErrServiceAuthInvalid
	}
	return string(uid), nil
}
