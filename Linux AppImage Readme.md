# Linux AppImage Readme

Steps taken to build a portable `.AppImage` for this project.

## 1. Checked what tooling was available

- `appimagetool` — not installed
- FUSE (`/dev/fuse`, `fusermount`/`fusermount3`) — available, but built the
  script to not depend on it anyway (see step 7)
- ImageMagick's `convert` — available, used to generate an icon

## 2. Decided the dependency strategy (different from both the `.exe` and `.deb`)

AppImage's whole premise is "run anywhere, no install step, no package
manager" — the opposite end of the spectrum from the `.deb`, which
deliberately leans on `apt` for `nodejs`/`adb`. So for the AppImage, the
decision was to bundle everything, matching the Windows `.exe`'s approach:
a portable Node.js runtime and a Linux `adb` binary both go inside the
image, so the only thing still expected on the host system is Chrome/
Chromium (needed for the actual browser-driving workflow) and ordinary
glibc/libstdc++, which are present on essentially every distro.

## 3. Verified the bundled binaries would actually run standalone

Downloaded the official Linux Node.js tarball and Google's Linux
`platform-tools` zip, copied just `bin/node` and `platform-tools/adb` out to
an empty directory each, and ran them directly (`ldd` + a smoke test) to
confirm neither needs anything beyond system libraries already present on
any modern Linux box — safe to embed without dragging in extra shared-object
files.

## 4. Located the current `appimagetool`

The old `AppImage/AppImageKit` GitHub releases had all their assets renamed
to `obsolete-*` — the tool moved to a new repo, `AppImage/appimagetool`.
Found and downloaded the current stable release (1.9.1) from there instead
of the (defunct) legacy location.

## 5. Worked out where the app's writable state should live

Same reasoning as the `.deb`: `source/lib/config.mjs`'s `WORK_DIR` has an
environment-variable override, so the AppImage's launcher script points it
at the user's own `~/.local/share/gphoto-storage-saver` instead of the
read-only, mounted-at-runtime image contents.

## 6. Built the AppDir

- `AppRun` — the entry point; creates
  `~/.local/share/gphoto-storage-saver/downloads`, exports `WORK_DIR` there,
  prepends the AppImage's own `usr/bin` to `PATH` (so the existing
  `which adb` fallback in `lib/adb.mjs` picks up the bundled `adb` with zero
  code changes), then execs the bundled `node` against `server.mjs`
- `usr/bin/node`, `usr/bin/adb` — the bundled runtime and Android tool
- `usr/lib/gphoto-storage-saver/` — app code + `node_modules` (just `ws`,
  pure JS, no native bindings)
- `gphoto-storage-saver.desktop` — required top-level desktop entry
- `gphoto-storage-saver.png` — a required top-level icon; since no branded
  icon exists for this project and reusing an actual company's logo would be
  inappropriate, generated a simple, generic "picture" glyph (mountain + sun
  on a rounded square) with ImageMagick rather than fabricating a real logo

## 7. Wrote `appimage/build.sh`

Stages the AppDir under `appimage/build/`, copies in the app source, runs
`npm install --omit=dev --omit=optional` for just `ws`, downloads and caches
(under `appimage/build/tools/`) the portable Node.js tarball, Google's
platform-tools zip, and `appimagetool` itself on first run, then builds with:

```bash
ARCH=x86_64 appimagetool --appimage-extract-and-run AppDir dist/GPhotoStorageSaver-x86_64.AppImage
```

`--appimage-extract-and-run` was used deliberately so the build doesn't
depend on a working FUSE mount being available on the build machine (e.g. in
containers/CI where FUSE is often unavailable), even though it happened to
be available here.

## 8. Built and verified

Ran `./build.sh` — appimagetool warned only about optional AppStream
metadata being absent (cosmetic, not required). Then actually ran the
resulting AppImage:

- Confirmed it's a valid ELF executable via `file`
- Ran it with a timeout, confirmed the log showed the correct bundled
  `WORK_DIR`/`downloads` paths under `~/.local/share`
- Confirmed `curl http://127.0.0.1:8080/` returned `HTTP 200`
- Confirmed it shut down cleanly on `SIGTERM`
- Separately confirmed the bundled `adb` resolves correctly via `PATH` using
  the same lookup mechanism `lib/adb.mjs` uses (`which adb`)
- Cleaned up the test run's `~/.local/share/gphoto-storage-saver` directory
  afterward

## 9. Wrote `appimage/README.md`

Documents the AppDir layout, how to build it, and how to run it (just
`chmod +x` and execute — no install step at all).

## 10. Cleaned up git hygiene

- Added `appimage/build/` and `appimage/dist/` to `.gitignore`, mirroring
  the `.exe` and `.deb` builds
- Only the small source files (`AppRun`, `gphoto-storage-saver.desktop`,
  `build.sh`, `README.md`) are meant to be committed — no build output, no
  downloaded binaries
- Did not commit anything, since it wasn't requested

*(Updated when the macOS build was added: the icon this step generated was
later moved to the shared `assets/icon.png` so both the AppImage and macOS
builds derive their platform-specific icon from one source — see
`Mac App Readme.md` step 4.)*

## Result

Final output: `appimage/dist/GPhotoStorageSaver-x86_64.AppImage`, rebuildable
via:

```bash
cd appimage && ./build.sh
```
