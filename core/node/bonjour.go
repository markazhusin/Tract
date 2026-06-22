package node

import (
	"context"
	"log"
	"os"
	"strconv"

	"github.com/grandcat/zeroconf"
)

// Bonjour/mDNS makes this node an automatic LAN entry point: it advertises the
// signaling service so nearby devices discover and use it with zero config — no
// typing an IP, no hosting. Every device that runs a node becomes a local entry
// point this way. Works on the local network only (mDNS doesn't cross routers).
const bonjourService = "_tract._tcp"

// startBonjour advertises the signaling port over mDNS until ctx is cancelled.
func startBonjour(ctx context.Context, portStr string) {
	port, err := strconv.Atoi(portStr)
	if err != nil {
		port = 8877
	}
	instance, _ := os.Hostname()
	if instance == "" {
		instance = "tract-node"
	}
	server, err := zeroconf.Register(instance, bonjourService, "local.", port, []string{"app=tract", "v=1"}, nil)
	if err != nil {
		log.Printf("[Tract Bonjour] advertise failed: %v", err)
		return
	}
	log.Printf("[Tract Bonjour] advertising %s as %q on port %d (LAN auto-discovery)", bonjourService, instance, port)
	go func() {
		<-ctx.Done()
		server.Shutdown()
	}()
}
