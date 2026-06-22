package mainline

import (
	"crypto/ed25519"
	"crypto/sha256"
	"reflect"
	"testing"
)

func TestBencodeRoundTrip(t *testing.T) {
	in := map[string]interface{}{
		"t": "aa",
		"y": "q",
		"q": "find_node",
		"a": map[string]interface{}{
			"id":     "abcdefghij0123456789",
			"target": "mnopqrstuvwxyz123456",
			"seq":    int64(42),
			"list":   []interface{}{int64(1), "two"},
		},
	}
	b, err := bencode(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := bdecode(b)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("round trip mismatch:\n in=%#v\nout=%#v", in, out)
	}
}

// BEP-44 specifies the exact byte string that gets signed. These are the spec's
// own worked examples; if our concatenation drifts, signatures become invalid on
// the real network.
func TestSignBufferVectors(t *testing.T) {
	got := string(signBuffer(nil, 1, []byte("Hello World!")))
	if want := "3:seqi1e1:v12:Hello World!"; got != want {
		t.Fatalf("unsalted: got %q want %q", got, want)
	}
	got = string(signBuffer([]byte("foobar"), 1, []byte("Hello World!")))
	if want := "4:salt6:foobar3:seqi1e1:v12:Hello World!"; got != want {
		t.Fatalf("salted: got %q want %q", got, want)
	}
}

func TestKeyPairDeterministicAndSignVerify(t *testing.T) {
	seed := sha256.Sum256([]byte("tract-bep44:dinner-7421"))
	pub1, priv1 := KeyPairFromSeed(seed)
	pub2, _ := KeyPairFromSeed(seed)
	if !reflect.DeepEqual([]byte(pub1), []byte(pub2)) {
		t.Fatal("same seed must derive same public key")
	}
	val := []byte("http://1.2.3.4:8877")
	sig := ed25519.Sign(priv1, signBuffer(nil, 7, val))
	if !ed25519.Verify(pub1, signBuffer(nil, 7, val), sig) {
		t.Fatal("self sign/verify failed")
	}
	if ed25519.Verify(pub1, signBuffer(nil, 8, val), sig) {
		t.Fatal("verify must fail when seq differs")
	}
}

func TestMutableTargetStable(t *testing.T) {
	seed := sha256.Sum256([]byte("u"))
	pub, _ := KeyPairFromSeed(seed)
	if MutableTarget(pub, nil) != MutableTarget(pub, nil) {
		t.Fatal("target must be deterministic")
	}
	if MutableTarget(pub, []byte("a")) == MutableTarget(pub, []byte("b")) {
		t.Fatal("salt must change the target")
	}
}
