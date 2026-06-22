package node

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"tract-signaling/internal/mainline"
	"tract-signaling/internal/serverless"
)

// DHT federation: a node announces which users are online on it (key derived from
// userId → this node's reachable URL) and looks users up the same way, so users on
// DIFFERENT nodes still reach each other with no central server. Rendezvous runs
// over TWO independent DHTs and the union of their answers is used:
//
//   - PRIMARY: the GLOBAL BitTorrent Mainline DHT (internal/mainline, BEP-5/44).
//     Cards are stored as BEP-44 mutable items in the public swarm of millions of
//     nodes — genuinely serverless, no Tract bootstrap node required.
//   - FALLBACK: the private Tract Kademlia (internal/serverless). Works on LAN and
//     between Tract nodes that bootstrap off each other; useful where the public
//     DHT is blocked/firewalled.
var (
	dhtNode      *serverless.Node // private Kademlia (fallback)
	mlDHT        *mainline.DHT    // global Mainline DHT (primary)
	selfURL      string
	announceMu   sync.Mutex
	lastAnnounce = map[string]time.Time{}
)

func userKey(userId string) serverless.NodeID {
	return serverless.HashID([]byte("tract-user:" + strings.ToLower(strings.TrimSpace(userId))))
}

// userKeyPair derives the deterministic BEP-44 keypair both sides compute from a
// userId, so any node can refresh "user U lives here" and any peer can read it.
func userKeyPair(userId string) (ed25519.PublicKey, ed25519.PrivateKey) {
	seed := sha256.Sum256([]byte("tract-user:" + strings.ToLower(strings.TrimSpace(userId))))
	return mainline.KeyPairFromSeed(seed)
}

func startDHT(ctx context.Context, opts Options) {
	listen := opts.DHTPort
	if listen == "" {
		listen = "0.0.0.0:8878"
	} else if !strings.Contains(listen, ":") {
		listen = "0.0.0.0:" + listen
	}
	// Advertise a ROUTABLE address (not the bound 0.0.0.0/[::]) so other DHT nodes
	// can call back. Uses PublicHost when set (internet federation), else loopback.
	host := opts.PublicHost
	if host == "" {
		host = "127.0.0.1"
	}
	_, dhtPortPart, splitErr := net.SplitHostPort(listen)
	if splitErr != nil {
		dhtPortPart = "8878"
	}
	advertiseUDP := net.JoinHostPort(host, dhtPortPart)

	n, err := serverless.NewNode(serverless.GenerateNodeID(), listen, advertiseUDP)
	if err != nil {
		log.Printf("[Tract DHT] private Kademlia disabled: %v", err)
	} else {
		dhtNode = n
	}

	selfURL = strings.TrimRight(opts.AdvertiseURL, "/")
	if selfURL == "" {
		host := opts.PublicHost
		if host == "" {
			host = "127.0.0.1"
		}
		selfURL = "http://" + host + ":" + opts.Port
	}

	if dhtNode != nil {
		for _, b := range strings.Split(opts.DHTBootstrap, ",") {
			if b = strings.TrimSpace(b); b == "" {
				continue
			}
			if err := dhtNode.Bootstrap(b); err != nil {
				log.Printf("[Tract DHT] private bootstrap %s failed: %v", b, err)
			} else {
				log.Printf("[Tract DHT] joined private mesh via %s", b)
			}
		}
		log.Printf("[Tract DHT] private node %s up on %s — advertising self as %s",
			dhtNode.ID().String()[:12], dhtNode.Addr(), selfURL)
	}

	// PRIMARY: join the global BitTorrent Mainline DHT unless disabled.
	if !opts.MainlineOff {
		if ml, err := mainline.New("0.0.0.0:0"); err != nil {
			log.Printf("[Tract DHT] mainline disabled: %v", err)
		} else {
			mlDHT = ml
			go func() {
				answered := ml.Bootstrap(splitCSV(opts.MainlineBootstrap)...)
				log.Printf("[Tract DHT] mainline up on %s — %d public router(s) answered",
					ml.Addr(), answered)
			}()
		}
	}

	go func() {
		<-ctx.Done()
		if dhtNode != nil {
			dhtNode.Close()
		}
		if mlDHT != nil {
			mlDHT.Close()
		}
	}()
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// announceUser publishes (this user is reachable at selfURL) into BOTH DHTs,
// throttled so a 5s heartbeat doesn't hammer the network.
func announceUser(userId string) {
	if selfURL == "" || userId == "" || (dhtNode == nil && mlDHT == nil) {
		return
	}
	key := normalizeUserId(userId)
	announceMu.Lock()
	if t, ok := lastAnnounce[key]; ok && time.Since(t) < 60*time.Second {
		announceMu.Unlock()
		return
	}
	lastAnnounce[key] = time.Now()
	announceMu.Unlock()

	if dhtNode != nil {
		go dhtNode.Announce(userKey(key), []byte(selfURL))
	}
	if mlDHT != nil {
		go func() {
			pub, priv := userKeyPair(key)
			// seq must strictly increase; unix seconds is monotonic enough and lets
			// any node refresh the record with a fresher value winning.
			seq := time.Now().Unix()
			if _, err := mlDHT.Put(pub, priv, nil, []byte(selfURL), seq); err != nil {
				log.Printf("[Tract DHT] mainline put for %s: %v", key, err)
			}
		}()
	}
}

// locateUser returns the node URLs that recently had this user online, unioned
// across the global Mainline DHT (primary) and the private Kademlia (fallback).
func locateUser(userId string) []string {
	key := normalizeUserId(userId)
	seen := map[string]bool{}
	out := []string{}
	add := func(s string) {
		s = strings.TrimRight(s, "/")
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	if mlDHT != nil {
		pub, _ := userKeyPair(key)
		if v, _, ok := mlDHT.Get(pub, nil); ok {
			add(string(v))
		}
	}
	if dhtNode != nil {
		for _, v := range dhtNode.Discover(userKey(key)) {
			add(string(v))
		}
	}
	return out
}

// forwardSignal relays a /signal body to another node (federation hop).
func forwardSignal(nodeURL string, body []byte) {
	req, err := http.NewRequest("POST", strings.TrimRight(nodeURL, "/")+"/signal", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tract-Forwarded", "1") // mark so the peer node won't re-forward
	client := http.Client{Timeout: 5 * time.Second}
	if resp, err := client.Do(req); err == nil {
		resp.Body.Close()
	}
}
