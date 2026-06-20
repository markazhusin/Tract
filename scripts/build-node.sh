#!/usr/bin/env bash
# Build standalone Tract signaling-node executables for every common platform.
# Pure-Go, statically linked (CGO disabled) — a single file anyone can run:
#
#   ./tract-node-<os>-<arch>      # listens on :8877, data in ./data, zero config
#
# Point nothing at it manually: clients discover nodes automatically. Any node
# that is online serves the network.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="dist-node"
mkdir -p "$OUT"
LDFLAGS="-s -w"

build() {
  local os="$1" arch="$2" ext="${3:-}"
  echo "[build] $os/$arch"
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 go build -trimpath -ldflags "$LDFLAGS" \
    -o "$OUT/tract-node-$os-$arch$ext" .
}

build darwin arm64
build darwin amd64
build linux  amd64
build linux  arm64
build windows amd64 .exe

echo
echo "Built into $OUT/:"
ls -lh "$OUT"
echo
echo "Run a node:  ./$OUT/tract-node-<your-os>-<arch>   (then it serves the network on :8877)"
