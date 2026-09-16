#!/usr/bin/env bash
# Builds gphoto-storage-saver_<version>_all.deb, a Debian/Ubuntu package for
# this app.
#
# Requires (on the build machine): node, npm, dpkg-deb, gzip.
# No sudo/root needed to build - dpkg-deb --root-owner-group fakes ownership.
set -euo pipefail

VERSION="1.0.0"
PKG="gphoto-storage-saver"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
PKG_ROOT="$BUILD_DIR/${PKG}_${VERSION}_all"
DIST_DIR="$SCRIPT_DIR/dist"
APP_DIR="$PKG_ROOT/usr/lib/$PKG"
DOC_DIR="$PKG_ROOT/usr/share/doc/$PKG"

echo "==> Cleaning previous build"
rm -rf "$PKG_ROOT"
mkdir -p "$APP_DIR" "$PKG_ROOT/usr/bin" "$PKG_ROOT/usr/share/applications" \
         "$DOC_DIR" "$PKG_ROOT/DEBIAN" "$DIST_DIR"

echo "==> Copying app source"
cp -r "$ROOT_DIR/source/api" "$ROOT_DIR/source/lib" "$ROOT_DIR/source/steps" \
      "$ROOT_DIR/source/index.html" "$ROOT_DIR/source/package.json" \
      "$ROOT_DIR/source/package-lock.json" "$ROOT_DIR/source/server.mjs" \
      "$APP_DIR/"

echo "==> Installing production dependencies (pure JS only, no native builds)"
( cd "$APP_DIR" && npm install --omit=dev --omit=optional --no-audit --no-fund )

echo "==> Installing launcher script"
install -m 0755 "$SCRIPT_DIR/gphoto-storage-saver" "$PKG_ROOT/usr/bin/gphoto-storage-saver"

echo "==> Installing desktop entry"
install -m 0644 "$SCRIPT_DIR/gphoto-storage-saver.desktop" \
  "$PKG_ROOT/usr/share/applications/gphoto-storage-saver.desktop"

echo "==> Installing docs"
install -m 0644 "$ROOT_DIR/README.md" "$DOC_DIR/README.md"
install -m 0644 "$SCRIPT_DIR/copyright" "$DOC_DIR/copyright"
gzip -9 -n -c "$SCRIPT_DIR/changelog" > "$DOC_DIR/changelog.Debian.gz"

echo "==> Writing control file"
INSTALLED_SIZE_KB=$(du -sk "$PKG_ROOT" | cut -f1)
{
  cat "$SCRIPT_DIR/control"
  echo "Installed-Size: $INSTALLED_SIZE_KB"
} > "$PKG_ROOT/DEBIAN/control"

echo "==> Building .deb"
dpkg-deb --root-owner-group --build "$PKG_ROOT" "$DIST_DIR/${PKG}_${VERSION}_all.deb"

echo "==> Done: $DIST_DIR/${PKG}_${VERSION}_all.deb"
