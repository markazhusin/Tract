package node

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
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
// is indistinguishable from ordinary Tor (or, with bridges, from random/WebRTC
// traffic), and there is no inbound port to forward, scan, or block. The same HTTP
// handler that serves the clearnet port is served on the .onion address.
//
// Censorship resilience: it first tries a direct Tor connection; if that can't
// bootstrap (Tor is blocked on this network), it RETRIES FOREVER using pluggable-
// transport bridges — Snowflake primarily, whose broker keeps supplying fresh
// volunteer proxies, plus obfs4 — so a node behind censorship keeps trying to come
// online indefinitely. See bridges.go.
//
// Best-effort and optional; controls an EXTERNAL tor binary via the control protocol
// (no CGO, so the node stays a static binary). If no tor binary is present the node
// logs a hint and keeps running normally on TCP.
//
//	TRACT_TOR=0             disable (default: enabled when a tor binary is present)
//	TOR_BINARY=/path/tor    explicit tor binary (else looked up on PATH)
//	TRACT_TOR_BRIDGES=1     start with bridges immediately (skip the direct attempt)
//	SNOWFLAKE_CLIENT, OBFS4PROXY   explicit pluggable-transport client binaries
//
// The onion private key is persisted under <dataDir>/tor so the .onion address is
// STABLE across restarts (share it once; it keeps working).
func startOnion(ctx context.Context, dataDir, localPort string, handler http.Handler) {
	if v := strings.TrimSpace(os.Getenv("TRACT_TOR")); v == "0" || strings.EqualFold(v, "false") {
		return
	}

	exePath := strings.TrimSpace(os.Getenv("TOR_BINARY"))
	if exePath == "" {
		if _, err := exec.LookPath("tor"); err != nil {
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

	// Force bridges from the start if asked (e.g. you already know Tor is blocked).
	forceBridges := false
	if v := strings.TrimSpace(os.Getenv("TRACT_TOR_BRIDGES")); v == "1" || strings.EqualFold(v, "true") {
		forceBridges = true
	}

	go func() {
		attempt := 0
		for ctx.Err() == nil {
			attempt++
			// Attempt 1 is direct (unless forced); every later attempt uses bridges,
			// which is what survives a network that blocks Tor.
			useBridges := forceBridges || attempt > 1

			err := bringUpOnion(ctx, exePath, dataDir, localPort, key, handler, useBridges)
			if ctx.Err() != nil {
				return // node shutting down
			}
			log.Printf("[Tract/Tor] attempt %d failed (%v) — retrying with %s. "+
				"A blocked network keeps retrying; Snowflake pulls fresh proxies each time.",
				attempt, err, transportLabel(useBridges || attempt >= 1))

			// Capped backoff so we keep trying indefinitely without hammering.
			wait := time.Duration(attempt) * 10 * time.Second
			if wait > 2*time.Minute {
				wait = 2 * time.Minute
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
	}()
}

// bringUpOnion starts tor (optionally with bridges), publishes the onion service, and
// serves the handler on it until the context is cancelled or a fatal error occurs.
// Returns an error if tor couldn't start or the onion couldn't be published in time.
func bringUpOnion(ctx context.Context, exePath, dataDir, localPort string,
	key ed25519.PrivateKey, handler http.Handler, useBridges bool) error {

	startConf := &tor.StartConf{
		ExePath:       exePath, // "" → bine looks up `tor` on PATH
		EnableNetwork: true,
		NoHush:        true,
		// Keep tor's scratch files in our data dir, not the process CWD.
		TempDataDirBase:   filepath.Join(dataDir, "tor"),
		RetainTempDataDir: false,
	}

	// Bridge mode: write a torrc with UseBridges + pluggable transports.
	var torrcPath string
	if useBridges {
		lines, ok := buildBridgeTorrc()
		if !ok {
			return fmt.Errorf("bridges requested but no pluggable-transport client found " +
				"(install `snowflake`/`obfs4proxy`, or set SNOWFLAKE_CLIENT/OBFS4PROXY)")
		}
		p, err := writeTorrc(dataDir, lines)
		if err != nil {
			return fmt.Errorf("write bridge torrc: %w", err)
		}
		torrcPath = p
		startConf.TorrcFile = p
		log.Printf("[Tract/Tor] starting with bridges (%s) to get through Tor blocking…", transportLabel(true))
	}

	t, err := tor.Start(ctx, startConf)
	if err != nil {
		return fmt.Errorf("start tor: %w", err)
	}
	defer t.Close()
	if torrcPath != "" {
		defer os.Remove(torrcPath)
	}

	// Bridges (esp. Snowflake's WebRTC rendezvous) need longer to find a path.
	publishTimeout := 90 * time.Second
	if useBridges {
		publishTimeout = 4 * time.Minute
	}
	listenCtx, cancel := context.WithTimeout(ctx, publishTimeout)
	defer cancel()

	onion, err := t.Listen(listenCtx, &tor.ListenConf{
		Version3:    true,
		Key:         key,
		RemotePorts: []int{80},
	})
	if err != nil {
		return fmt.Errorf("publish onion: %w", err)
	}

	log.Printf("[Tract/Tor] reachable with NO open ports at: http://%s.onion", onion.ID)
	log.Printf("[Tract/Tor] share this address (paste/QR) — it is stable across restarts.")

	srv := &http.Server{Handler: handler}
	go func() { <-ctx.Done(); _ = srv.Close() }()
	// Blocks until the onion listener closes (ctx cancel) or errors.
	if err := srv.Serve(onion); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("onion server: %w", err)
	}
	return nil
}

func transportLabel(bridges bool) string {
	if bridges {
		return "bridges: Snowflake + obfs4"
	}
	return "direct Tor"
}

// writeTorrc writes the given torrc lines to <dataDir>/tor/bridges.torrc.
func writeTorrc(dataDir string, lines []string) (string, error) {
	dir := filepath.Join(dataDir, "tor")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "bridges.torrc")
	body := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		return "", err
	}
	return path, nil
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
