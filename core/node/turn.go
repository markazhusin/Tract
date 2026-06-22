package node

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	"github.com/pion/stun/v3"
	"github.com/pion/turn/v4"
)

// This file makes a node able to RELAY calls — the missing piece for "call
// anywhere", including phones on LTE behind carrier-grade NAT. A node with a
// reachable public address (a citizen's dynamic public IP works, via DDNS +
// port-forward/UPnP) runs an embedded STUN+TURN server (pion). It advertises
// itself through GET /ice so clients use it as the relay of last resort. Media
// stays end-to-end encrypted; the relay only sees ciphertext.

const turnRealm = "tract"

// relayInfo is what /ice advertises once the embedded relay is up.
var relayInfo struct {
	sync.RWMutex
	enabled  bool
	urls     []string
	username string
	password string
}

func relaySnapshot() (urls []string, user, pass string, ok bool) {
	relayInfo.RLock()
	defer relayInfo.RUnlock()
	return relayInfo.urls, relayInfo.username, relayInfo.password, relayInfo.enabled
}

// startTURN brings up the embedded STUN/TURN relay. On error it returns without
// killing the node — the node still does signaling, just won't relay media.
func startTURN(ctx context.Context, opts Options) error {
	port := opts.TURNPort
	if port == "" {
		port = "3478"
	}
	user := opts.TURNUser
	if user == "" {
		user = "tract"
	}
	secret := opts.TURNSecret
	if secret == "" {
		secret = randomSecret()
		log.Printf("[Tract TURN] generated credential — user=%s pass=%s", user, secret)
	}

	// Decide the address to advertise in relay candidates. A relay MUST hand out
	// a publicly reachable address, so we need our public IP (or a DDNS host).
	publicIP, advertiseHost, err := resolvePublic(opts.PublicHost)
	if err != nil {
		return err
	}

	udpListener, err := net.ListenPacket("udp4", "0.0.0.0:"+port)
	if err != nil {
		return fmt.Errorf("turn udp listen on :%s: %w", port, err)
	}

	authKey := turn.GenerateAuthKey(user, turnRealm, secret)
	srv, err := turn.NewServer(turn.ServerConfig{
		Realm: turnRealm,
		AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			if username == user {
				return authKey, true
			}
			return nil, false
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: udpListener,
			// Constrain relay ports to a small, forwardable range so a home
			// router only needs UDP <port> + this range opened.
			RelayAddressGenerator: &turn.RelayAddressGeneratorPortRange{
				RelayAddress: publicIP,
				Address:      "0.0.0.0",
				MinPort:      49160,
				MaxPort:      49200,
			},
		}},
	})
	if err != nil {
		udpListener.Close()
		return fmt.Errorf("turn server: %w", err)
	}

	relayInfo.Lock()
	relayInfo.enabled = true
	relayInfo.urls = []string{fmt.Sprintf("turn:%s:%s?transport=udp", advertiseHost, port)}
	relayInfo.username = user
	relayInfo.password = secret
	relayInfo.Unlock()

	log.Printf("[Tract TURN] relay up — advertising turn:%s:%s (relay ports 49160-49200/udp)", advertiseHost, port)
	log.Printf("[Tract TURN] open on the router: UDP %s and UDP 49160-49200 → this machine (or enable UPnP)", port)

	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	return nil
}

// resolvePublic returns the IP to put in relay candidates and the host string to
// advertise. publicHost may be empty (auto-discover via STUN), an IP literal, or
// a DDNS hostname (advertised as-is, resolved to an IP for the relay generator).
func resolvePublic(publicHost string) (ip net.IP, advertise string, err error) {
	if publicHost != "" {
		if parsed := net.ParseIP(publicHost); parsed != nil {
			if v4 := parsed.To4(); v4 != nil {
				return v4, publicHost, nil
			}
			return nil, "", fmt.Errorf("TURN needs an IPv4 public address, got %q", publicHost)
		}
		// Treat as a DDNS hostname.
		ips, lookupErr := net.LookupIP(publicHost)
		if lookupErr != nil {
			return nil, "", fmt.Errorf("resolve DDNS host %q: %w", publicHost, lookupErr)
		}
		for _, cand := range ips {
			if v4 := cand.To4(); v4 != nil {
				return v4, publicHost, nil // advertise the hostname, relay the IP
			}
		}
		return nil, "", fmt.Errorf("no IPv4 for DDNS host %q", publicHost)
	}

	discovered, derr := discoverPublicIP(6 * time.Second)
	if derr != nil {
		return nil, "", fmt.Errorf("public IP discovery (set PublicHost/DDNS if behind CGNAT): %w", derr)
	}
	log.Printf("[Tract TURN] discovered public IP via STUN: %s", discovered)
	return discovered, discovered.String(), nil
}

// discoverPublicIP asks public STUN servers for our mapped address.
func discoverPublicIP(timeout time.Duration) (net.IP, error) {
	servers := []string{
		"stun.l.google.com:19302",
		"stun1.l.google.com:19302",
		"stun.cloudflare.com:3478",
	}
	var lastErr error
	for _, s := range servers {
		ip, err := stunMappedAddr(s, timeout)
		if err == nil && ip != nil {
			return ip, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no STUN server answered")
	}
	return nil, lastErr
}

func stunMappedAddr(server string, timeout time.Duration) (net.IP, error) {
	c, err := stun.Dial("udp4", server)
	if err != nil {
		return nil, err
	}
	defer c.Close()

	var (
		got  net.IP
		gerr error
		done = make(chan struct{})
	)
	msg := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	if derr := c.Do(msg, func(res stun.Event) {
		defer close(done)
		if res.Error != nil {
			gerr = res.Error
			return
		}
		var xor stun.XORMappedAddress
		if e := xor.GetFrom(res.Message); e != nil {
			gerr = e
			return
		}
		got = append(net.IP(nil), xor.IP...)
	}); derr != nil {
		return nil, derr
	}

	select {
	case <-done:
	case <-time.After(timeout):
		return nil, fmt.Errorf("stun timeout from %s", server)
	}
	if gerr != nil {
		return nil, gerr
	}
	if got == nil {
		return nil, fmt.Errorf("no mapped address from %s", server)
	}
	return got, nil
}

func randomSecret() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
