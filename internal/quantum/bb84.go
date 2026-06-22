package quantum

// BB84 quantum key distribution, run on the state-vector emulator. BB84 lets two
// parties agree on a shared secret key AND detect eavesdropping: any attempt to
// learn the qubits in transit disturbs them (you cannot measure an unknown qubit
// without, in general, perturbing it — the no-cloning theorem), which shows up as
// an elevated error rate (QBER) on a publicly compared sample. If the QBER is over
// the abort threshold, the parties assume interception and THROW THE KEY AWAY — in
// Tract that means the call/chat collapses rather than continuing compromised.
//
// What this code is, honestly:
//   - A faithful BB84 protocol over a real (emulated) quantum channel, including
//     the intercept-resend attack and its ~25% QBER signature. The collapse on
//     measurement is genuine emulator behaviour, not a mock.
//   - Software cannot transmit a physical qubit over a classical network, so the
//     information-theoretic secrecy of real QKD requires real photons. Here BB84
//     serves as a tamper-evident key-agreement ceremony layered on the existing
//     authenticated/E2E channel: an active attacker who disturbs the exchange is
//     detected by the QBER check and the session is torn down.
//
// Bases: Rectilinear (Z, {|0>,|1>}) and Diagonal (X, {|+>,|->}).

import (
	"crypto/sha256"
)

// Basis is the measurement/preparation basis of a qubit.
type Basis int

const (
	Rectilinear Basis = 0 // Z basis: |0>, |1>
	Diagonal    Basis = 1 // X basis: |+>, |->
)

// QBERAbortThreshold is the sampled error rate above which we assume the channel
// is compromised and abort. Honest channels sit near 0; an intercept-resend
// eavesdropper drives QBER toward 25%, so 15% cleanly separates the two.
const QBERAbortThreshold = 0.15

// prepare returns a 1-qubit register encoding bit in the given basis.
//
//	Rectilinear: bit 0 -> |0>, bit 1 -> |1>
//	Diagonal:    bit 0 -> |+>, bit 1 -> |->
func prepare(bit int, basis Basis) *Register {
	r := New(1)
	if bit == 1 {
		r.X(0) // |0> -> |1>
	}
	if basis == Diagonal {
		r.H(0) // |0>->|+>, |1>->|->
	}
	return r
}

// measure measures the register in the given basis and returns the bit. Measuring
// in the diagonal basis is a Hadamard followed by a computational measurement.
func measure(r *Register, basis Basis) int {
	if basis == Diagonal {
		r.H(0)
	}
	return r.Measure(0)
}

// randBit returns a random classical bit. Alice's data bits and both parties'
// basis *choices* are classical decisions a real QKD device makes with a local
// RNG — they are never themselves transmitted as qubits — so we draw them from
// crypto/rand. The quantum emulator is reserved for the qubits that actually
// travel the channel (prepare/measure), where collapse-on-measurement is what
// makes eavesdropping detectable. (Sampling a bit via the emulator would mean
// allocating a fresh register per coin flip — correct but needlessly costly.)
func randBit() int {
	if randFloat() < 0.5 {
		return 0
	}
	return 1
}

func randBasis() Basis {
	if randBit() == 1 {
		return Diagonal
	}
	return Rectilinear
}

// Result is the outcome of a BB84 run.
type Result struct {
	Key       []byte  // derived shared key (empty if aborted)
	KeyBits   []int   // sifted+checked key bits both sides hold (empty if aborted)
	QBER      float64 // measured error rate on the sampled bits
	Sifted    int     // number of bits surviving basis sifting
	Sampled   int     // number of sifted bits sacrificed to estimate QBER
	Aborted   bool    // true if QBER exceeded the threshold (eavesdropper assumed)
	Agreement bool    // true if both parties' surviving key bits matched
}

// Eavesdropper models an intercept-resend attacker on the quantum channel: it
// measures each qubit in a basis it guesses, then resends a fresh qubit prepared
// from what it saw. When its basis guess is wrong it both learns nothing useful
// AND disturbs the state, producing detectable errors.
type Eavesdropper struct{ active bool }

// Eve returns an active intercept-resend eavesdropper.
func Eve() *Eavesdropper { return &Eavesdropper{active: true} }

func (e *Eavesdropper) tap(r *Register) *Register {
	if e == nil || !e.active {
		return r
	}
	g := randBasis()
	bit := measure(r, g) // collapses r
	return prepare(bit, g)
}

// Simulate runs a full BB84 exchange over n qubits between two honest parties,
// optionally with an eavesdropper on the line. It returns the agreed key and the
// QBER-based verdict. This is the in-process reference used by tests and demos;
// the live protocol (see the Sender/Receiver steps) exchanges the same data over
// the network.
func Simulate(n int, eve *Eavesdropper) Result {
	// Alice's random bits and bases.
	aBits := make([]int, n)
	aBases := make([]Basis, n)
	bBases := make([]Basis, n)
	bBits := make([]int, n)

	for i := 0; i < n; i++ {
		aBits[i] = randBit()
		aBases[i] = randBasis()
		bBases[i] = randBasis()

		q := prepare(aBits[i], aBases[i])
		q = eve.tap(q) // possible interception (collapses + resends)
		bBits[i] = measure(q, bBases[i])
	}

	return reconcile(aBits, aBases, bBits, bBases)
}

// reconcile performs sifting, QBER sampling and key derivation given both sides'
// bits and bases. Splitting it out keeps the network protocol and the in-process
// simulation sharing one implementation.
func reconcile(aBits []int, aBases []Basis, bBits []int, bBases []Basis) Result {
	// Sift: keep positions where the bases matched.
	var aSift, bSift []int
	for i := range aBits {
		if aBases[i] == bBases[i] {
			aSift = append(aSift, aBits[i])
			bSift = append(bSift, bBits[i])
		}
	}
	res := Result{Sifted: len(aSift)}
	if len(aSift) == 0 {
		res.Aborted = true
		return res
	}

	// Sacrifice ~half the sifted bits (deterministically: even indices) to
	// estimate QBER by public comparison.
	var mism, sampled int
	keepA := aSift[:0:0] // fresh slice, don't alias
	keepB := []int{}
	for i := range aSift {
		if i%2 == 0 {
			sampled++
			if aSift[i] != bSift[i] {
				mism++
			}
		} else {
			keepA = append(keepA, aSift[i])
			keepB = append(keepB, bSift[i])
		}
	}
	res.Sampled = sampled
	if sampled > 0 {
		res.QBER = float64(mism) / float64(sampled)
	}

	if res.QBER > QBERAbortThreshold {
		res.Aborted = true
		return res
	}

	// Surviving bits form the key; both sides must agree on every one.
	res.Agreement = equalInts(keepA, keepB)
	if !res.Agreement || len(keepA) == 0 {
		res.Aborted = true
		return res
	}
	res.KeyBits = keepA
	res.Key = DeriveKey(keepA)
	return res
}

// DeriveKey turns sifted key bits into a 32-byte key via SHA-256 (a stand-in for
// proper privacy amplification — it compresses the agreed bits into a uniform key).
func DeriveKey(bits []int) []byte {
	packed := make([]byte, (len(bits)+7)/8)
	for i, b := range bits {
		if b == 1 {
			packed[i/8] |= 1 << uint(i%8)
		}
	}
	sum := sha256.Sum256(packed)
	return sum[:]
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
