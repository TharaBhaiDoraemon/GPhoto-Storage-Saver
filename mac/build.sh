#!/usr/bin/env bash
# Builds GPhotoStorageSaver-mac-arm64.zip and GPhotoStorageSaver-mac-x64.zip,
# each containing a self-contained GPhotoStorageSaver.app bundle for macOS.
#
# Requires (on the build machine, e.g. Linux): node, npm, python3 (+ Pillow),
# curl, unzip, tar, zip.
#
# Like the Windows .exe and the Linux AppImage, this bundles its own Node.js
# runtime and adb binary, so the only thing still expected on the target Mac
# is Google Chrome/Chromium. Node.js has no single "universal" download from
# nodejs.org, so this builds one .app per CPU architecture (Apple Silicon and
# Intel); Google's macOS adb is already a universal binary and is shared by
# both.
#
# This cannot be run/tested on real macOS from this (Linux) build machine, and
# the resulting .app bundles are unsigned - see mac/README.md for what that
# means for the person installing it.
set -euo pipefail

NODE_VERSION="v24.21.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
DIST_DIR="$SCRIPT_DIR/dist"
APP_STAGE="$BUILD_DIR/app-stage"

echo "==> Cleaning previous build"
rm -rf "$BUILD_DIR"
mkdir -p "$APP_STAGE" "$BUILD_DIR/tools" "$DIST_DIR"

echo "==> Copying app source (shared across architectures)"
cp -r "$ROOT_DIR/source/api" "$ROOT_DIR/source/lib" "$ROOT_DIR/source/steps" \
      "$ROOT_DIR/source/index.html" "$ROOT_DIR/source/package.json" \
      "$ROOT_DIR/source/package-lock.json" "$ROOT_DIR/source/server.mjs" \
      "$APP_STAGE/"

echo "==> Installing production dependencies (pure JS only, no native builds)"
( cd "$APP_STAGE" && npm install --omit=dev --omit=optional --no-audit --no-fund )

echo "==> Generating .icns from shared icon"
python3 "$SCRIPT_DIR/make_icns.py" "$ROOT_DIR/assets/icon.png" "$BUILD_DIR/tools/gphoto-storage-saver.icns"

PLATFORM_TOOLS_ZIP="$BUILD_DIR/tools/platform-tools-mac.zip"
if [ ! -f "$PLATFORM_TOOLS_ZIP" ]; then
  echo "==> Downloading Android platform-tools (adb, universal binary) for macOS"
  curl -sL -o "$PLATFORM_TOOLS_ZIP" "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip"
fi
echo "==> Extracting adb binary"
unzip -q -o -j "$PLATFORM_TOOLS_ZIP" "platform-tools/adb" -d "$BUILD_DIR/tools"
chmod +x "$BUILD_DIR/tools/adb"

build_arch() {
  local arch="$1"          # arm64 | x64
  local node_dir_arch="$2" # darwin-arm64 | darwin-x64
  local zip_arch="$3"      # arm64 | x64 (used in the output zip name)

  echo "==> [$arch] Downloading portable macOS Node.js $NODE_VERSION"
  local node_tar="$BUILD_DIR/tools/node-$NODE_VERSION-$node_dir_arch.tar.gz"
  if [ ! -f "$node_tar" ]; then
    curl -sL -o "$node_tar" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$node_dir_arch.tar.gz"
  fi
  tar -xzf "$node_tar" -C "$BUILD_DIR/tools" "node-$NODE_VERSION-$node_dir_arch/bin/node"

  echo "==> [$arch] Assembling GPhotoStorageSaver.app"
  local app_dir="$BUILD_DIR/$arch/GPhotoStorageSaver.app"
  local contents="$app_dir/Contents"
  mkdir -p "$contents/MacOS" "$contents/Resources/app"

  install -m 0644 "$SCRIPT_DIR/Info.plist" "$contents/Info.plist"
  install -m 0644 "$BUILD_DIR/tools/gphoto-storage-saver.icns" "$contents/Resources/gphoto-storage-saver.icns"
  install -m 0755 "$SCRIPT_DIR/Launcher" "$contents/MacOS/GPhotoStorageSaver"
  install -m 0755 "$BUILD_DIR/tools/node-$NODE_VERSION-$node_dir_arch/bin/node" "$contents/MacOS/node"
  install -m 0755 "$BUILD_DIR/tools/adb" "$contents/MacOS/adb"
  cp -r "$APP_STAGE/." "$contents/Resources/app/"

  echo "==> [$arch] Zipping"
  ( cd "$BUILD_DIR/$arch" && zip -q -r -X -y "$DIST_DIR/GPhotoStorageSaver-mac-$zip_arch.zip" "GPhotoStorageSaver.app" )
  echo "==> [$arch] Done: $DIST_DIR/GPhotoStorageSaver-mac-$zip_arch.zip"
}

build_arch "arm64" "darwin-arm64" "arm64"
build_arch "x64"   "darwin-x64"   "x64"

echo "==> All done:"
ls -la "$DIST_DIR"
