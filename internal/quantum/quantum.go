// Package quantum is a small but honest state-vector quantum emulator in pure Go.
//
// It simulates an n-qubit register as a dense complex amplitude vector of length
// 2^n and applies gates as linear operators on that vector. This is the standard
// way real quantum circuit simulators work (Qiskit Aer, cirq's simulator, etc.) —
// it is "emulation" in the exact technical sense: a classical machine reproducing
// the statistics of a quantum system. It does NOT give you faster-than-light or
// serverless communication; entanglement cannot carry information (the
// no-communication theorem). What it DOES give you, usefully, is a real source of
// sampled randomness (see QRNG) and a correct playground for quantum algorithms.
//
// Qubit 0 is the least-significant bit of the basis-state index.
package quantum

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"math"
	"math/cmplx"
	"strings"
)

const invSqrt2 = 0.7071067811865476 // 1/sqrt(2)

// Register is an n-qubit quantum register held as a state vector.
type Register struct {
	n    int
	amps []complex128 // length 1<<n; amps[i] is the amplitude of basis state |i>
}

// New returns an n-qubit register initialised to |0...0>.
func New(n int) *Register {
	if n < 1 || n > 24 {
		panic("quantum: qubit count out of range (1..24)")
	}
	amps := make([]complex128, 1<<n)
	amps[0] = 1
	return &Register{n: n, amps: amps}
}

// Qubits reports how many qubits the register holds.
func (r *Register) Qubits() int { return r.n }

// applySingle applies a 2x2 unitary m = [[m0,m1],[m2,m3]] to qubit q.
func (r *Register) applySingle(q int, m [4]complex128) {
	r.checkQubit(q)
	bit := 1 << q
	for i := 0; i < len(r.amps); i++ {
		if i&bit != 0 {
			continue // process each pair once, from the |..0..> member
		}
		j := i | bit
		a0, a1 := r.amps[i], r.amps[j]
		r.amps[i] = m[0]*a0 + m[1]*a1
		r.amps[j] = m[2]*a0 + m[3]*a1
	}
}

// --- Single-qubit gates ---

// H applies the Hadamard gate (creates superposition).
func (r *Register) H(q int) {
	r.applySingle(q, [4]complex128{invSqrt2, invSqrt2, invSqrt2, -invSqrt2})
}

// X applies the Pauli-X (NOT / bit flip) gate.
func (r *Register) X(q int) { r.applySingle(q, [4]complex128{0, 1, 1, 0}) }

// Y applies the Pauli-Y gate.
func (r *Register) Y(q int) { r.applySingle(q, [4]complex128{0, -1i, 1i, 0}) }

// Z applies the Pauli-Z (phase flip) gate.
func (r *Register) Z(q int) { r.applySingle(q, [4]complex128{1, 0, 0, -1}) }

// S applies the phase gate (sqrt of Z).
func (r *Register) S(q int) { r.applySingle(q, [4]complex128{1, 0, 0, 1i}) }

// T applies the pi/8 gate (sqrt of S).
func (r *Register) T(q int) {
	r.applySingle(q, [4]complex128{1, 0, 0, cmplx.Exp(1i * math.Pi / 4)})
}

// Phase applies a relative phase e^{i*theta} to the |1> component of qubit q.
func (r *Register) Phase(q int, theta float64) {
	r.applySingle(q, [4]complex128{1, 0, 0, cmplx.Exp(complex(0, theta))})
}

// --- Two-qubit gates ---

// CNOT flips target when control is |1>.
func (r *Register) CNOT(control, target int) {
	r.checkQubit(control)
	r.checkQubit(target)
	if control == target {
		panic("quantum: CNOT control and target must differ")
	}
	cbit, tbit := 1<<control, 1<<target
	for i := 0; i < len(r.amps); i++ {
		if i&cbit != 0 && i&tbit == 0 {
			j := i | tbit
			r.amps[i], r.amps[j] = r.amps[j], r.amps[i]
		}
	}
}

