#!/usr/bin/env bash
# Builds GPhotoStorageSaver-x86_64.AppImage, a portable single-file Linux
# build of this app.
#
# Requires (on the build machine): node, npm, curl, unzip, tar.
# Downloads and caches appimagetool, a portable Node.js runtime, and Google's
# platform-tools (for adb) into appimage/build/ on first run.
#
# Unlike the .deb, this bundles its own Node.js and adb so the resulting
# AppImage runs on (almost) any x86_64 Linux distro with no dependencies
# beyond glibc/libstdc++ (already present everywhere) and, for the actual
# workflow, Google Chrome/Chromium installed separately.
set -euo pipefail

NODE_VERSION="v24.21.0"
APPIMAGETOOL_VERSION="1.9.1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APPDIR="$BUILD_DIR/AppDir"
DIST_DIR="$SCRIPT_DIR/dist"
APP_DIR="$APPDIR/usr/lib/gphoto-storage-saver"

echo "==> Cleaning previous build"
rm -rf "$APPDIR"
mkdir -p "$APP_DIR" "$APPDIR/usr/bin" "$BUILD_DIR/tools" "$DIST_DIR"

echo "==> Copying app source"
cp -r "$ROOT_DIR/source/api" "$ROOT_DIR/source/lib" "$ROOT_DIR/source/steps" \
      "$ROOT_DIR/source/index.html" "$ROOT_DIR/source/package.json" \
      "$ROOT_DIR/source/package-lock.json" "$ROOT_DIR/source/server.mjs" \
      "$APP_DIR/"

echo "==> Installing production dependencies (pure JS only, no native builds)"
( cd "$APP_DIR" && npm install --omit=dev --omit=optional --no-audit --no-fund )

NODE_TAR="$BUILD_DIR/tools/node-$NODE_VERSION-linux-x64.tar.xz"
if [ ! -f "$NODE_TAR" ]; then
  echo "==> Downloading portable Linux Node.js $NODE_VERSION"
  curl -sL -o "$NODE_TAR" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
fi
echo "==> Extracting node binary"
tar -xf "$NODE_TAR" -C "$BUILD_DIR/tools" "node-$NODE_VERSION-linux-x64/bin/node"
cp "$BUILD_DIR/tools/node-$NODE_VERSION-linux-x64/bin/node" "$APPDIR/usr/bin/node"

PLATFORM_TOOLS_ZIP="$BUILD_DIR/tools/platform-tools-linux.zip"
if [ ! -f "$PLATFORM_TOOLS_ZIP" ]; then
  echo "==> Downloading Android platform-tools (adb) for Linux"
  curl -sL -o "$PLATFORM_TOOLS_ZIP" "https://dl.google.com/android/repository/platform-tools-latest-linux.zip"
fi
echo "==> Extracting adb binary"
unzip -q -o -j "$PLATFORM_TOOLS_ZIP" "platform-tools/adb" -d "$APPDIR/usr/bin"
chmod +x "$APPDIR/usr/bin/node" "$APPDIR/usr/bin/adb"

echo "==> Assembling AppDir metadata"
install -m 0755 "$SCRIPT_DIR/AppRun" "$APPDIR/AppRun"
install -m 0644 "$SCRIPT_DIR/gphoto-storage-saver.desktop" "$APPDIR/gphoto-storage-saver.desktop"
install -m 0644 "$ROOT_DIR/assets/icon.png" "$APPDIR/gphoto-storage-saver.png"

APPIMAGETOOL="$BUILD_DIR/tools/appimagetool-x86_64.AppImage"
if [ ! -f "$APPIMAGETOOL" ]; then
  echo "==> Downloading appimagetool $APPIMAGETOOL_VERSION"
  curl -sL -o "$APPIMAGETOOL" "https://github.com/AppImage/appimagetool/releases/download/$APPIMAGETOOL_VERSION/appimagetool-x86_64.AppImage"
  chmod +x "$APPIMAGETOOL"
fi

echo "==> Running appimagetool"
ARCH=x86_64 "$APPIMAGETOOL" --appimage-extract-and-run "$APPDIR" \
  "$DIST_DIR/GPhotoStorageSaver-x86_64.AppImage"

echo "==> Done: $DIST_DIR/GPhotoStorageSaver-x86_64.AppImage"
