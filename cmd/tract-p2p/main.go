// tract-p2p demonstrates the two experimental modules:
//
//	tract-p2p quantum                 # run a quantum-emulator demo + QRNG sample
//	tract-p2p signal -listen :7000    # start a serverless signaling DHT node
//
// Serverless signaling example (no central server — each process is a node):
//
//	# terminal 1 (bootstrap + Alice announces her card)
//	tract-p2p signal -listen 127.0.0.1:7000 \
//	    -rendezvous "dinner-7421" -card '{"peer":"alice","offer":"<sdp>"}'
//
//	# terminal 2 (Bob joins via Alice's node, then discovers the rendezvous)
//	tract-p2p signal -listen 127.0.0.1:7001 -bootstrap 127.0.0.1:7000 \
//	    -rendezvous "dinner-7421" -discover
package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"time"

	"tract-signaling/internal/quantum"
	"tract-signaling/internal/serverless"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "quantum":
		runQuantum()
	case "signal":
		runSignal(os.Args[2:])
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: tract-p2p <quantum|signal> [flags]")
	os.Exit(2)
}

func runQuantum() {
	fmt.Println("== Quantum emulator (state-vector, pure Go) ==")

	// Bell state: (|00> + |11>)/sqrt(2) — entanglement demo.
	r := quantum.New(2)
	r.H(0)
	r.CNOT(0, 1)
	fmt.Println("Bell state:", r)
	a, b := r.Measure(0), r.Measure(1)
	fmt.Printf("measured q0=%d q1=%d  (always equal — entangled)\n\n", a, b)

	// QRNG sample seeded by measured superposition.
	fmt.Printf("QRNG 32 bytes: %s\n", hex.EncodeToString(quantum.Bytes(32)))

	// Tie-in: this is how a serverless node ID is born.
	id := serverless.GenerateNodeID()
	fmt.Printf("DHT node id from QRNG: %s\n", id)
}

func runSignal(args []string) {
	// NOTE: this function now supports a "client" (node‑less) mode.
	// In client mode we perform a one‑shot announce/discover using the
	// serverless client helpers and then exit immediately. This is useful
	// for scripts or when the device has only LTE and we want to avoid
	// staying online as a full DHT node.

	fs := flag.NewFlagSet("signal", flag.ExitOnError)
	listen := fs.String("listen", "127.0.0.1:0", "UDP listen address")
	clientMode := fs.Bool("client", false, "perform one‑shot announce/discover without staying a DHT node")
	bootstrap := fs.String("bootstrap", "", "address of an existing node to join")
	rendezvous := fs.String("rendezvous", "", "shared secret both peers agree on out of band")
	card := fs.String("card", "", "signaling card to announce under the rendezvous key")
	discover := fs.Bool("discover", false, "look up and print cards at the rendezvous")
	wait := fs.Duration("wait", 0, "stay online this long (e.g. 5m); 0 = forever when announcing")
	fs.Parse(args)

	node, err := serverless.NewNode(serverless.GenerateNodeID(), *listen, "")
	if err != nil {
		fmt.Fprintln(os.Stderr, "start:", err)
		os.Exit(1)
	}
	defer node.Close()
	fmt.Printf("node %s listening on %s\n", node.ID().String()[:16], node.Addr())

	if *bootstrap != "" {
		if err := node.Bootstrap(*bootstrap); err != nil {
			fmt.Fprintln(os.Stderr, "bootstrap:", err)
		} else {
			fmt.Println("joined DHT via", *bootstrap)
		}
	}

	if *rendezvous == "" {
		fmt.Println("(no -rendezvous given; idling as a relay node)")
		select {}
	}
	key := serverless.RendezvousKey(*rendezvous)

	// ---------------------------------------------------------------------
	// Client‑less (one‑shot) mode
	// ---------------------------------------------------------------------
	if *clientMode {
		if *bootstrap == "" && (*card != "" || *discover) {
			fmt.Fprintln(os.Stderr, "client‑mode: -bootstrap required for announce/discover; proceeding with local only")
		}
		if *card != "" {
			stored, err := serverless.AnnounceOneShot(key, []byte(*card), *bootstrap)
			if err != nil {
				fmt.Fprintln(os.Stderr, "announce error:", err)
				os.Exit(1)
			}
			fmt.Printf("client‑announce stored on %d remote node(s) (bootstrap %s)\n", stored, *bootstrap)
		}
		if *discover {
			vals, err := serverless.DiscoverOneShot(key, *bootstrap)
			if err != nil {
				fmt.Fprintln(os.Stderr, "discover error:", err)
				os.Exit(1)
			}
			fmt.Printf("client‑discover found %d card(s) at rendezvous %q:\n", len(vals), *rendezvous)
			for _, v := range vals {
				fmt.Printf("  - %s\n", string(v))
			}
		}
		// Nothing to keep online – exit.
		return
	}


	if *card != "" {
		n := node.Announce(key, []byte(*card))
		fmt.Printf("announced card to %d node(s) under rendezvous %q\n", n, *rendezvous)
	}

	if *discover {
		time.Sleep(300 * time.Millisecond)
		cards := node.Discover(key)
		fmt.Printf("discovered %d card(s) at rendezvous %q:\n", len(cards), *rendezvous)
		for _, c := range cards {
			fmt.Printf("  - %s\n", string(c))
		}
		if *wait == 0 {
			return
		}
	}

	// Stay online so others can keep discovering us.
	if *wait > 0 {
		time.Sleep(*wait)
	} else {
		fmt.Println("staying online (Ctrl-C to stop)…")
		select {}
	}
}
