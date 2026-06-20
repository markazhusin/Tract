package serverless

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"

	"tract-signaling/internal/quantum"
)

// MarshalText renders a NodeID as hex so JSON packets stay compact.
func (id NodeID) MarshalText() ([]byte, error) {
	return []byte(hex.EncodeToString(id[:])), nil
}

// UnmarshalText parses a hex-encoded NodeID.
func (id *NodeID) UnmarshalText(b []byte) error {
	raw, err := hex.DecodeString(string(b))
	if err != nil {
		return err
	}
	if len(raw) != idBytes {
		return fmt.Errorf("serverless: bad node id length %d", len(raw))
	}
	copy(id[:], raw)
	return nil
}

// GenerateNodeID returns a fresh random DHT node ID. The entropy is sourced from
// the quantum emulator's measured-superposition RNG (internal/quantum), so a
// node's position in the keyspace is unguessable and unlinkable across sessions.
func GenerateNodeID() NodeID {
	var id NodeID
	copy(id[:], quantum.Bytes(idBytes))
	return id
}

// newRPCID returns a short unique correlation id for a request/response pair.
// Uses crypto/rand directly (hot path; the quantum RNG is reserved for identity).
func newRPCID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
