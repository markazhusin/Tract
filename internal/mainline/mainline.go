// Package mainline is a small client for the GLOBAL BitTorrent Mainline DHT
// (BEP-5) with mutable-item storage (BEP-44). Unlike internal/serverless (a
// private Tract-only Kademlia), this rides the real, public DHT of millions of
// BitTorrent nodes, bootstrapping off the well-known public routers. That makes
// it a genuinely serverless rendezvous: a Tract node PUTs a tiny signed card
// ("user U is reachable at node N") under a key derived from U, and any other
// node GETs that key back from the swarm — no Tract bootstrap node, no central
// signaling server.
//
// Honesty notes:
//   - This speaks real KRPC/bencode and interoperates with the public DHT.
//   - BEP-44 values are capped at 1000 bytes, so we store a short node URL /
//     compact card, not a full SDP. The card points peers at each other; the
//     existing WebRTC + node layer carries the actual offer/answer.
//   - A passive observer of the DHT can read these cards (they are public by
//     design); confidentiality of conversations lives in the E2E layer, not here.
//   - stdlib + crypto/ed25519 only.
package mainline

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha1"
	"encoding/binary"
	"fmt"
	"net"
	"sort"
	"strconv"
	"sync"
	"time"
)

const (
	idLen      = 20
	k          = 8 // closest-nodes kept per lookup
	alpha      = 6 // lookup parallelism
	rpcTimeout = 3 * time.Second
	maxValue   = 1000 // BEP-44 value cap (bytes)
)

// PublicRouters are the well-known Mainline DHT bootstrap nodes. Any one being
// reachable is enough to join the global swarm.
var PublicRouters = []string{
	"router.bittorrent.com:6881",
	"dht.transmissionbt.com:6881",
	"router.utorrent.com:6881",
	"dht.libtorrent.org:25401",
	"router.bitcomet.com:6881",
}

type contact struct {
	id   [idLen]byte
	addr *net.UDPAddr
}

// DHT is a participant in the global Mainline DHT.
type DHT struct {
	conn *net.UDPConn
	id   [idLen]byte

	mu     sync.Mutex
	routes []contact // known reachable nodes (bounded, kept diverse-ish)

	txmu sync.Mutex
	txns map[string]chan map[string]interface{}

	closed chan struct{}
	once   sync.Once
}

// New binds a UDP socket and starts serving. listenAddr like "0.0.0.0:0".
func New(listenAddr string) (*DHT, error) {
	if listenAddr == "" {
		listenAddr = "0.0.0.0:0"
	}
	uaddr, err := net.ResolveUDPAddr("udp4", listenAddr)
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp4", uaddr)
	if err != nil {
		return nil, err
	}
	d := &DHT{
		conn:   conn,
		txns:   make(map[string]chan map[string]interface{}),
		closed: make(chan struct{}),
	}
	rand.Read(d.id[:])
	go d.readLoop()
	return d, nil
}

// ID returns this node's 160-bit DHT id (hex would be 40 chars).
func (d *DHT) ID() [idLen]byte { return d.id }

// Addr returns the local UDP address.
func (d *DHT) Addr() string { return d.conn.LocalAddr().String() }

// Close stops the DHT.
func (d *DHT) Close() error {
	d.once.Do(func() { close(d.closed) })
	return d.conn.Close()
}

// ---- wire I/O ----

func (d *DHT) readLoop() {
	buf := make([]byte, 64*1024)
	for {
		d.conn.SetReadDeadline(time.Now().Add(time.Second))
		n, from, err := d.conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-d.closed:
				return
			default:
				continue
			}
		}
		v, err := bdecode(buf[:n])
		if err != nil {
			continue
		}
		msg, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		d.handle(msg, from)
	}
}

func (d *DHT) handle(msg map[string]interface{}, from *net.UDPAddr) {
	y, _ := msg["y"].(string)
	switch y {
	case "r", "e":
		// Response to one of our queries — route it to the waiting txn.
		t, _ := msg["t"].(string)
		d.txmu.Lock()
		ch := d.txns[t]
		d.txmu.Unlock()
		if ch != nil {
			select {
			case ch <- msg:
			default:
			}
		}
		if r, ok := msg["r"].(map[string]interface{}); ok {
			if id, ok := r["id"].(string); ok && len(id) == idLen {
				d.remember(contact{id: toID(id), addr: from})
			}
		}
	case "q":
		d.answer(msg, from)
	}
}