// CZ applies a phase flip when both control and target are |1>.
func (r *Register) CZ(control, target int) {
	r.checkQubit(control)
	r.checkQubit(target)
	cbit, tbit := 1<<control, 1<<target
	for i := 0; i < len(r.amps); i++ {
		if i&cbit != 0 && i&tbit != 0 {
			r.amps[i] = -r.amps[i]
		}
	}
}

// CPhase applies a controlled phase rotation e^{i*theta} on |11>.
func (r *Register) CPhase(control, target int, theta float64) {
	r.checkQubit(control)
	r.checkQubit(target)
	cbit, tbit := 1<<control, 1<<target
	p := cmplx.Exp(complex(0, theta))
	for i := 0; i < len(r.amps); i++ {
		if i&cbit != 0 && i&tbit != 0 {
			r.amps[i] *= p
		}
	}
}

// QFT applies the quantum Fourier transform over all qubits.
func (r *Register) QFT() {
	for i := r.n - 1; i >= 0; i-- {
		r.H(i)
		for j := i - 1; j >= 0; j-- {
			r.CPhase(j, i, math.Pi/float64(int(1)<<(i-j)))
		}
	}
	// Reverse qubit order via swaps.
	for i, j := 0, r.n-1; i < j; i, j = i+1, j-1 {
		r.swap(i, j)
	}
}

func (r *Register) swap(a, b int) {
	r.CNOT(a, b)
	r.CNOT(b, a)
	r.CNOT(a, b)
}

// --- Measurement ---

// Probabilities returns the probability of each basis state.
func (r *Register) Probabilities() []float64 {
	out := make([]float64, len(r.amps))
	for i, a := range r.amps {
		out[i] = real(a)*real(a) + imag(a)*imag(a)
	}
	return out
}

// Measure measures qubit q in the computational basis, collapsing the state.
// It returns 0 or 1. Randomness is drawn from crypto/rand.
func (r *Register) Measure(q int) int {
	r.checkQubit(q)
	bit := 1 << q
	var p1 float64
	for i, a := range r.amps {
		if i&bit != 0 {
			p1 += real(a)*real(a) + imag(a)*imag(a)
		}
	}
	outcome := 0
	if randFloat() < p1 {
		outcome = 1
	}
	// Collapse: zero amplitudes inconsistent with the outcome, then renormalise.
	var norm float64
	for i := range r.amps {
		has := i&bit != 0
		if (outcome == 1) != has {
			r.amps[i] = 0
		} else {
			norm += real(r.amps[i])*real(r.amps[i]) + imag(r.amps[i])*imag(r.amps[i])
		}
	}
	if norm > 0 {
		s := complex(1/math.Sqrt(norm), 0)
		for i := range r.amps {
			r.amps[i] *= s
		}
	}
	return outcome
}

// MeasureAll measures every qubit and returns the bit slice (index = qubit).
func (r *Register) MeasureAll() []int {
	out := make([]int, r.n)
	for q := 0; q < r.n; q++ {
		out[q] = r.Measure(q)
	}
	return out
}

// String renders the non-negligible basis states as a ket sum.
func (r *Register) String() string {
	var b strings.Builder
	first := true
	for i, a := range r.amps {
		if cmplx.Abs(a) < 1e-9 {
			continue
		}
		if !first {
			b.WriteString(" + ")
		}
		first = false
		fmt.Fprintf(&b, "(%.3f%+.3fi)|%0*b>", real(a), imag(a), r.n, i)
	}
	if first {
		return "|0>"
	}
	return b.String()
}

func (r *Register) checkQubit(q int) {
	if q < 0 || q >= r.n {
		panic(fmt.Sprintf("quantum: qubit %d out of range [0,%d)", q, r.n))
	}
}

// randFloat returns a uniform float64 in [0,1) sourced from crypto/rand.
func randFloat() float64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("quantum: crypto/rand unavailable: " + err.Error())
	}
	// 53-bit mantissa for an unbiased double in [0,1).
	return float64(binary.BigEndian.Uint64(b[:])>>11) / (1 << 53)
}
