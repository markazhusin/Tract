# Tract

A local-first P2P messenger. **Open entry, no admins.** Your identity is a
cryptographic key: the ID is derived from the public key automatically — it can't
be claimed, faked, or taken away. The display name is arbitrary — it's just a
label, not an address.

Message and call contents are **end-to-end encrypted on the device**. A server (a
node) is only ever a "switchboard" for the internet (introduce two participants,
hold an offline message) — it never sees the content. By design there can be many
nodes, and anyone can run their own: **every device is a node of the network.**

---

## What it's made of

| Component | What it is | Where |
|---|---|---|
| **iOS app** | Native SwiftUI app (Telegram-style, Liquid Glass) | `ios/` |
| **`tract-cli`** | Universal desktop client (Go, single binary, every OS) | `cmd/tract-cli/` |
| **`tract-node`** | Signaling node (Go, self-hostable, zero-config) | `main.go`, `internal/` |

The iOS app and `tract-cli` speak the **same native protocol**
(Curve25519 → HKDF-SHA256 → AES-GCM, `app_packet` via a node), so
**iOS ↔ desktop are directly compatible**.

> ⚠️ The old web client (`index.html` / `main.js`, **secp256k1** crypto) is
> **legacy** and **not compatible** with the native clients' encryption. It's kept
> for history; for the new network use the native app and `tract-cli`.

---

## Transports (chosen automatically, as a cascade)

The route is picked automatically and **never gives up while any path exists** —
that's what makes calls/messages reliable regardless of whether the parties are
nearby:

| Tier | Transport | When |
|---|---|---|
| 1 | **Local mesh** (Wi-Fi P2P + Bluetooth, MultipeerConnectivity) | devices nearby — no internet, no server, lowest latency |
| 2 | **P2P via a node** (HTTP/SSE signaling) | a reachable `tract-node` with the peer registered on it — ~1–2 s |
| 3 | **DHT rendezvous** (BitTorrent Mainline / private Kademlia) | no node, or the peer isn't on it — serverless, ~15–30 s |
| 4 | **GetStream reserve** *(optional, can be turned off)* | neither a node nor the DHT (e.g. a VPN filtering UDP) — last resort over HTTPS |

- **Messages** now go out **over every live channel at once** (mesh *and*
  internet); the recipient dedups on `pid` and shows it exactly once. That's why a
  message gets through even when Bluetooth is flaky or a peer's mesh session
  dropped. If the recipient is offline, a node holds the message in its inbox; with
  no node it lands in the recipient's **DHT inbox** (E2E, store-and-forward) and is
  delivered "when they come online".
