package serverless

import (
	"testing"
	"time"
)

// spawn creates a node on an ephemeral loopback UDP port.
func spawn(t *testing.T) *Node {
	t.Helper()
	n, err := NewNode(GenerateNodeID(), "127.0.0.1:0", "")
	if err != nil {
		t.Fatalf("NewNode: %v", err)
	}
	t.Cleanup(func() { n.Close() })
	return n
}

// TestServerlessRendezvous builds a small DHT with NO central server, has one
// peer announce a signaling card under a shared rendezvous secret, and verifies a
// different peer can discover it purely through the distributed table.
func TestServerlessRendezvous(t *testing.T) {
	const N = 7
	nodes := make([]*Node, N)
	for i := range nodes {
		nodes[i] = spawn(t)
	}
	// Chain-bootstrap: each node joins via the previous one. The first node is
	// only a bootstrap convenience, not a server — kill it later and lookups work.
	for i := 1; i < N; i++ {
		if err := nodes[i].Bootstrap(nodes[i-1].Addr()); err != nil {
			t.Fatalf("node %d bootstrap: %v", i, err)
		}
	}
	time.Sleep(150 * time.Millisecond) // let routing tables settle

	// Two peers agree on a secret out of band (e.g. scanned QR / spoken word).
	key := RendezvousKey("dinner-with-marco-7421")

	// Alice (node 1) announces her signaling card.
	card := []byte(`{"peer":"alice","ip":"203.0.113.7:51820","offer":"<sdp>"}`)
	stored := nodes[1].Announce(key, card)
	if stored == 0 {
		t.Fatalf("announce stored on 0 nodes")
	}
	t.Logf("announce replicated to %d nodes", stored)

	// Kill the bootstrap node to prove there is no central dependency.
	nodes[0].Close()
	time.Sleep(50 * time.Millisecond)

	// Bob (node 5) discovers Alice's card with no server in the loop.
	found := nodes[5].Discover(key)
	if len(found) == 0 {
		t.Fatalf("Bob found no cards at the rendezvous")
	}
	ok := false
	for _, v := range found {
		if string(v) == string(card) {
			ok = true
		}
	}
	if !ok {
		t.Fatalf("Bob did not find Alice's card; got %d other cards", len(found))
	}
}

// TestRendezvousKeyDeterministic confirms both peers derive the same key offline.
func TestRendezvousKeyDeterministic(t *testing.T) {
	a := RendezvousKey("same-secret")
	b := RendezvousKey("same-secret")
	if a != b {
		t.Fatal("rendezvous key not deterministic")
	}
	if a == RendezvousKey("other-secret") {
		t.Fatal("different secrets produced the same key")
	}
}

// TestPrefixLen sanity-checks the bucket index math.
func TestPrefixLen(t *testing.T) {
	var z NodeID
	if got := prefixLen(z); got != idBits {
		t.Fatalf("prefixLen(0) = %d, want %d", got, idBits)
	}
	var one NodeID
	one[0] = 0x80 // top bit set
	if got := prefixLen(one); got != 0 {
		t.Fatalf("prefixLen(top bit) = %d, want 0", got)
	}
	var third NodeID
	third[0] = 0x20 // bit index 2 set
	if got := prefixLen(third); got != 2 {
		t.Fatalf("prefixLen = %d, want 2", got)
	}
}