// answer responds to inbound queries so we are a good DHT citizen (and stay in
// other nodes' routing tables, which keeps our PUTs reachable).
func (d *DHT) answer(msg map[string]interface{}, from *net.UDPAddr) {
	t, _ := msg["t"].(string)
	q, _ := msg["q"].(string)
	a, _ := msg["a"].(map[string]interface{})
	if a != nil {
		if id, ok := a["id"].(string); ok && len(id) == idLen {
			d.remember(contact{id: toID(id), addr: from})
		}
	}
	resp := map[string]interface{}{"id": string(d.id[:])}
	switch q {
	case "ping":
		// just id
	case "find_node", "get_peers", "get":
		var target [idLen]byte
		if a != nil {
			if tg, ok := a["target"].(string); ok && len(tg) == idLen {
				target = toID(tg)
			} else if ih, ok := a["info_hash"].(string); ok && len(ih) == idLen {
				target = toID(ih)
			}
		}
		resp["nodes"] = d.compactClosest(target)
		resp["token"] = "tract" // we don't store others' data; token is a formality
		if q == "get_peers" {
			resp["values"] = []interface{}{}
		}
	default:
		// Unknown query: reply ping-style rather than erroring.
	}
	d.send(map[string]interface{}{"t": t, "y": "r", "r": resp}, from)
}

func (d *DHT) send(msg map[string]interface{}, to *net.UDPAddr) {
	if b, err := bencode(msg); err == nil {
		d.conn.WriteToUDP(b, to)
	}
}

// query sends a KRPC query and waits for the matching response.
func (d *DHT) query(to *net.UDPAddr, method string, args map[string]interface{}) (map[string]interface{}, error) {
	args["id"] = string(d.id[:])
	tid := newTxID()
	ch := make(chan map[string]interface{}, 1)
	d.txmu.Lock()
	d.txns[tid] = ch
	d.txmu.Unlock()
	defer func() {
		d.txmu.Lock()
		delete(d.txns, tid)
		d.txmu.Unlock()
	}()

	msg := map[string]interface{}{"t": tid, "y": "q", "q": method, "a": args}
	b, err := bencode(msg)
	if err != nil {
		return nil, err
	}
	if _, err := d.conn.WriteToUDP(b, to); err != nil {
		return nil, err
	}
	select {
	case resp := <-ch:
		if y, _ := resp["y"].(string); y == "e" {
			return nil, fmt.Errorf("dht error reply")
		}
		r, _ := resp["r"].(map[string]interface{})
		if r == nil {
			return nil, fmt.Errorf("dht reply without r")
		}
		return r, nil
	case <-time.After(rpcTimeout):
		return nil, fmt.Errorf("dht rpc timeout")
	case <-d.closed:
		return nil, fmt.Errorf("dht closed")
	}
}

// ---- routing table (a simple bounded, distance-diverse set) ----

