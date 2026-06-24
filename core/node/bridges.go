package node

import (
	"os"
	"os/exec"
	"strings"
)

// Pluggable-transport bridge support for the node's Tor onion service, for networks
// that BLOCK Tor itself. The strategy mirrors how Tor Browser survives censorship:
//
//   - Snowflake (primary): a WebRTC pluggable transport whose broker continuously
//     hands out FRESH, ephemeral volunteer proxies via a domain-fronted rendezvous.
//     There is no fixed address to block and no CAPTCHA, so it keeps pulling working
//     proxies indefinitely — exactly "always working where Tor is blocked".
//   - obfs4 (secondary): a set of obfuscated bridges that look like random traffic.
//     Static built-ins here; they rotate over time upstream.
//
// Bridges need the pluggable-transport client binaries present (snowflake-client /
// snowflake, and obfs4proxy / lyrebird). They're tiny and installable
// (`brew install snowflake obfs4proxy`, `apt install snowflake-client obfs4proxy`).
// If none are found, bridge mode is skipped with a hint and direct Tor is used.

// ptClients locates the pluggable-transport binaries, honoring env overrides.
// Returns the snowflake and obfs4 client paths (either may be empty if absent).
func ptClients() (snowflake, obfs4 string) {
	snowflake = firstExisting(
		strings.TrimSpace(os.Getenv("SNOWFLAKE_CLIENT")),
		"snowflake-client", "snowflake", "client",
	)
	obfs4 = firstExisting(
		strings.TrimSpace(os.Getenv("OBFS4PROXY")),
		"obfs4proxy", "lyrebird",
	)
	return
}

// firstExisting returns the first arg that is an executable path or resolves on PATH.
func firstExisting(candidates ...string) string {
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if strings.ContainsRune(c, os.PathSeparator) {
			if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
				return c
			}
			continue
		}
		if p, err := exec.LookPath(c); err == nil {
			return p
		}
	}
	return ""
}

// Built-in Snowflake configuration — the same public broker/STUN/front parameters
// Tor Browser ships. The broker rotates the actual proxies, so this single line keeps
// yielding fresh working paths without any per-bridge maintenance.
const snowflakeBridgeLine = "snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 " +
	"fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 " +
	"url=https://1098762253.rsc.cdn77.org/ " +
	"fronts=www.cdn77.com,www.phpmyadmin.net " +
	"ice=stun:stun.l.google.com:19302,stun:stun.antisip.com:3478,stun:stun.epygi.com:3478," +
	"stun:stun.uls.co.za:3478,stun:stun.voipgate.com:3478,stun:stun.mixvoip.com:3478 " +
	"utls-imitate=hellorandomizedalpn"

// Built-in obfs4 bridges (public, from Tor Browser's shipped set). These rotate
// upstream; Snowflake is the durable primary, these are a fallback.
var builtinObfs4Bridges = []string{
	"obfs4 192.95.36.142:443 CDF2E852BF539B82BD10E27E9115A31734E378C2 cert=qUVQ0srL1JI/vO6V6m/24anYXiJD3QP2HgzUKQtQ7GRqqUvs7P+tG43RtAqdhLOALP7DJQ iat-mode=1",
	"obfs4 37.218.245.14:38224 D9A82D2F9C2F65A18407B1D2B764F130847F8B5D cert=bjRaMrr1BRiAW8IE9U5z27fQaYgOhX1UCmOpg2pFpoMvo6ZgQMzLsaTzzQNTlm7hNcb6Sg iat-mode=0",
	"obfs4 85.31.186.98:443 011F2599C0E9B27EE74B353155E244813763C3E5 cert=ayq0XzCwhpdysn5o0EyDUbmSOx3X/oTEbzDMvczHOdBJKlvIdHHLJGkZARtT4dcBFArPPg iat-mode=0",
	"obfs4 85.31.186.26:443 91A6354697E6B02A386312F68D82CF86824D3606 cert=PBwr+S8JTVZo6MPdHnkTwXJPILWADLqfMGoVvhZClMq/Urndyd42BwX9YFJHZnBB3H0XCw iat-mode=0",
	"obfs4 193.11.166.194:27015 2D82C2E354D531A68469ADF7F878FA6060C6BACA cert=4TLQPJrTSaDffMK7Nbao6LC7G9OW/NHkUwIdjLSS3KYf0Nv4/nQiiI8dY2TcsQx01NniO iat-mode=0",
}

// buildBridgeTorrc assembles the torrc lines that turn on bridge mode with whatever
// pluggable transports are available. Returns the lines and whether any usable PT was
// configured (false → caller should stay on direct Tor).
func buildBridgeTorrc() (lines []string, ok bool) {
	snowflake, obfs4 := ptClients()
	if snowflake == "" && obfs4 == "" {
		return nil, false
	}
	lines = append(lines, "UseBridges 1")
	if snowflake != "" {
		// Snowflake speaks the PT spec; its broker continuously supplies fresh proxies.
		lines = append(lines, "ClientTransportPlugin snowflake exec "+snowflake)
		lines = append(lines, "Bridge "+snowflakeBridgeLine)
	}
	if obfs4 != "" {
		lines = append(lines, "ClientTransportPlugin obfs4 exec "+obfs4)
		for _, b := range builtinObfs4Bridges {
			lines = append(lines, "Bridge "+b)
		}
	}
	return lines, true
}
