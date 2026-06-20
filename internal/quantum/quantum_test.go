package quantum

import (
	"math"
	"testing"
)

// TestBellEntanglement prepares the Bell state (|00> + |11>)/sqrt(2) and verifies
// that the two qubits always agree when measured — the signature of entanglement.
func TestBellEntanglement(t *testing.T) {
	const trials = 2000
	zeros, ones := 0, 0
	for i := 0; i < trials; i++ {
		r := New(2)
		r.H(0)
		r.CNOT(0, 1)
		a := r.Measure(0)
		b := r.Measure(1)
		if a != b {
			t.Fatalf("Bell pair disagreed: q0=%d q1=%d", a, b)
		}
		if a == 0 {
			zeros++
		} else {
			ones++
		}
	}
	// Outcomes should be ~50/50; allow generous tolerance.
	ratio := float64(ones) / float64(trials)
	if ratio < 0.4 || ratio > 0.6 {
		t.Fatalf("Bell outcome distribution skewed: ones=%.3f", ratio)
	}
}

// TestSuperpositionProbabilities checks H|0> gives equal 50/50 amplitudes.
func TestSuperpositionProbabilities(t *testing.T) {
	r := New(1)
	r.H(0)
	p := r.Probabilities()
	if math.Abs(p[0]-0.5) > 1e-9 || math.Abs(p[1]-0.5) > 1e-9 {
		t.Fatalf("expected 0.5/0.5, got %v", p)
	}
}

// TestXGate flips |0> to |1> deterministically.
func TestXGate(t *testing.T) {
	r := New(1)
	r.X(0)
	if got := r.Measure(0); got != 1 {
		t.Fatalf("X|0> measured %d, want 1", got)
	}
}

// TestNormPreserved verifies that a random circuit keeps total probability = 1.
func TestNormPreserved(t *testing.T) {
	r := New(4)
	r.H(0)
	r.H(1)
	r.T(2)
	r.CNOT(0, 2)
	r.CZ(1, 3)
	r.QFT()
	var sum float64
	for _, p := range r.Probabilities() {
		sum += p
	}
	if math.Abs(sum-1) > 1e-9 {
		t.Fatalf("norm drifted: sum=%.12f", sum)
	}
}

// TestQRNGBalance sanity-checks that the QRNG bitstream is roughly balanced.
func TestQRNGBalance(t *testing.T) {
	bits := Bits(8000)
	ones := 0
	for _, b := range bits {
		ones += b
	}
	ratio := float64(ones) / float64(len(bits))
	if ratio < 0.45 || ratio > 0.55 {
		t.Fatalf("QRNG bias detected: ones ratio=%.3f", ratio)
	}
	if n := len(Bytes(16)); n != 16 {
		t.Fatalf("Bytes(16) returned %d bytes", n)
	}
}
