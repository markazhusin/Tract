// Package serverless implements signaling WITHOUT a central server.
//
// Every device is itself a node in a Kademlia distributed hash table (DHT) over
// UDP. To "signal", a peer ANNOUNCES a small card (its reachability info / WebRTC
// offer / contact address) under a rendezvous key, and the other peer LOOKS UP
// that key and gets the set of announced cards back — exactly the mechanism
// BitTorrent's mainline DHT uses for get_peers/announce_peer. No node is special;
// remove any one and the rest keep working. This matches Tract's premise that
// "each device is a node of the network".
//
// Honesty notes:
//   - A DHT still needs at least one reachable peer to JOIN (bootstrap). After
//     that there is no central server; the bootstrap can be any live node.
//   - This implementation works on LAN, loopback, and between public IPs. Two
//     peers both behind NAT still need hole-punching to exchange media — that is
//     what the announced card + the existing WebRTC layer are for; the DHT removes
//     the central *signaling* server, not the laws of NAT.
//   - stdlib only, no external dependencies.
package serverless

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"sync"
	"time"
)

const (
	idBits     = 256
	idBytes    = idBits / 8
	bucketSize = 8 // k: contacts per k-bucket
	alpha      = 3 // lookup parallelism
	rpcTimeout = 2 * time.Second
	valueTTL   = 10 * time.Minute
)

// NodeID is a 256-bit identifier in the DHT keyspace.
type NodeID [idBytes]byte

// HashID derives a NodeID from arbitrary bytes (SHA-256).
func HashID(b []byte) NodeID { return NodeID(sha256.Sum256(b)) }

// RendezvousKey derives the DHT key two peers agree on out of band (a shared
// secret/passphrase). Both sides compute the same key without contacting anyone.
func RendezvousKey(secret string) NodeID {
	return HashID([]byte("tract-rendezvous:v1:" + secret))
}

func (id NodeID) String() string { return hex.EncodeToString(id[:]) }

func (id NodeID) xor(o NodeID) (d NodeID) {
	for i := range id {
		d[i] = id[i] ^ o[i]
	}
	return
}

// less reports whether id is closer to nothing in particular — used only to break
// ties; closeness is always measured relative to a target via xor.
func less(a, b NodeID) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// prefixLen returns the number of leading zero bits (common-prefix length).
func prefixLen(d NodeID) int {
	for i := 0; i < idBytes; i++ {
		if d[i] == 0 {
			continue
		}
		for bit := 0; bit < 8; bit++ {
			if d[i]&(1<<uint(7-bit)) != 0 {
				return i*8 + bit
			}
		}
	}
	return idBits
}

// Contact is a known peer: its ID and UDP address.
type Contact struct {
	ID   NodeID `json:"id"`
	Addr string `json:"addr"`
}

// ---- Routing table (256 k-buckets keyed by common-prefix length) ----

type routingTable struct {
	mu      sync.Mutex
	self    NodeID
	buckets [idBits][]Contact
}

