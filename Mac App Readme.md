# Mac App Readme

Steps taken to build a macOS `.app` bundle for this project, from Linux.

## 1. Framed the goal against the other three builds already done

The `.exe` bundles a portable Node.js + adb (Windows has no system package
manager to lean on); the `.deb` leans on `apt` for both; the AppImage
bundles both for zero-dependency portability. macOS sits closer to the
AppImage end: no system package manager convention users are expected to
use, so the same "bundle everything, only Chrome stays external" approach
was used here too.

## 2. Worked out what's actually different about building for macOS from Linux

- No `hdiutil` (needed for a real `.dmg`) exists outside macOS, so a `.dmg`
  was ruled out as a build-machine deliverable
- No `codesign`/notarization tooling or Apple Developer certificate is
  available here, so the bundle is necessarily unsigned
- No `lipo` (Apple's fat-binary tool) is available, so Node.js — which
  nodejs.org only ships as separate `darwin-arm64`/`darwin-x64` downloads,
  not a combined universal binary — can't be merged into one binary; instead
  the build produces **two separate `.app` bundles**, one per architecture
- No `iconutil` (needed to build `.icns` on macOS) is available, so `.icns`
  generation needed another route

Given these constraints, the most honest deliverable achievable from this
Linux machine is: two unsigned, zipped `.app` bundles (arm64 and x64), with
the README explicitly flagging what wasn't verified (nothing here could
actually be launched on real macOS to confirm it works).

## 3. Found a Linux-buildable path to a valid `.icns`

Instead of installing the Debian `icnsutils` package (would need `sudo`,
same friction as `nsis` did for the `.exe`), checked whether Pillow (already
installed, used earlier for the AppImage's icon) can write ICNS directly.
Confirmed with a quick test: `Image.save('icon.icns')` produced a file that
`file` correctly identified as `Mac OS X icon, ... "TOC " type`. Wrote this
as `mac/make_icns.py`, a two-line Pillow wrapper.

## 4. Refactored the AppImage's icon into a shared location

The generic (non-branded) icon generated for the AppImage build was moved
from `appimage/gphoto-storage-saver.png` to `assets/icon.png` so both the
AppImage and this macOS build (and, in the future, anything else) generate
their platform-specific icon formats from one source image.
`appimage/build.sh` was updated to copy from the new path, and the AppImage
was rebuilt to confirm the refactor didn't break it.

## 5. Verified the bundled binaries before committing to the design

- Downloaded Google's macOS `platform-tools` zip and checked `adb` with
  `file`: confirmed it's a **universal binary** (x86_64 + arm64 in one file),
  so only one copy is needed for both architecture builds
- Downloaded both `node-v24.21.0-darwin-arm64` and `-darwin-x64` tarballs
  and confirmed each `bin/node` is a valid Mach-O executable for its
  intended architecture (couldn't run either one here — no macOS — so this
  was a static file-format check only, not an execution test)

## 6. Worked out where the app's writable state should live

Same reasoning as the `.deb`/AppImage: `source/lib/config.mjs`'s `WORK_DIR`
has an environment-variable override, so the launcher script points it at
`~/Library/Application Support/GPhotoStorageSaver` — the macOS-conventional
location for this kind of app data — instead of inside the read-only bundle.

## 7. Built the `.app` bundle structure

- `Contents/Info.plist` — bundle metadata (`CFBundleExecutable`,
  `CFBundleIdentifier`, `LSMinimumSystemVersion`, etc.)
- `Contents/MacOS/GPhotoStorageSaver` — launcher script; creates the
  Application Support data dir, exports `WORK_DIR`, prepends
  `Contents/MacOS` to `PATH` (so the existing `which adb` fallback in
  `lib/adb.mjs` picks up the bundled `adb` with zero code changes), execs
  the bundled `node` against `server.mjs`
- `Contents/MacOS/node`, `Contents/MacOS/adb` — the bundled binaries
- `Contents/Resources/app/` — app code + `node_modules` (just `ws`, pure JS,
  no native bindings), following the same `Contents/Resources/app`
  convention Electron apps use
- `Contents/Resources/gphoto-storage-saver.icns` — the generated icon

## 8. Wrote `mac/build.sh`

Stages the app source once (shared across both architectures), generates
the `.icns`, downloads/caches the universal `adb` and both Node.js
tarballs, then assembles and zips one `.app` per architecture:
`GPhotoStorageSaver-mac-arm64.zip` and `GPhotoStorageSaver-mac-x64.zip`.

## 9. Built and verified what could be verified without macOS

Ran `./build.sh` — both zips built successfully. Then:

- Confirmed `unzip -l` / `zipinfo -l` show the right structure and,
  critically, that **Unix executable permissions survive the zip round-trip**
  (re-extracted to a scratch directory and confirmed `node`, `adb`, and the
  launcher script all came back `-rwxr-xr-x`) — a zip created without care
  can silently drop the executable bit, which would make the app fail
  silently on a Mac
- Confirmed `file` reports the right Mach-O architecture for each `node`
  binary and universal `adb` inside each extracted bundle
- Explicitly did **not** claim the app launches or runs correctly on macOS,
  since that can't be tested from this machine

## 10. Wrote `mac/README.md`

Documents the layout, build steps, and — unlike the other three platforms —
a **Gatekeeper workaround section**, since an unsigned app downloaded from
the internet needs either right-click→Open or `xattr -cr` before macOS will
run it at all. Also documented the optional `hdiutil` command a Mac user
could run themselves if they want an actual `.dmg`, since that step requires
real macOS and can't be done here.

## 11. Cleaned up git hygiene

- Added `mac/build/` and `mac/dist/` to `.gitignore`, mirroring the other
  three platforms
- Only small source files (`Launcher`, `Info.plist`, `make_icns.py`,
  `build.sh`, `README.md`) plus the moved `assets/icon.png` are meant to be
  committed — no build output, no downloaded binaries
- Did not commit anything, since it wasn't requested

## Result

Final output: `mac/dist/GPhotoStorageSaver-mac-arm64.zip` and
`mac/dist/GPhotoStorageSaver-mac-x64.zip`, rebuildable via:

```bash
cd mac && ./build.sh
```

**Caveat that doesn't apply to the other three platforms:** this one is
genuinely untested end-to-end. The `.exe`, `.deb`, and AppImage could all be
directly executed and verified working on this Linux machine; this build
could only be verified by static inspection (file formats, permissions,
bundle structure). Treat it as "should work" rather than "confirmed
working" until it's actually launched on a Mac.
