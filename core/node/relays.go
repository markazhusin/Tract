package node

import (
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// Public managed relays the node hands to clients via GET /ice, in addition to
// (a) this node's own embedded TURN, if running, and (b) the TURN_URLS env entry.
// These are reliable relays of last resort so calls connect even through
// symmetric/CGNAT NAT where direct paths and a home relay fail.

// ExpressTURN is a shared, managed TURN account. A TURN credential is necessarily
// shipped to clients (that is how TURN auth works), so this is not a secret —
// unlike the GetStream secret, which never leaves the node. Override per-deploy
// with EXPRESSTURN_URL / EXPRESSTURN_USER / EXPRESSTURN_CRED; set EXPRESSTURN_URL
// to "off" to drop it.
const (
	expressTURNURL  = "turn:free.expressturn.com:3478"
	expressTURNUser = "000000002097466615"
	expressTURNCred = "XbNNDiAEa142/ZiNAhE8/Ab3qTQ="
)

// publicRelayICEServers returns the managed-relay ICE entries to advertise.
func publicRelayICEServers() []gin.H {
	url := envOr("EXPRESSTURN_URL", expressTURNURL)
	if strings.EqualFold(strings.TrimSpace(url), "off") || url == "" {
		return nil
	}
	user := envOr("EXPRESSTURN_USER", expressTURNUser)
	cred := envOr("EXPRESSTURN_CRED", expressTURNCred)

	// A STUN entry on the same host first (server-reflexive candidates for direct
	// connections), then the authenticated TURN entry as the relay fallback.
	stun := "stun:" + strings.TrimPrefix(strings.SplitN(url, "?", 2)[0], "turn:")
	return []gin.H{
		{"urls": []string{stun}},
		{"urls": []string{url}, "username": user, "credential": cred},
	}
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
