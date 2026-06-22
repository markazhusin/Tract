package serverless

import (
    "encoding/json"
    "fmt"
    "net"
        "sync"
    "time"
)

// Client provides a lightweight, one‑shot interface for announcing and discovering
// signaling cards without becoming a full DHT node. It opens a temporary UDP socket,
// performs the necessary RPC calls, and then closes immediately.
//
// Typical usage:
//   n, err := serverless.AnnounceOneShot(key, payload, bootstrap)
//   vals, err := serverless.DiscoverOneShot(key, bootstrap)

type Client struct {
    conn *net.UDPConn
    id   NodeID
    // local store mirrors the in‑memory map used by Node for simplicity.
    store struct {
        sync.Mutex
        m map[NodeID]map[NodeID]valueRecord
    }
}

func newTempConn(listen string) (*net.UDPConn, error) {
    ua, err := net.ResolveUDPAddr("udp4", listen)
    if err != nil {
        return nil, err
    }
    return net.ListenUDP("udp4", ua)
}

func NewClient() (*Client, error) {
    c, err := newTempConn("127.0.0.1:0")
    if err != nil {
        return nil, err
    }
    return &Client{conn: c, id: GenerateNodeID()}, nil
}

func (c *Client) Close() error {
    if c.conn != nil {
        return c.conn.Close()
    }
    return nil
}

func (c *Client) doRPC(peer string, m message) (*message, error) {
    peerAddr, err := net.ResolveUDPAddr("udp4", peer)
    if err != nil {
        return nil, err
    }
    data, _ := json.Marshal(m)
    _, err = c.conn.WriteToUDP(data, peerAddr)
    if err != nil {
        return nil, err
    }
    c.conn.SetReadDeadline(time.Now().Add(rpcTimeout))
    buf := make([]byte, 65535)
    n, _, err := c.conn.ReadFromUDP(buf)
    if err != nil {
        return nil, err
    }
    var resp message
    if err := json.Unmarshal(buf[:n], &resp); err != nil {
        return nil, err
    }
    return &resp, nil
}

// putLocal mirrors Node.putLocal (stores data locally only).
func (c *Client) putLocal(key NodeID, publisher NodeID, data []byte) {
    c.store.Lock()
    defer c.store.Unlock()
    if c.store.m == nil {
        c.store.m = map[NodeID]map[NodeID]valueRecord{}
    }
    inner, ok := c.store.m[key]
    if !ok {
        inner = map[NodeID]valueRecord{}
        c.store.m[key] = inner
    }
    inner[publisher] = valueRecord{data: data, expires: time.Now().Add(valueTTL)}
}

// AnnounceOneShot publishes `payload` under `key` to a single bootstrap node (or only locally).
func AnnounceOneShot(key NodeID, payload []byte, bootstrap string) (int, error) {
    cli, err := NewClient()
    if err != nil {
        return 0, err
    }
    defer cli.Close()
    cli.putLocal(key, cli.id, payload)
    if bootstrap == "" {
        return 0, nil
    }
    // send STORE RPC to the bootstrap node
    msg := message{Type: "STORE", Sender: Contact{ID: cli.id, Addr: cli.conn.LocalAddr().String()}, Key: &key, Value: payload}
    _, err = cli.doRPC(bootstrap, msg)
    if err != nil {
        return 0, err
    }
    return 1, nil
}

// DiscoverOneShot contacts a bootstrap node and performs the iterative FIND_VALUE lookup.
func DiscoverOneShot(key NodeID, bootstrap string) ([][]byte, error) {
    if bootstrap == "" {
        return nil, fmt.Errorf("bootstrap address required for discover")
    }
    cli, err := NewClient()
    if err != nil {
        return nil, err
    }
    defer cli.Close()

    // initial FIND_VALUE request
    initMsg := message{Type: "FIND_VALUE", Sender: Contact{ID: cli.id, Addr: cli.conn.LocalAddr().String()}, Key: &key}
    resp, err := cli.doRPC(bootstrap, initMsg)
    if err != nil {
        return nil, err
    }
    seen := map[string][]byte{}
    for _, v := range resp.Values {
        seen[string(v)] = v
    }
    shortlist := resp.Nodes
    queried := map[NodeID]bool{resp.Sender.ID: true}
    for round := 0; round < 8 && len(shortlist) > 0; round++ {
        var next []Contact
        for _, c := range shortlist {
            if queried[c.ID] {
                continue
            }
            queried[c.ID] = true
            r, err := cli.doRPC(c.Addr, initMsg)
            if err != nil {
                continue
            }
            for _, v := range r.Values {
                seen[string(v)] = v
            }
            next = append(next, r.Nodes...)
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
    return out, nil
}
