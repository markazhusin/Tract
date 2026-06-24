# Security Policy

Tract is privacy- and security-critical software. This page explains its security
model, what it does and does not protect, and how to report a vulnerability.

## Reporting a vulnerability

**Please report security issues privately — do not open a public issue for a
vulnerability.**

- **GitHub:** use **[Security → Report a vulnerability](https://github.com/markazhusin/Tract/security/advisories/new)**
  (private advisory).
- **Telegram:** [@marco_611](https://t.me/marco_611).

Please include: affected component (iOS app / `tract-cli` / `tract-node` / a
specific protocol), version or commit, reproduction steps, and impact. A proof of
concept helps. If you need encryption for the report, say so in a first message and
we'll arrange a key.

**What to expect:** an acknowledgement as soon as reasonably possible, an honest
assessment of severity, and coordinated disclosure once a fix is available. This is
an unfunded one-person project, so timelines are best-effort — but security reports
are taken seriously and prioritized. Researchers who report in good faith will be
credited (with your consent).

Safe-harbour: good-faith research — testing against your own devices/accounts,
without harming other users, degrading the network, or accessing data that isn't
yours — is welcome and won't be pursued.

## Supported versions

Tract is pre-1.0 and evolves quickly. **Only the latest commit on the default
branch is supported**; please reproduce against it before reporting. There are no
long-term maintenance branches yet.

## Security model — what Tract protects

- **Identity is a key, not an account.** Your ID is derived from a Curve25519
  public key generated on-device. There is no phone number, email, or server
  account to phish, SIM-swap, or subpoena.
- **End-to-end encryption (611protocol).** Message and call content is sealed on the
  device: Curve25519 (X25519 ECDH) → HKDF-SHA256 → AES-256-GCM. A node, the DHT, or
  any relay only ever sees ciphertext. See [`docs/611protocol.md`](docs/611protocol.md).
- **Live-call tamper-evidence.** Calls run a BB84 key-distribution ceremony; an
  active interceptor raises the QBER and the call **collapses** rather than
  continuing compromised. (This is tamper-evidence, not physical QKD — see below.)
- **No central point.** Nodes are stateless switchboards anyone can run; the network
  survives as long as one node, or a local mesh, or the DHT is reachable.
- **Censorship resistance.** A node can be reached over a built-in Tor onion service
  (no open ports, ISP-opaque), with Snowflake/obfs4 bridges where Tor itself is
  blocked.
- **Local-first storage.** Conversations, contacts, and keys live on the device. The
  account key never leaves it and cannot be recovered by anyone — including the
  author.

## Honest limitations — what Tract does NOT protect

We state these plainly rather than imply guarantees we can't keep:

- **Not anonymity from a global adversary.** Tract protects *content* and removes
  central choke points; it is not a guarantee of network-level anonymity against an
  adversary who can watch large parts of the internet. Use Tor mode and judge your
  own threat model.
- **BB84 here is tamper-evidence, not physical QKD.** No real photons cross the
  wire, so this is not information-theoretic secrecy; it is a credible ceremony that
  detects an active man-in-the-middle and tears the session down. Confidentiality
  comes from the classical E2E layer and the media transport's own encryption
  (DTLS-SRTP / the encrypted mesh).
- **A compromised endpoint defeats E2E.** If a device is unlocked, malware-infected,
  or physically seized while unlocked, on-device plaintext is exposed. Use the app
  passcode and device encryption.
- **Metadata.** A node and the DHT necessarily learn *that* two parties are trying to
  rendezvous and rough timing, even though they can't read content. The mesh floods
  ciphertext to nearby devices.
- **The optional third-party reserves are off by default.** The GetStream reserve
  (signaling) and ExpressTURN (media relay) are last-resort, disableable, and never
  hold plaintext; TURN credentials are client-visible by design. Run your own node's
  TURN to avoid third parties entirely.
- **Reproduce before trusting.** This is young software under active development and
  has not had a formal third-party audit. Treat it accordingly until it does.

## For self-hosters

- Never commit secrets. The Stream API secret is read **only** from the environment
  (`STREAM_API_SECRET`); there is no hardcoded default. If you enable the GetStream
  reserve, keep the secret in the node's environment, not in source.
- Prefer running your **own** TURN (the node's embedded relay or `TURN_URLS`) over
  the shared public relay.
- Tor onion reachability (`TRACT_TOR`) lets a node serve with no open ports.

*Thank you for helping keep Tract and its users safe.*
