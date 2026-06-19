# Tract — iOS app (offline mesh)

Native iOS shell that runs the existing Tract web UI inside a `WKWebView` and adds
a **real offline mesh** using Apple's **MultipeerConnectivity** (peer-to-peer
Wi-Fi + Bluetooth). This is what lets **two phones with the internet OFF** find
each other and exchange messages — something a plain web app / PWA cannot do on
iOS (Safari/WKWebView have no Web Bluetooth, and Multipeer is native-only).

## How it fits together

```
Web UI (dist/) ──WKWebView──┐
                            │  window.webkit.messageHandlers.tractMesh  (JS → native)
NativeMeshTransport (JS) ───┤  window.__tractMeshDeliverB64 / __tractMeshPeer / __tractMeshPeers (native → JS)
                            │
MeshTransport.swift  ──MultipeerConnectivity── nearby devices (no internet, no server)
```

- The web app registers `NativeMeshTransport` (see `app/transports/native-mesh.js`)
  in its message multiplexer **only when running inside this shell**.
- Outgoing chat packets are already **E2E-encrypted**, so the mesh just floods
  them to nearby devices; only the real recipient can decrypt. That flood-and-
  filter *is* the mesh.
- Devices advertise their `userId` + public key over Bonjour `discoveryInfo`, so
  two phones auto-discover each other as contacts and can encrypt without a server.

## Build & run

Prereqs: macOS, **Xcode** (with an iOS 26 SDK for your device), Node (for the web
build), and [XcodeGen](https://github.com/yonkornilov/xcodegen) (`brew install xcodegen`).

```bash
# 1. Build the web app into the bundle (relative paths for file:// loading)
./ios/sync-web.sh

# 2. Generate the Xcode project (first time, and after changing project.yml)
cd ios && xcodegen generate

# 3. Open and run
open Tract.xcodeproj
```

In Xcode: select the **Tract** target → **Signing & Capabilities** → pick your
Apple ID / team (free account is fine for on-device install). Plug in the iPhone,
select it as the run destination, press ▶. Trust the developer profile on the
phone (Settings → General → VPN & Device Management) the first time.

Repeat for the second phone (or install the same build on both).

### No XcodeGen?

Create a new Xcode iOS App (SwiftUI), delete its `ContentView`/`App` files, drag
in everything under `ios/Tract/` (Swift files + `Info.plist`), and add `web/` as a
**folder reference** (blue folder) so its structure is preserved in the bundle.
Set the same Info.plist keys (already in `ios/Tract/Info.plist`).

## Testing the mesh on two phones (internet OFF)

1. Install and open the app on **both** phones.
2. On each, create an account (name + password). Works offline — the identity is
   generated locally; the server upload silently no-ops.
3. Turn **Airplane mode ON**, then turn **Wi-Fi and Bluetooth back ON** (Airplane
   mode keeps cellular/internet off but Multipeer still uses Wi-Fi/BT locally).
4. Keep the phones near each other. Within a few seconds each should appear in the
   other's contact list (auto-discovered over the mesh).
5. Open the chat and send messages both ways — they travel device-to-device with
   no internet and no server.

Grant the **Local Network** and **Bluetooth** permission prompts on first launch.

## Known limitations (current pass)

- **Icons/fonts offline:** the web UI loads Material Icons from Google Fonts over
  https; with no internet the icon glyphs won't render (text still works). Bundle
  the font locally for fully-offline polish — TODO.
- **Service worker:** disabled under `file://` (needs https); the app still runs.
- **Calls over mesh:** voice/video still use WebRTC (internet/STUN/TURN). Mesh
  currently carries text/voice-note **messages**, not live calls.
- **Multi-hop relay:** packets flood to *directly* connected peers. Store-and-
  forward / multi-hop relaying is a next step.
