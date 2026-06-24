package openapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"
)

// mintServiceAuth builds an X-Fula-Service-Auth value the way the Fula S3 gateway
// (Rust) does. It is the REFERENCE for the cross-language shared vector below;
// production never mints here (the pinning service only verifies).
func mintServiceAuth(userID string, exp int64, secret string) string {
	uidB64 := base64.RawURLEncoding.EncodeToString([]byte(userID))
	expStr := strconv.FormatInt(exp, 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("v1." + uidB64 + "." + expStr))
	sigB64 := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return "v1." + uidB64 + "." + expStr + "." + sigB64
}

// SHARED VECTOR — these exact inputs must produce the identical header in the
// Rust gateway minter (and verify identically anywhere else). Far-future exp so
// it never expires under test.
const (
	vecSecret = "fula-pin-svc-shared-test-secret-rotate-me"
	vecUserID = "2d2dfffdad62ff927abba1295c73a4eab7666813280ea8b356da845e440c41ff"
	vecExp    = int64(4102444800) // 2100-01-01T00:00:00Z
)

func TestServiceAuthSharedVector(t *testing.T) {
	header := mintServiceAuth(vecUserID, vecExp, vecSecret)
	t.Logf("SHARED VECTOR (copy into the Rust/TS tests):\n  secret=%q\n  user_id=%q\n  exp=%d\n  header=%s",
		vecSecret, vecUserID, vecExp, header)

	uid, err := verifyServiceAuthValue(header, vecSecret)
	if err != nil {
		t.Fatalf("shared-vector header rejected: %v", err)
	}
	if uid != vecUserID {
		t.Fatalf("user_id mismatch: got %q want %q", uid, vecUserID)
	}
}

func TestServiceAuthRejects(t *testing.T) {
	good := mintServiceAuth(vecUserID, vecExp, vecSecret)

	// tampered signature: same shape, different (valid-b64) sig segment
	tParts := strings.Split(good, ".")
	tParts[3] = base64.RawURLEncoding.EncodeToString([]byte("not-the-real-hmac-32-bytes-xxxxx"))
	tamperedSig := strings.Join(tParts, ".")

	// user_id swap: replace the user_id segment, KEEP the original signature
	// (the forgery the binding must defeat)
	sParts := strings.Split(good, ".")
	sParts[1] = base64.RawURLEncoding.EncodeToString([]byte("victim-other-user-id"))
	swappedUID := strings.Join(sParts, ".")

	cases := []struct{ name, raw, secret string }{
		{"wrong-secret", good, "a-totally-different-secret"},
		{"empty-secret-disabled", good, ""},
		{"literal-disabled", good, "disabled"},
		{"tampered-signature", tamperedSig, vecSecret},
		{"user-id-swap-keeps-sig", swappedUID, vecSecret},
		{"expired", mintServiceAuth(vecUserID, time.Now().Unix()-10, vecSecret), vecSecret},
		{"too-few-parts", "v1.abc.123", vecSecret},
		{"bad-version", "v2." + strings.Join(strings.Split(good, ".")[1:], "."), vecSecret},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := verifyServiceAuthValue(c.raw, c.secret); !errors.Is(err, ErrServiceAuthInvalid) {
				t.Fatalf("expected ErrServiceAuthInvalid, got %v", err)
			}
		})
	}
}

func TestServiceAuthRoundTripVariousUsers(t *testing.T) {
	exp := time.Now().Unix() + 60
	for _, uid := range []string{
		"2d2dfffdad62ff927abba1295c73a4eab7666813280ea8b356da845e440c41ff",
		"f98d6328e961812226658fa0fb4252d2cd4bb651d3df573c8b48671587b38e2c",
		"x", // short id still binds
	} {
		got, err := verifyServiceAuthValue(mintServiceAuth(uid, exp, vecSecret), vecSecret)
		if err != nil || got != uid {
			t.Fatalf("round-trip failed for %q: got=%q err=%v", uid, got, err)
		}
	}
}
