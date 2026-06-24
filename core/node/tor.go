package node

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/cretz/bine/tor"
)

// startOnion publishes this node as a Tor v3 hidden service, so it is reachable
// with NO open ports and in an ISP-opaque way: to the network operator the traffic
// is indistinguishable from ordinary Tor, and there is no inbound port to forward,
// scan, or block. The same HTTP handler that serves the clearnet port is served on
// the .onion address, so clients that know the onion can reach the node from behind
// any NAT/CGNAT/firewall.
//
// This drives the project's "a node anywhere, no hosting, no ports" goal. It is
// best-effort and fully optional: it controls an EXTERNAL `tor` binary via the
// control protocol (no CGO, so the node stays a static binary). If no tor binary is
// available, the node logs a one-line hint and keeps running normally on TCP.
//
//	TRACT_TOR=0            disable (default: enabled when a tor binary is present)
//	TOR_BINARY=/path/tor   explicit tor binary (else looked up on PATH)
//
// The onion private key is persisted under <dataDir>/tor so the .onion address is
// STABLE across restarts (share it once; it keeps working).
func startOnion(ctx context.Context, dataDir, localPort string, handler http.Handler) {
	if v := strings.TrimSpace(os.Getenv("TRACT_TOR")); v == "0" || strings.EqualFold(v, "false") {
		return
	}

	exePath := strings.TrimSpace(os.Getenv("TOR_BINARY"))
	if exePath == "" {
		if _, err := lookTor(); err != nil {
			log.Printf("[Tract/Tor] no `tor` binary found — onion reachability off. " +
				"Install Tor (e.g. `brew install tor` / `apt install tor`) or set TOR_BINARY to enable a no-ports .onion address.")
			return
		}
	}

	key, err := loadOrCreateOnionKey(dataDir)
	if err != nil {
		log.Printf("[Tract/Tor] onion key error: %v — onion off", err)
		return
	}

	// Run the whole bring-up off the main path; tor bootstrap takes ~10-30s.
	go func() {
		startConf := &tor.StartConf{
			ExePath:       exePath, // "" → bine looks up `tor` on PATH
			EnableNetwork: true,
			NoHush:        true,
			// Keep tor's scratch files in our data dir, not the process CWD (bine's
			// default would litter the working directory with data-dir-* folders).
			TempDataDirBase:   filepath.Join(dataDir, "tor"),
			RetainTempDataDir: false,
		}
		t, err := tor.Start(ctx, startConf)
		if err != nil {
			log.Printf("[Tract/Tor] could not start tor: %v — onion off", err)
			return
		}
		// Tear tor down when the node context is cancelled.
		go func() { <-ctx.Done(); _ = t.Close() }()

		listenCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		defer cancel()

		onion, err := t.Listen(listenCtx, &tor.ListenConf{
			Version3:    true,
			Key:         key,
			RemotePorts: []int{80},
		})
		if err != nil {
			log.Printf("[Tract/Tor] could not publish onion service: %v — onion off", err)
			return
		}

		log.Printf("[Tract/Tor] reachable with NO open ports at: http://%s.onion", onion.ID)
		log.Printf("[Tract/Tor] share this address (paste/QR) — it is stable across restarts.")

		// Serve the SAME handler over the onion listener. A dedicated server so its
		// lifecycle is independent of the clearnet one.
		srv := &http.Server{Handler: handler}
		go func() { <-ctx.Done(); _ = srv.Close() }()
		if err := srv.Serve(onion); err != nil && err != http.ErrServerClosed {
			log.Printf("[Tract/Tor] onion server stopped: %v", err)
		}
	}()
}

// loadOrCreateOnionKey returns a persistent ed25519 key for the v3 onion service,
// creating and storing one under <dataDir>/tor on first run (mode 0600).
func loadOrCreateOnionKey(dataDir string) (ed25519.PrivateKey, error) {
	dir := filepath.Join(dataDir, "tor")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	keyPath := filepath.Join(dir, "onion_ed25519.key")

	if data, err := os.ReadFile(keyPath); err == nil && len(data) == ed25519.PrivateKeySize {
		return ed25519.PrivateKey(data), nil
	}

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, priv, 0600); err != nil {
		return nil, err
	}
	return priv, nil
}

// lookTor reports whether a `tor` binary is on PATH.
func lookTor() (string, error) {
	return exec.LookPath("tor")
}
