#!/usr/bin/env bash
# Builds GPhotoStorageSaver-Setup.exe, a Windows installer for this app.
#
# Requires (on the build machine, e.g. Linux): node, npm, curl, unzip, makensis (NSIS).
#   sudo apt install -y nsis
#
# The installer bundles: the app source, adb/ (Windows platform-tools, already
# in the repo), and a portable Windows Node.js runtime, so the target machine
# needs nothing but Google Chrome pre-installed.
set -euo pipefail

NODE_VERSION="v24.21.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
STAGE_DIR="$BUILD_DIR/stage"
DIST_DIR="$SCRIPT_DIR/dist"

echo "==> Cleaning previous build"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/source" "$STAGE_DIR/downloads" "$STAGE_DIR/node" "$DIST_DIR"

echo "==> Copying app source"
cp -r "$ROOT_DIR/source/api" "$ROOT_DIR/source/lib" "$ROOT_DIR/source/steps" \
      "$ROOT_DIR/source/index.html" "$ROOT_DIR/source/package.json" \
      "$ROOT_DIR/source/package-lock.json" "$ROOT_DIR/source/server.mjs" \
      "$STAGE_DIR/source/"

echo "==> Installing production dependencies (pure JS only, no native builds)"
( cd "$STAGE_DIR/source" && npm install --omit=dev --omit=optional --no-audit --no-fund )

echo "==> Copying adb platform-tools"
cp -r "$ROOT_DIR/adb" "$STAGE_DIR/adb"

echo "==> Copying launcher + readme + icon"
cp "$SCRIPT_DIR/Launch.bat" "$STAGE_DIR/Launch.bat"
cp "$ROOT_DIR/README.md" "$STAGE_DIR/README.md"
cp "$ROOT_DIR/assets/icon.ico" "$STAGE_DIR/icon.ico"

NODE_ZIP="$BUILD_DIR/node-$NODE_VERSION-win-x64.zip"
if [ ! -f "$NODE_ZIP" ]; then
  echo "==> Downloading portable Windows Node.js $NODE_VERSION"
  curl -sL -o "$NODE_ZIP" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-win-x64.zip"
fi
echo "==> Extracting node.exe"
unzip -q -o -j "$NODE_ZIP" "node-$NODE_VERSION-win-x64/node.exe" -d "$STAGE_DIR/node"

echo "==> Running makensis"
( cd "$SCRIPT_DIR" && makensis installer.nsi )

echo "==> Done: $DIST_DIR/GPhotoStorageSaver-Setup.exe"
