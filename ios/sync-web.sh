#!/usr/bin/env bash
# Build the web app with RELATIVE asset paths (needed for file:// loading inside
# WKWebView) and copy it into the iOS bundle folder (ios/Tract/web).
# Run this whenever the web app changes, then rebuild in Xcode.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[sync-web] building web with --base=./ ..."
npx vite build --base=./ --outDir ios/Tract/web --emptyOutDir

echo "[sync-web] done → ios/Tract/web"
echo "[sync-web] Now run 'xcodegen generate' (first time) and rebuild in Xcode."