- **Calls** — nearby over the mesh; over the internet via **WebRTC** (Opus, P2P;
  signaling cascades node → DHT inbox → GetStream, audio goes directly or via a TURN
  relay under symmetric NAT). A call walks the transports in order, while incoming
  calls are watched on **all** channels simultaneously (node poll + DHT inbox +
  every contact's GetStream channel) — so a call lands no matter which path it was
  placed on.

The node address is not baked into the client and doesn't point at anyone's
hosting: locally (same machine) a node is picked up automatically; for the internet
add a live node's address — anyone can run one anonymously, including you. One live
node is enough.

### Presence (online status) — by real reachability

The "online" status reflects the reachability of the **contact themselves**, not
whether *you* have internet. It is polled separately (every ~12 s) via two
independent signals: the node's peer registry (`/peers/by-user`, honoring "stealth")
and the DHT presence beacon. The status is unified across the chats list and
contacts: **nearby** (mesh with a live session) → **online** (fresh presence
signal) → **last seen …** (from the most recent observation).

---

## Rendezvous without a signaling server (DHT)

So calls and chats over the internet work **even when no "own" node is around**,
peers find each other through a distributed hash table — two layers, primary +
fallback:

- **Global BitTorrent Mainline DHT** (`internal/mainline`, primary) — the real
  public network of millions of nodes. Implements BEP-5 (KRPC over UDP with
  bencode: `ping`/`find_node`/`get_peers`/`get`/`put`) and **BEP-44 mutable items**
  (the record is ed25519-signed, the key derived from the userId, so a contact is
  found by their ID with no server at all). Bootstrap is the public routers
  (`router.bittorrent.com:6881` and others); the node also answers incoming
  requests, i.e. becomes a participant of the network itself.
- **Private Kademlia (Tract)** (`internal/serverless`, fallback) — a closed overlay
  for when the public DHT is unavailable (e.g. UDP filtering).

A node publishes its address in both DHTs (`announceUser`) and looks up the peer in
the union of both (`locateUser`). Disable with `TRACT_MAINLINE=off`; set your own
bootstrap nodes via `TRACT_MAINLINE_BOOTSTRAP=host:port,host:port`.

## Relays and reserves (optional, swappable)

The serverless paths are primary: **mesh → nodes (self-host) → DHT inbox.** But
there are two things P2P can't physically escape: symmetric NAT/CGNAT sometimes
needs a **relay** for media, and blocked UDP (e.g. under a VPN) can kill the DHT.
For those cases there are reserves — deliberately **swappable and disableable**, so
the network depends on no single provider:

- **TURN relay** (media). A public **ExpressTURN** is baked in by default, plus a
  node serves its own relays via `/ice` (embedded coturn and/or `TURN_URLS`). A TURN
  login is client-visible by nature (a shared account, not a secret). For your own
  network, hand out **your** relays; ExpressTURN is dropped via `EXPRESSTURN_URL=off`
  (or `EXPRESSTURN_URL/USER/CRED`). A relay through symmetric NAT is mandatory — the
  decentralized answer is *many of your own* relays, not the absence of one.
- **GetStream reserve** (signaling, **not** media) — the last step of the cascade:
  the same offer/answer/ICE travel over Stream Chat when there's neither a node nor
  the DHT. It's the only path that survives VPN UDP filtering **without** a node, so
  it's kept — but it's **turned off** in the app (Settings → "Reserve signaling") for
  fully serverless operation, and on the server by an empty `STREAM_API_SECRET`. **The
  Stream secret never reaches the client**: the node mints a short per-user JWT at
  `GET /getstream/token`, and the client only ever sees that token and the public
  API key. Configure with `STREAM_API_KEY`/`STREAM_API_SECRET`/`STREAM_APP_ID`.

> **Honest about decentralization.** A truly "serverless" messenger doesn't exist:
> rendezvous, NAT traversal, and offline delivery must be done by *someone*. Tract
> spreads those roles across the DHT, **self-hostable nodes**, and the mesh — while
> ExpressTURN/GetStream are merely a pragmatic bootstrap crutch, replaceable by your
> own relays/nodes and disableable entirely. For your own network: run a node (it
> hands out its own TURN and tokens), add it to the seeds — and no third parties are
> needed.

## 611protocol — the encryption stack (quantum tamper-evidence over classical E2E)

Tract's encryption is a layered stack we call **611protocol**: a quantum
key-distribution *tamper-evidence ceremony* placed **on top of** a conventional
end-to-end pipeline, so a live call has two independent guarantees instead of one.

```
611protocol  =  [ classical E2E ]  +  [ quantum tamper-evidence on top ]

  classical E2E:  Curve25519 (X25519)  →  HKDF-SHA256  →  AES-256-GCM
                  (sealed on the device before anything leaves it)
  quantum layer:  BB84 QKD ceremony per call  →  QBER check  →  collapse on tampering
```

The classical layer keeps content confidential end-to-end (the node/DHT only ever
see ciphertext). The quantum layer adds something a normal messenger doesn't: a live
call actively *detects interception* and tears itself down if the channel is being
tampered with.

> **Is there anything like this elsewhere?** To our knowledge, **no shipping
> messenger combines a BB84 quantum-key-distribution ceremony with a fully
> serverless (mesh + DHT) end-to-end P2P transport.** Pieces exist separately —
> mesh messengers (Briar, Meshtastic), E2E messengers (Signal), QKD in telecom lab
> hardware — but the *combination*, as a tamper-evidence ceremony on a consumer
> serverless app, we have not found in the wild. (If you know of one, tell us — this
> is an honest "to our knowledge", not a marketing absolute.)

### How the quantum layer works

Before talking, the two sides run a **BB84 quantum key-distribution ceremony** on
top of the already-encrypted signaling channel (`internal/quantum/bb84.go`, ports in
`ios/Tract/QuantumBB84.swift` and `app/core/bb84.js`, the protocol bit-for-bit
identical). The call initiator is Alice (prepares qubits), the callee is Bob
(measures). The sides publicly compare a sample: measuring an unknown qubit in the
wrong basis inevitably disturbs it (the no-cloning theorem), so active interception
(intercept-resend) pushes the **QBER** toward ~25%. If the QBER exceeds the **15%**
threshold, the key is discarded and **the call collapses on both ends** — better to
drop the link than continue a compromised one.

> Honest about the limits: the software does not transmit a real photon over the
> wire, so this is not the information-theoretic security of physical QKD but a
> **credible tamper-evidence ceremony**: an active MITM that distorts the exchange is
> caught by the QBER check, and the session is torn down. The qubit emulator is real
> (collapse on measurement), while the *choice* of bit/basis is a classical coin from
> a CSPRNG, just as on a real device.

---

## Planned transports

The protocol is one; the physical channel is an implementation detail. The app
shouldn't know or care which radio carries a packet. Today it runs on the local mesh
(Wi-Fi/Bluetooth) and the internet (node/DHT/WebRTC); the planned transport substrate
underneath is broader — each new channel physically extends reach:

| Transport | Role | Status |
|---|---|---|
| **Wi-Fi mesh 802.11s** | primary urban channel (150–300 Mbit/s, 100–300 m/node) — video, sync | planned (today: MultipeerConnectivity mesh) |
| **Bluetooth LE 5.0** | last mile / offline, up to 7 hops | partial (mesh today) |
| **LoRa 430/868 MHz** | long-range fallback (~50 kbit/s, **5–50 km**) — messages cross a whole city with no towers, works when everything else is down | **needs hardware: rooftop antennas + LoRa gateways (ESP32 + LoRa module, ~$15–30, Meshtastic-style) — requires funding** |
| **Ethernet / fiber (Yggdrasil)** | backbone; a home router becomes a gigabit node | planned |
| **Laser FSO** | rooftop-to-rooftop up to 5 km, up to 1 Gbit/s; legally not radio, no spectrum licence | planned |
| **Satellite (Starlink / OneWeb)** | gateway beyond ground jurisdiction — **one terminal per district** | planned |
| **Tor / I2P** | onion routing used as *a* channel, not a dependency — hides source and destination | partial (planned for node reachability) |
| **Store-and-forward** | people as protocol: when there's no channel at all, a phone physically carries packets between towns and syncs on contact with any node | partial (mesh courier today) |

The channel is auto-selected per task: video over Wi-Fi, a message over LoRa, a
payload that "arrives physically" when there is no link at all. Works offline,
supports the internet, doesn't depend on it.

> **This needs funding.** LoRa antennas/gateways and always-on relay hardware (OpenWrt
> routers, Raspberry Pi nodes) are physical things that cost money. See
> [Support development](#support-development).

## Quick start

### 1. Node (`tract-node`)

Run it on any computer — it becomes a node of the network (port `8877`, data in
`./data`, zero config):

```bash
go build -o tract-node . && ./tract-node
# or prebuilt binaries for every OS:
./scripts/build-node.sh           # → dist-node/tract-node-<os>-<arch>
```

The node isn't "registered" with any hosting — run it yourself anywhere, even on
this computer, and make it reachable anonymously (see "A node anywhere — no
hosting").

### 2. Desktop client (`tract-cli`)

```bash
go build -o tract-cli ./cmd/tract-cli       # or dist-node/tract-cli-<os>-<arch>
./tract-cli -name Mark
```

Shows your `@id`. Commands:

| Command | Action |
|---|---|
| `/id` | show your ID |
| `/add @xxxx` | add a contact by ID (key fetched from the node) |
| `/to @xxxx` | select the current recipient |
| `/who` | list contacts |
| `<text>` | send a message to the current recipient |

Flags: `-name` (name), `-server <url>` or env `TRACT_NODE` (your node),
`-home <dir>` (profile directory, default `~/.tract-cli`).

### 3. iOS app

Requires macOS + **Xcode**, **XcodeGen** (`brew install xcodegen`); a free Apple ID
is enough. The **WebRTC** dependency is pulled in via Swift Package Manager
automatically. Sources are in `ios/Tract/` (SwiftUI), the project config is
`ios/project.yml`.

**Via Xcode:**

```bash
cd ios && xcodegen generate && open Tract.xcodeproj
```

In Xcode: target **Tract** → **Signing & Capabilities** → pick your Team, change the
**Bundle Identifier** to something unique if needed → pick a device → **▶**.

**Or from the command line** (substitute the device UDID and Team ID):

```bash
cd ios && xcodegen generate
xcodebuild -project Tract.xcodeproj -scheme Tract -configuration Debug \
  -destination 'id=<UDID>' -derivedDataPath build \
  -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<TEAM_ID> build
xcrun devicectl device install app --device <UDID> \
  build/Build/Products/Debug-iphoneos/Tract.app
```

Device UDID: `xcrun xctrace list devices`. The Team ID appears after signing in with
your Apple ID in Xcode (Settings → Accounts).

Once per device:

- **Developer Mode**: Settings → Privacy & Security → Developer Mode → on → reboot.
- **Trust the profile**: Settings → General → VPN & Device Management → your Apple ID
  → Trust.

> A free signing profile lasts **7 days** — then reinstall the same way.

---

## How to use

1. Create an account (name + password) — the key is generated on the device, the ID
   appears in your profile.
2. Show the other person your `@id` (on iOS — the "New contact" screen, with a QR
   there too).
3. Add them by `@id` — on iOS with the ✎ button, in `tract-cli` with `/add`.
4. Chat and call. Nearby — it goes over the mesh with no internet; otherwise — via a
   node (or node-lessly over the DHT).

A contact must have **logged in at least once** (then their public key is published
and they can be found by ID).

---

## Building all binaries

```bash
./scripts/build-node.sh
# → dist-node/tract-node-<os>-<arch>  and  dist-node/tract-cli-<os>-<arch>
#   (darwin/linux/windows, amd64/arm64; static, no dependencies)
```

Binaries aren't kept in git — distribute via GitHub Releases.

---

## A node anywhere — no hosting

A node is just `tract-node`. No provider, account, or domain required: run it on any
computer (even this one) and make it reachable one of these ways, in increasing
anonymity:

- **Local network** — a node on your computer, nearby clients hit its LAN address.
  Zero infrastructure.
- **Anonymous tunnel** — `npm run share` brings up a node and a public
  `*.trycloudflare.com` URL **with no account and no domain of your own**. Hand that
  address to the other person (paste/QR) — it lives as long as the terminal is open.
- **Tor hidden service** — a `.onion` address: no IP, no jurisdiction, no hosting.
- **Your own public IP / VPS** — if you need a permanent node.

The node listens on `PORT` (default `8877`) and writes to `./data` (identity blobs
and the offline inbox). It stores no passwords and can't recover a key.

**Why this beats hosting:** there's no single point that can be seized or blocked;
anyone can bring up a "switchboard" in a minute and tear it down just as fast. There
can be any number of nodes — the network lives as long as a single one does.

Your own TURN for reliable calls behind NAT:

```bash
TURN_URLS="turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp"
TURN_USERNAME=...   TURN_CREDENTIAL=...
```

The node hands these to clients via `GET /ice`.

### What a node stores (`data/`)

| File | Contents |
|---|---|
| `identity-store.json` | Public data + (for the legacy web) the encrypted key |
| `message-inbox.json` | Offline messages (delivered when the user comes online) |
| `groups.json`, `avatars/` | Groups, avatars (legacy web) |

---

## Roadmap

Honest about "everyone at once": that's not how this rolls out, and the whole
strategy depends on admitting it. A mesh has a physical limit — it only works where
there are enough nodes within radio range. So the only path that works is **local
density first, then expansion**: not the whole world at once, but islands that grow
into an archipelago, then a continent.

- **Phase 0 — Seed (now).** Device-to-device over BT / Wi-Fi with no infrastructure
  (two phones nearby are already a network); internet via a node or node-lessly over
  the DHT. Calls and chat work today. *This is the current MVP.*
- **Phase 1 — Local density.** Beachheads where motivation meets a tolerant
  environment: weak-connectivity areas, privacy-minded communities, campuses,
  festivals, makers, disaster zones. Goal: critical mass on a small footprint so the
  mesh sustains itself. Distribute via App Store / Play for reach, plus an Android
  APK and F-Droid for a block-resistant branch.
- **Phase 2 — Hardware backbone.** Phones give intermittent coverage; always-on
  relays give permanent coverage: **OpenWrt routers** (firmware adds 802.11s mesh +
  Yggdrasil + an IPFS node + the protocol), **LoRa gateways** (ESP32 + LoRa, rooftop
  backbone for messages), **Raspberry Pi / mini-PC nodes**. *Needs funding for
  hardware.*
- **Phase 3 — Linking islands.** Long-range transports connect local meshes: LoRa
  across a city, FSO links between rooftops, a satellite gateway per district,
  Tor / Yggdrasil tunnels where the internet exists.
- **Phase 4 — Organic growth.** Once the network gives real daily value (free
  communication, content), growth is self-sustaining — every new node physically
  widens coverage.

**Firmware & updates without providers:** build on OpenWrt; sign images with a
threshold (M-of-N) signature in a public transparency log (defense against a targeted
backdoor); distribute images over the network itself + IPFS + mirrors, not from one
server. After install, the app updates itself **over the mesh** P2P — removal from the
stores doesn't kill it. A phone with the app can hand the installer to a neighbour over
BT / Wi-Fi, so each device seeds the next.

## Support development

Tract is built by **one person, with no funding** — no money to put it on the App
Store, and none for the LoRa antennas, gateways, and relay hardware the next phases
need. Honestly: right now I'd be glad just to be able to buy food. If Tract is useful
to you, or you want this kind of infrastructure to exist, any support helps me keep
building it. **Help with development is just as welcome as money** — read the code,
open issues/PRs, port transports, test on devices.

**Donate (crypto):**

| Method | Address |
|---|---|
| **USDT (TRC-20)** | `TKFidjphv372FQir3uDnLCEZNwrm8tLYkn` |
| **TON** | `UQC3cck542-7Bi57hVaA6iFjnJflVYHDHosK0OpqgwBYFbsA` |
| **Bitcoin (BTC)** | `bc1qe87f5j7qgpkg84z7ur0zxg973mpp6pe2rqur5m` |

**Reach me:** Telegram [@marco_611](https://t.me/marco_611) · channel
[@tractmesh](https://t.me/tractmesh)

## Status

**Works:** account and identity (Curve25519); add by ID + QR; text iOS↔iOS and
iOS↔desktop — nearby over the mesh, over the internet via a node **and node-lessly
via the DHT inbox** (store-and-forward); **multi-channel delivery with dedup** (a
message gets through even with flaky Bluetooth); chat history and call log persisted
across restarts; calls nearby over the mesh and over the internet (WebRTC, Opus) with
a **node → DHT → GetStream cascade** and a TURN relay for NAT; **presence by the
contact's real reachability** (node + DHT beacon); multi-hop relay and a
store-and-forward courier over the mesh; the BB84 ceremony on calls; auto node
discovery; read receipts (✓✓); a disableable third-party reserve (fully serverless
mode).

**Limitations / in progress:** push notifications and a call to a **closed/evicted**
app (needs APNs/PushKit — a local node can't wake the OS); a 100% serverless call
through symmetric NAT runs into the mandatory TURN relay (solved by *many of your
own* relays); node federation (so different nodes serve each other's users — the
`locateUser` DHT primitive already exists); video calls; long-range Bluetooth-LE; a
fresh web client on the native protocol.

---

## License & authorship

Tract and the **611protocol** were created by **Mark Azhusin** (`611marco`).

Licensed under the **GNU Affero General Public License v3.0** (see [`LICENSE`](LICENSE)
and [`NOTICE`](NOTICE)). The AGPL is **transitional** — it keeps Tract open and
credited while it grows; in keeping with the project's manifest (a network that
belongs to the people who use it, with no owner), Tract is intended to **later be
released freely, without a license at all** (public domain), once it can stand on its
own.

The names **Tract** and **611protocol** identify this project and its author.

*With love, from Infinity, Milky Way, Earth.* ❤️

