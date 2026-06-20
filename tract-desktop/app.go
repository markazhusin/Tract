package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"tract-signaling/core/node"
)

// App is the desktop client. Crucially it also embeds the network node: this one
// process is both client (the UI) and server (a live Tract node), which is the
// whole point — every device is a node, not a client of someone else's server.
type App struct {
	ctx      context.Context
	nodePort string
	dataDir  string
}

func NewApp() *App {
	home, _ := os.UserHomeDir()
	return &App{
		nodePort: "8877",
		dataDir:  filepath.Join(home, ".tract-desktop", "data"),
	}
}

// startup boots the embedded node for the app's whole lifetime.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go func() {
		if err := node.Start(ctx, node.Options{
			Port:    a.nodePort,
			DataDir: a.dataDir,
		}); err != nil {
			fmt.Println("[tract-desktop] embedded node stopped:", err)
		}
	}()
}

// NodeStatus returns the embedded node's /health as JSON — the client half of
// this app talking to the server half running in the same process.
func (a *App) NodeStatus() string {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + a.nodePort + "/health")
	if err != nil {
		return `{"status":"starting"}`
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

// NodeURL is the address other devices on this network can reach this node at.
func (a *App) NodeURL() string {
	return "http://127.0.0.1:" + a.nodePort
}
