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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := node.Start(ctx, node.Options{
		Port:    port,
		DataDir: "./data",
		DistDir: "./dist",
		Wipe:    wipe,
	}); err != nil {
		log.Fatalf("[Tract] %v", err)
	}
}
