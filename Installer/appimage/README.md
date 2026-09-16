# AppImage

Builds `GPhotoStorageSaver-x86_64.AppImage`, a portable single-file Linux
build of Google Photos Quota Reclaim.

Unlike the `.deb`, this bundles its own Node.js runtime and `adb` binary
directly inside the image (matching the Windows `.exe`'s "no prerequisites"
approach, adapted to AppImage's own philosophy: run anywhere, no package
manager, no install step). It only depends on glibc/libstdc++, which are
present on essentially every x86_64 Linux distro, plus Google Chrome/Chromium
installed separately for the actual browser-driving part of the workflow.

## Layout inside the AppImage

- `AppRun` — entry point run by the AppImage runtime; sets `WORK_DIR` to
  `~/.local/share/gphoto-storage-saver` (so `downloads/` and `manifest.json`
  live in the user's home directory, not inside the read-only image) and
  execs the bundled `node` against `server.mjs`
- `usr/bin/node` — portable Node.js runtime
- `usr/bin/adb` — Android Debug Bridge binary; `AppRun` prepends `usr/bin` to
  `PATH` so `source/lib/adb.mjs`'s existing `which adb` PATH-fallback picks
  it up with no code changes
- `usr/lib/gphoto-storage-saver/` — app code + `node_modules` (just `ws`,
  pure JS, no native bindings)
- `gphoto-storage-saver.desktop`, `gphoto-storage-saver.png` — desktop
  integration metadata and icon (sourced from the shared
  `../../assets/icon.png`, also reused by the deb and macOS builds — licensed
  CC BY 4.0)

## Build

From any x86_64 Linux machine with `node`, `npm`, `curl`, `unzip`, and `tar`
on PATH:

```bash
./build.sh
```

First run downloads and caches (into `Installer/appimage/build/tools/`, gitignored):
portable Linux Node.js, Google's `platform-tools` (for `adb`), and
`appimagetool` itself. No `sudo`/root or FUSE mount needed — the build uses
`appimagetool --appimage-extract-and-run`.

Output: `Installer/appimage/dist/GPhotoStorageSaver-x86_64.AppImage`.

## Run

```bash
chmod +x GPhotoStorageSaver-x86_64.AppImage
./GPhotoStorageSaver-x86_64.AppImage
```

No installation step — it's a single executable file. Optionally use
[AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) to
integrate it into the desktop's app menu.

## Files

- `AppRun` — launcher script (the actual entry point)
- `gphoto-storage-saver.desktop` — desktop entry metadata
- `../../assets/icon.png` — shared icon (CC BY 4.0), copied in at build time
  as `gphoto-storage-saver.png`
- `build.sh` — stages the AppDir (app + deps + bundled node/adb + metadata),
  then runs `appimagetool`
- `build/`, `dist/` — generated, gitignored; safe to delete and rebuild

## Notes

- Bump `NODE_VERSION` in `build.sh` when updating the bundled Node.js.
- `platform-tools-latest-linux.zip` always points at Google's latest `adb`;
  re-running `build.sh` after deleting
  `Installer/appimage/build/tools/platform-tools-linux.zip` picks up a newer
  version.
- The AppImage is unsigned; some distros' desktop environments require
  marking it executable manually before first run.
