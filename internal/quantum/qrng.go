package quantum

// QRNG (quantum random number generator) produces random bytes by preparing a
// uniform superposition (Hadamard on every qubit) and measuring it. In a real
// quantum device the measurement outcome is fundamentally non-deterministic; here
// the collapse is sampled from crypto/rand, so the *entropy* still comes from the
// host CSPRNG — this is an honest emulation, not a hardware QRNG. It is a correct
// drop-in source of cryptographic randomness and a faithful model of the circuit.
//
// Tract uses it to seed identifiers that want to be unguessable and unlinkable:
// DHT node IDs and rendezvous nonces (see internal/serverless).

// Bits returns n random bits (each 0 or 1) via measured superposition.
func Bits(n int) []int {
	out := make([]int, 0, n)
	const width = 16 // measure 16 qubits per register pass
	for len(out) < n {
		take := width
		if rem := n - len(out); rem < take {
			take = rem
		}
		r := New(width)
		for q := 0; q < width; q++ {
			r.H(q)
		}
		bits := r.MeasureAll()
		out = append(out, bits[:take]...)
	}
	return out
}

// Bytes returns n cryptographically-random bytes from measured superposition.
func Bytes(n int) []byte {
	bits := Bits(n * 8)
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		var v byte
		for b := 0; b < 8; b++ {
			v |= byte(bits[i*8+b]) << b
		}
		out[i] = v
	}
	return out
}