func (d *DHT) remember(c contact) {
	if c.addr == nil || c.id == d.id {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, e := range d.routes {
		if e.id == c.id {
			return
		}
	}
	d.routes = append(d.routes, c)
	// Bound the table; when full drop a random older entry to stay diverse.
	const cap = 512
	if len(d.routes) > cap {
		d.routes = d.routes[len(d.routes)-cap:]
	}
}

func (d *DHT) closest(target [idLen]byte, n int) []contact {
	d.mu.Lock()
	all := make([]contact, len(d.routes))
	copy(all, d.routes)
	d.mu.Unlock()
	sort.Slice(all, func(i, j int) bool {
		return bytes.Compare(xor(all[i].id, target), xor(all[j].id, target)) < 0
	})
	if len(all) > n {
		all = all[:n]
	}
	return all
}

func (d *DHT) compactClosest(target [idLen]byte) string {
	cs := d.closest(target, k)
	var b []byte
	for _, c := range cs {
		ip := c.addr.IP.To4()
		if ip == nil {
			continue
		}
		b = append(b, c.id[:]...)
		b = append(b, ip...)
		var p [2]byte
		binary.BigEndian.PutUint16(p[:], uint16(c.addr.Port))
		b = append(b, p[:]...)
	}
	return string(b)
}

// ---- bootstrap & lookup ----

// Bootstrap joins the global DHT via the public routers (plus any extra addrs),
// then warms the routing table by looking ourselves up. Returns the number of
// routers that answered.
func (d *DHT) Bootstrap(extra ...string) int {
	seeds := append([]string{}, PublicRouters...)
	seeds = append(seeds, extra...)
	answered := 0
	for _, s := range seeds {
		if s == "" {
			continue
		}
		ua, err := net.ResolveUDPAddr("udp4", s)
		if err != nil {
			continue
		}
		if r, err := d.query(ua, "find_node", map[string]interface{}{
			"target": string(d.id[:]),
		}); err == nil {
			answered++
			d.absorbNodes(r)
		}
	}
	if answered > 0 {
		d.iterativeFind(d.id) // populate the table around our own id
	}
	return answered
}

// absorbNodes adds the compact "nodes" from a reply to the routing table and
// returns them as contacts.
func (d *DHT) absorbNodes(r map[string]interface{}) []contact {
	nodesStr, _ := r["nodes"].(string)
	cs := parseCompactNodes(nodesStr)
	for _, c := range cs {
		d.remember(c)
	}
	return cs
}

// iterativeFind runs a Kademlia node lookup toward target and returns the k
// closest contacts discovered.
func (d *DHT) iterativeFind(target [idLen]byte) []contact {
	shortlist := d.closest(target, k)
	queried := map[[idLen]byte]bool{}
	for round := 0; round < 4; round++ {
		batch := pickUnqueried(shortlist, queried, alpha)
		if len(batch) == 0 {
			break
		}
		var (
			wg  sync.WaitGroup
			mu  sync.Mutex
			got []contact
		)
		for _, c := range batch {
			queried[c.id] = true
			wg.Add(1)
			go func(c contact) {
				defer wg.Done()
				r, err := d.query(c.addr, "find_node", map[string]interface{}{
					"target": string(target[:]),
				})
				if err != nil {
					return
				}
				cs := d.absorbNodes(r)
				mu.Lock()
				got = append(got, cs...)
				mu.Unlock()
			}(c)
		}
		wg.Wait()
		shortlist = mergeClosest(shortlist, got, target, k)
	}
	return shortlist
}

// ---- BEP-44 mutable items ----

// KeyPairFromSeed derives a deterministic ed25519 keypair from a 32-byte seed.
// Two peers that agree on the same secret derive the same keypair, hence the same
// DHT target, so they can read/refresh the same mutable item without coordination.
func KeyPairFromSeed(seed [32]byte) (ed25519.PublicKey, ed25519.PrivateKey) {
	priv := ed25519.NewKeyFromSeed(seed[:])
	return priv.Public().(ed25519.PublicKey), priv
}

// MutableTarget is the DHT key for a mutable item: SHA1(pubkey [++ salt]).
func MutableTarget(pub ed25519.PublicKey, salt []byte) [idLen]byte {
	h := sha1.New()
	h.Write(pub)
	h.Write(salt)
	var t [idLen]byte
	copy(t[:], h.Sum(nil))
	return t
}

// signBuffer is the exact byte string BEP-44 signs/verifies: the bencoded salt
// (if any), seq and v entries concatenated WITHOUT an enclosing dict.
func signBuffer(salt []byte, seq int64, v []byte) []byte {
	var b []byte
	if len(salt) > 0 {
		b = append(b, []byte("4:salt")...)
		b = strconv.AppendInt(b, int64(len(salt)), 10)
		b = append(b, ':')
		b = append(b, salt...)
	}
	b = append(b, []byte("3:seqi")...)
	b = strconv.AppendInt(b, seq, 10)
	b = append(b, 'e')
	b = append(b, []byte("1:v")...)
	b = strconv.AppendInt(b, int64(len(v)), 10)
	b = append(b, ':')
	b = append(b, v...)
	return b
}

// Put publishes a signed mutable value under the keypair (optionally salted). seq
// must strictly increase across updates (use a unix timestamp). Returns how many
// nodes accepted the store.
func (d *DHT) Put(pub ed25519.PublicKey, priv ed25519.PrivateKey, salt, value []byte, seq int64) (int, error) {
	if len(value) > maxValue {
		return 0, fmt.Errorf("mainline: value %d > %d byte BEP-44 cap", len(value), maxValue)
	}
	target := MutableTarget(pub, salt)
	sig := ed25519.Sign(priv, signBuffer(salt, seq, value))

	// Find nodes near the target and collect write tokens via "get".
	nodes := d.iterativeFind(target)
	type tok struct {
		c     contact
		token string
	}
	var toks []tok
	for _, c := range nodes {
		args := map[string]interface{}{"target": string(target[:])}
		r, err := d.query(c.addr, "get", args)
		if err != nil {
			continue
		}
		if t, ok := r["token"].(string); ok && t != "" {
			toks = append(toks, tok{c: c, token: t})
		}
		d.absorbNodes(r)
	}

	stored := 0
	for _, t := range toks {
		args := map[string]interface{}{
			"token": t.token,
			"k":     string(pub),
			"sig":   string(sig),
			"seq":   seq,
			"v":     string(value),
		}
		if len(salt) > 0 {
			args["salt"] = string(salt)
		}
		if _, err := d.query(t.c.addr, "put", args); err == nil {
			stored++
		}
	}
	return stored, nil
}

// Get fetches the highest-seq signed value stored under the keypair (and salt).
// Returns (value, seq, found). The signature is verified before returning.
func (d *DHT) Get(pub ed25519.PublicKey, salt []byte) ([]byte, int64, bool) {
	target := MutableTarget(pub, salt)
	shortlist := d.closest(target, k)
	if len(shortlist) == 0 {
		shortlist = d.iterativeFind(target)
	}
	queried := map[[idLen]byte]bool{}
	var (
		best    []byte
		bestSeq int64 = -1
		found   bool
	)
	for round := 0; round < 4; round++ {
		batch := pickUnqueried(shortlist, queried, alpha)
		if len(batch) == 0 {
			break
		}
		var (
			wg   sync.WaitGroup
			mu   sync.Mutex
			more []contact
		)
		for _, c := range batch {
			queried[c.id] = true
			wg.Add(1)
			go func(c contact) {
				defer wg.Done()
				r, err := d.query(c.addr, "get", map[string]interface{}{
					"target": string(target[:]),
				})
				if err != nil {
					return
				}
				cs := d.absorbNodes(r)
				mu.Lock()
				more = append(more, cs...)
				mu.Unlock()
				vRaw, hasV := r["v"].(string)
				seq, _ := r["seq"].(int64)
				if hasV && ed25519.Verify(pub, signBuffer(salt, seq, []byte(vRaw)), sigBytes(r)) {
					mu.Lock()
					if seq > bestSeq {
						bestSeq, best, found = seq, []byte(vRaw), true
					}
					mu.Unlock()
				}
			}(c)
		}
		wg.Wait()
		shortlist = mergeClosest(shortlist, more, target, k)
	}
	return best, bestSeq, found
}

func sigBytes(r map[string]interface{}) []byte {
	s, _ := r["sig"].(string)
	return []byte(s)
}

// ---- helpers ----

func newTxID() string {
	var b [2]byte
	rand.Read(b[:])
	return string(b[:])
}

func toID(s string) (id [idLen]byte) {
	copy(id[:], s)
	return
}

func xor(a, b [idLen]byte) []byte {
	out := make([]byte, idLen)
	for i := range a {
		out[i] = a[i] ^ b[i]
	}
	return out
}

func parseCompactNodes(s string) []contact {
	const recLen = idLen + 6 // 20 id + 4 ip + 2 port
	var out []contact
	b := []byte(s)
	for len(b) >= recLen {
		var c contact
		copy(c.id[:], b[:idLen])
		ip := net.IPv4(b[idLen], b[idLen+1], b[idLen+2], b[idLen+3])
		port := int(binary.BigEndian.Uint16(b[idLen+4 : idLen+6]))
		c.addr = &net.UDPAddr{IP: ip, Port: port}
		if port != 0 && !ip.IsUnspecified() {
			out = append(out, c)
		}
		b = b[recLen:]
	}
	return out
}

func pickUnqueried(cs []contact, queried map[[idLen]byte]bool, n int) []contact {
	var batch []contact
	for _, c := range cs {
		if !queried[c.id] && c.addr != nil {
			batch = append(batch, c)
			if len(batch) >= n {
				break
			}
		}
	}
	return batch
}

func mergeClosest(a, b []contact, target [idLen]byte, n int) []contact {
	seen := map[[idLen]byte]bool{}
	merged := make([]contact, 0, len(a)+len(b))
	for _, c := range append(a, b...) {
		if c.addr == nil || seen[c.id] {
			continue
		}
		seen[c.id] = true
		merged = append(merged, c)
	}
	sort.Slice(merged, func(i, j int) bool {
		return bytes.Compare(xor(merged[i].id, target), xor(merged[j].id, target)) < 0
	})
	if len(merged) > n {
		merged = merged[:n]
	}
	return merged
}