func (rt *routingTable) add(c Contact) {
	if c.ID == rt.self || c.Addr == "" {
		return
	}
	b := prefixLen(rt.self.xor(c.ID))
	if b >= idBits {
		return
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	bucket := rt.buckets[b]
	for i, e := range bucket {
		if e.ID == c.ID {
			// Move to tail (most-recently-seen).
			bucket = append(bucket[:i], bucket[i+1:]...)
			rt.buckets[b] = append(bucket, c)
			return
		}
	}
	if len(bucket) < bucketSize {
		rt.buckets[b] = append(bucket, c)
	}
	// Bucket full: keep existing live nodes (Kademlia favours old contacts).
}

func (rt *routingTable) closest(target NodeID, n int) []Contact {
	rt.mu.Lock()
	all := make([]Contact, 0, 32)
	for i := range rt.buckets {
		all = append(all, rt.buckets[i]...)
	}
	rt.mu.Unlock()
	sortByDistance(all, target)
	if len(all) > n {
		all = all[:n]
	}
	return all
}

func sortByDistance(cs []Contact, target NodeID) {
	sort.Slice(cs, func(i, j int) bool {
		di, dj := cs[i].ID.xor(target), cs[j].ID.xor(target)
		if di == dj {
			return less(cs[i].ID, cs[j].ID)
		}
		// Compare XOR distances as big-endian numbers.
		for b := 0; b < idBytes; b++ {
			if di[b] != dj[b] {
				return di[b] < dj[b]
			}
		}
		return false
	})
}

// ---- Wire protocol ----

type message struct {
	Type   string    `json:"t"`
	RPCID  string    `json:"r"`
	Sender Contact   `json:"s"`
	Target *NodeID   `json:"target,omitempty"`
	Key    *NodeID   `json:"key,omitempty"`
	Value  []byte    `json:"v,omitempty"`
	Nodes  []Contact `json:"n,omitempty"`
	Values [][]byte  `json:"vals,omitempty"`
}

// ---- Stored values (a SET per key, like BitTorrent get_peers) ----

type valueRecord struct {
	data    []byte
	expires time.Time
}

// ---- Node ----

// Node is one participant in the serverless signaling DHT.
type Node struct {
	id    NodeID
	addr  string // advertised UDP address (host:port)
	conn  *net.UDPConn
	rt    *routingTable
	store struct {
		sync.Mutex
		m map[NodeID]map[NodeID]valueRecord // key -> publisher -> record
	}
	pending struct {
		sync.Mutex
		m map[string]chan message
	}
	closed chan struct{}
}

// NewNode binds a UDP socket and starts serving. id may be zero to auto-generate.
// listenAddr is what we bind ("127.0.0.1:0" for an ephemeral port); advertiseAddr,
// if empty, defaults to the resolved local address.
func NewNode(id NodeID, listenAddr, advertiseAddr string) (*Node, error) {
	uaddr, err := net.ResolveUDPAddr("udp4", listenAddr)
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp4", uaddr)
	if err != nil {
		return nil, err
	}
	if advertiseAddr == "" {
		advertiseAddr = conn.LocalAddr().String()
	}
	n := &Node{
		id:     id,
		addr:   advertiseAddr,
		conn:   conn,
		rt:     &routingTable{self: id},
		closed: make(chan struct{}),
	}
	n.store.m = make(map[NodeID]map[NodeID]valueRecord)
	n.pending.m = make(map[string]chan message)
	go n.readLoop()
	go n.expireLoop()
	return n, nil
}

// ID returns this node's DHT identifier.
func (n *Node) ID() NodeID { return n.id }

// Addr returns this node's advertised UDP address.
func (n *Node) Addr() string { return n.addr }

// Self returns this node as a Contact.
func (n *Node) Self() Contact { return Contact{ID: n.id, Addr: n.addr} }

// Close stops the node.
func (n *Node) Close() error {
	select {
	case <-n.closed:
	default:
		close(n.closed)
	}
	return n.conn.Close()
}

func (n *Node) readLoop() {
	buf := make([]byte, 64*1024)
	for {
		n.conn.SetReadDeadline(time.Now().Add(time.Second))
		nr, from, err := n.conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-n.closed:
				return
			default:
				continue
			}
		}
		var m message
		if json.Unmarshal(buf[:nr], &m) != nil {
			continue
		}
		// Learn the sender (prefer the socket's real source addr).
		if m.Sender.Addr == "" {
			m.Sender.Addr = from.String()
		}
		n.rt.add(m.Sender)
		n.handle(m, from)
	}
}

func (n *Node) handle(m message, from *net.UDPAddr) {
	switch m.Type {
	case "PING":
		n.reply(from, message{Type: "PONG", RPCID: m.RPCID, Sender: n.Self()})
	case "FIND_NODE":
		var t NodeID
		if m.Target != nil {
			t = *m.Target
		}
		n.reply(from, message{Type: "NODES", RPCID: m.RPCID, Sender: n.Self(),
			Nodes: n.rt.closest(t, bucketSize)})
	case "FIND_VALUE":
		var key NodeID
		if m.Key != nil {
			key = *m.Key
		}
		if vals := n.getLocal(key); len(vals) > 0 {
			n.reply(from, message{Type: "VALUE", RPCID: m.RPCID, Sender: n.Self(), Values: vals})
		} else {
			n.reply(from, message{Type: "NODES", RPCID: m.RPCID, Sender: n.Self(),
				Nodes: n.rt.closest(key, bucketSize)})
		}
	case "STORE":
		if m.Key != nil {
			n.putLocal(*m.Key, m.Sender.ID, m.Value)
		}
		n.reply(from, message{Type: "STORED", RPCID: m.RPCID, Sender: n.Self()})
	case "PONG", "NODES", "VALUE", "STORED":
		n.pending.Lock()
		ch := n.pending.m[m.RPCID]
		n.pending.Unlock()
		if ch != nil {
			select {
			case ch <- m:
			default:
			}
		}
	}
}

func (n *Node) reply(to *net.UDPAddr, m message) {
	if b, err := json.Marshal(m); err == nil {
		n.conn.WriteToUDP(b, to)
	}
}

// rpc sends a request to addr and waits for the matching response.
func (n *Node) rpc(addr string, m message) (message, error) {
	uaddr, err := net.ResolveUDPAddr("udp4", addr)
	if err != nil {
		return message{}, err
	}
	rid := newRPCID()
	m.RPCID = rid
	m.Sender = n.Self()
	ch := make(chan message, 1)
	n.pending.Lock()
	n.pending.m[rid] = ch
	n.pending.Unlock()
	defer func() {
		n.pending.Lock()
		delete(n.pending.m, rid)
		n.pending.Unlock()
	}()

	b, err := json.Marshal(m)
	if err != nil {
		return message{}, err
	}
	if _, err := n.conn.WriteToUDP(b, uaddr); err != nil {
		return message{}, err
	}
	select {
	case resp := <-ch:
		return resp, nil
	case <-time.After(rpcTimeout):
		return message{}, fmt.Errorf("rpc timeout to %s", addr)
	case <-n.closed:
		return message{}, fmt.Errorf("node closed")
	}
}

