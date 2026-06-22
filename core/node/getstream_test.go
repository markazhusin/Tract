package node

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestMintStreamTokenIsValidHS256(t *testing.T) {
	secret := "test-secret"
	tok, err := mintStreamToken(secret, "@alice")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("want 3 JWT segments, got %d", len(parts))
	}
	enc := base64.RawURLEncoding

	// Header advertises HS256.
	hb, err := enc.DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	var header map[string]interface{}
	json.Unmarshal(hb, &header)
	if header["alg"] != "HS256" {
		t.Fatalf("alg = %v", header["alg"])
	}

	// Claims carry the user_id Stream expects.
	cb, _ := enc.DecodeString(parts[1])
	var claims map[string]interface{}
	json.Unmarshal(cb, &claims)
	if claims["user_id"] != "@alice" {
		t.Fatalf("user_id = %v", claims["user_id"])
	}

	// Signature verifies against the secret.
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if want := enc.EncodeToString(mac.Sum(nil)); want != parts[2] {
		t.Fatalf("signature mismatch")
	}
}

func TestStreamUserIDSanitises(t *testing.T) {
	if got := streamUserID("  @AbC!#dEf "); got != "@abcdef" {
		t.Fatalf("got %q", got)
	}
}
