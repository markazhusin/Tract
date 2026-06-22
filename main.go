package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"tract-signaling/core/node"
)

// tract-node: thin entrypoint around the embeddable node core (core/node), the
// same core the desktop app and (later) Android embed. Behaviour is unchanged —
// PORT, ./data, ./dist static, TRACT_WIPE, graceful shutdown.
func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8877"
	}

	// One-shot data wipe: TRACT_WIPE=1 erases ALL stored data on boot.
	wipe := false
	if v := strings.TrimSpace(os.Getenv("TRACT_WIPE")); v == "1" || strings.EqualFold(v, "true") {
		wipe = true
		log.Printf("[Tract] TRACT_WIPE=%s — all stored data will be erased.", v)
	}

	// Embedded STUN/TURN relay is on by default (a node is also a relay).
	// Disable with TRACT_TURN=0. Behind CGNAT, set TRACT_PUBLIC_HOST to a DDNS
	// name / public IP so relay candidates are reachable.
	turnOn := true
	if v := strings.TrimSpace(os.Getenv("TRACT_TURN")); v == "0" || strings.EqualFold(v, "false") {
		turnOn = false
	}

	// Global Mainline DHT (BEP-5/44) rendezvous is on by default; TRACT_MAINLINE=0
	// disables it (e.g. on networks where the public DHT is blocked).
	mainlineOff := false
	if v := strings.TrimSpace(os.Getenv("TRACT_MAINLINE")); v == "0" || strings.EqualFold(v, "false") {
		mainlineOff = true
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dataDir := strings.TrimSpace(os.Getenv("TRACT_DATA"))
	if dataDir == "" {
		dataDir = "./data"
	}

	if err := node.Start(ctx, node.Options{
		Port:         port,
		DataDir:      dataDir,
		DistDir:      "./dist",
		Wipe:         wipe,
		TURN:         turnOn,
		PublicHost:   strings.TrimSpace(os.Getenv("TRACT_PUBLIC_HOST")),
		Bonjour:      true,
		DHT:          true,
		DHTPort:      strings.TrimSpace(os.Getenv("TRACT_DHT_PORT")),
		DHTBootstrap: strings.TrimSpace(os.Getenv("TRACT_DHT_BOOTSTRAP")),
		AdvertiseURL: strings.TrimSpace(os.Getenv("TRACT_ADVERTISE_URL")),
		// Global Mainline DHT is on by default; disable with TRACT_MAINLINE=0.
		MainlineOff:       mainlineOff,
		MainlineBootstrap: strings.TrimSpace(os.Getenv("TRACT_MAINLINE_BOOTSTRAP")),
	}); err != nil {
		log.Fatalf("[Tract] %v", err)
	}
}