// ---- Local store ----

func (n *Node) putLocal(key, publisher NodeID, data []byte) {
	n.store.Lock()
	defer n.store.Unlock()
	if n.store.m[key] == nil {
		n.store.m[key] = make(map[NodeID]valueRecord)
	}
	n.store.m[key][publisher] = valueRecord{data: data, expires: time.Now().Add(valueTTL)}
}

func (n *Node) getLocal(key NodeID) [][]byte {
	n.store.Lock()
	defer n.store.Unlock()
	set := n.store.m[key]
	out := make([][]byte, 0, len(set))
	for _, rec := range set {
		if time.Now().Before(rec.expires) {
			out = append(out, rec.data)
		}
	}
	return out
}

func (n *Node) expireLoop() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			now := time.Now()
			n.store.Lock()
			for key, set := range n.store.m {
				for pub, rec := range set {
					if now.After(rec.expires) {
						delete(set, pub)
					}
				}
				if len(set) == 0 {
					delete(n.store.m, key)
				}
			}
			n.store.Unlock()
		case <-n.closed:
			return
		}
	}
}

// ---- Public API ----

// Bootstrap joins the DHT through an existing peer's address. After this the node
// is part of the mesh; the bootstrap peer can then go away.
func (n *Node) Bootstrap(peerAddr string) error {
	resp, err := n.rpc(peerAddr, message{Type: "PING"})
	if err != nil {
		return err
	}
	n.rt.add(resp.Sender)
	// Populate routing table by looking ourselves up.
	n.lookup(n.id, false)
	return nil
}

// Announce publishes data under key so peers looking up key will find it. It is
// stored on the k closest nodes (and locally). This is the "send signaling" half.
func (n *Node) Announce(key NodeID, data []byte) int {
	n.putLocal(key, n.id, data)
	contacts := n.lookup(key, false)
	stored := 0
	for _, c := range contacts {
		_, err := n.rpc(c.Addr, message{Type: "STORE", Key: &key, Value: data})
		if err == nil {
			stored++
		}
	}
	return stored
}

// Discover returns the set of cards announced under key (deduplicated). This is
// the "receive signaling" half — no central server is consulted.
func (n *Node) Discover(key NodeID) [][]byte {
	seen := map[string][]byte{}
	for _, v := range n.getLocal(key) {
		seen[string(v)] = v
	}
	shortlist := n.rt.closest(key, bucketSize)
	queried := map[NodeID]bool{}
	for round := 0; round < 8 && len(shortlist) > 0; round++ {
		var next []Contact
		for _, c := range shortlist {
			if queried[c.ID] {
				continue
			}
			queried[c.ID] = true
			resp, err := n.rpc(c.Addr, message{Type: "FIND_VALUE", Key: &key})
			if err != nil {
				continue
			}
			for _, v := range resp.Values {
				seen[string(v)] = v
			}
			next = append(next, resp.Nodes...)
		}
		if len(next) == 0 {
			break
		}
		sortByDistance(next, key)
		if len(next) > bucketSize {
			next = next[:bucketSize]
		}
		shortlist = next
	}
	out := make([][]byte, 0, len(seen))
	for _, v := range seen {
		out = append(out, v)
	}
	return out
}

// lookup runs the iterative Kademlia node lookup for target and returns the
// k closest contacts it found. If valueMode it stops early on a VALUE (unused
// here; Discover collects all values).
func (n *Node) lookup(target NodeID, valueMode bool) []Contact {
	shortlist := n.rt.closest(target, bucketSize)
	queried := map[NodeID]bool{}
	best := append([]Contact(nil), shortlist...)
	for round := 0; round < 8; round++ {
		var batch []Contact
		for _, c := range shortlist {
			if !queried[c.ID] {
				batch = append(batch, c)
			}
			if len(batch) >= alpha {
				break
			}
		}
		if len(batch) == 0 {
			break
		}
		var (
			wg  sync.WaitGroup
			mu  sync.Mutex
			got []Contact
		)
		for _, c := range batch {
			queried[c.ID] = true
			wg.Add(1)
			go func(c Contact) {
				defer wg.Done()
				resp, err := n.rpc(c.Addr, message{Type: "FIND_NODE", Target: &target})
				if err != nil {
					return
				}
				mu.Lock()
				got = append(got, resp.Nodes...)
				mu.Unlock()
			}(c)
		}
		wg.Wait()
		for _, c := range got {
			n.rt.add(c)
		}
		merged := append(best, got...)
		sortByDistance(merged, target)
		dedup := merged[:0]
		seen := map[NodeID]bool{}
		for _, c := range merged {
			if !seen[c.ID] {
				seen[c.ID] = true
				dedup = append(dedup, c)
			}
		}
		if len(dedup) > bucketSize {
			dedup = dedup[:bucketSize]
		}
		best = dedup
		shortlist = best
	}
	return best
}
