# Quantum emulation + serverless signaling (experimental)

Two self-contained, stdlib-only Go modules added as an experiment. Both are real
and tested; neither relies on magic.

## Honest framing first

Quantum entanglement **cannot transmit information** — this is the
*no-communication theorem*, a proven result. So "use quantum to replace the
signaling server" is physically impossible; anyone claiming it is selling magic.
What is real and useful here:

1. **Quantum emulation** — classically simulating a quantum circuit. Real, and a
   correct source of sampled randomness.
2. **Serverless signaling** — peer discovery + offer/ICE exchange with no central
   server, via a DHT. Real, this is how libp2p / BitTorrent do it.
3. The genuine "quantum" security upgrade for a messenger is **post-quantum
   crypto** (e.g. ML-KEM/Kyber over the current X25519), not a magic channel.

## 1. `internal/quantum` — state-vector emulator

An n-qubit register as a `2^n` complex amplitude vector with gates applied as
linear operators (the same approach as Qiskit Aer / cirq simulators).

- Gates: `H X Y Z S T Phase`, `CNOT CZ CPhase`, `QFT`, measurement with collapse.
- `quantum.Bits(n)` / `quantum.Bytes(n)` — QRNG via measured superposition
  (entropy sourced from `crypto/rand`; honest emulation, not hardware).
- Tests: Bell-state entanglement correlation, superposition probabilities,
  norm preservation across a random circuit, QRNG balance.

```go
r := quantum.New(2); r.H(0); r.CNOT(0, 1) // (|00>+|11>)/√2
a, b := r.Measure(0), r.Measure(1)        // a == b, always
key := quantum.Bytes(32)                   // 32 random bytes
```

## 2. `internal/serverless` — Kademlia DHT signaling

Every device is a DHT node. To signal, a peer **announces** a card (its WebRTC
offer / reachability info) under a rendezvous key derived from a shared secret;
the other peer **discovers** that key and gets the set of cards back — the
BitTorrent `announce_peer`/`get_peers` model. No node is special.

- 256-bit IDs (seeded by the QRNG above), XOR metric, k-buckets, iterative
  lookup, UDP JSON RPC (`PING/FIND_NODE/FIND_VALUE/STORE`).
- `RendezvousKey(secret)` — both peers derive the same key offline.
- `Announce(key, card)` / `Discover(key)` — the two halves of signaling.
- Test spins up 7 nodes, announces, **kills the bootstrap node**, and another
  peer still discovers the card → proves there is no central dependency.

```go
n, _ := serverless.NewNode(serverless.GenerateNodeID(), "127.0.0.1:0", "")
n.Bootstrap("peer:port")
key := serverless.RendezvousKey("dinner-7421")
n.Announce(key, []byte(`{"offer":"<sdp>"}`))
cards := n.Discover(key)
```

### Limits (stated plainly)

- A DHT still needs **one reachable peer to join** (bootstrap). After joining
  there is no server; the bootstrap can be any live node and can then leave.
- Works on LAN, loopback, and between public IPs. Two peers both behind NAT
  still need hole-punching to exchange media — that is what the announced card +
  the existing WebRTC layer handle. The DHT removes the central *signaling*
  server, not NAT.

## Demo

```bash
go run ./cmd/tract-p2p quantum                 # emulator + QRNG + node id

# serverless signaling, two terminals:
go run ./cmd/tract-p2p signal -listen 127.0.0.1:7000 \
    -rendezvous dinner-7421 -card '{"peer":"alice","offer":"<sdp>"}' -wait 5m
go run ./cmd/tract-p2p signal -listen 127.0.0.1:7001 -bootstrap 127.0.0.1:7000 \
    -rendezvous dinner-7421 -discover
```
