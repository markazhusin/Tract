package quantum

import "testing"

// An honest channel: bases that match always yield identical bits on the emulator,
// so QBER is 0, nothing aborts, and both sides hold the same key.
func TestBB84HonestAgrees(t *testing.T) {
	res := Simulate(512, nil)
	if res.Aborted {
		t.Fatalf("honest run aborted unexpectedly (QBER=%.3f)", res.QBER)
	}
	if !res.Agreement {
		t.Fatal("honest run keys disagree")
	}
	if res.QBER != 0 {
		t.Fatalf("honest QBER should be 0, got %.3f", res.QBER)
	}
	if len(res.Key) != 32 {
		t.Fatalf("expected 32-byte key, got %d", len(res.Key))
	}
}

// An intercept-resend eavesdropper drives QBER toward ~25%, far above the 15%
// abort threshold, so the session is reliably torn down.
func TestBB84DetectsEavesdropper(t *testing.T) {
	aborts := 0
	const runs = 12
	for i := 0; i < runs; i++ {
		res := Simulate(600, Eve())
		if res.Aborted {
			aborts++
		}
	}
	if aborts < runs {
		t.Fatalf("eavesdropper went undetected in %d/%d runs", runs-aborts, runs)
	}
}

func TestDeriveKeyDeterministic(t *testing.T) {
	bits := []int{1, 0, 1, 1, 0, 0, 1, 0, 1}
	if string(DeriveKey(bits)) != string(DeriveKey(bits)) {
		t.Fatal("DeriveKey must be deterministic")
	}
	if string(DeriveKey(bits)) == string(DeriveKey([]int{0, 0, 0})) {
		t.Fatal("different bits must derive different keys")
	}
}
