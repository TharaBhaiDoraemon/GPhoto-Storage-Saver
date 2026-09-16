# Windows Installer

Builds `GPhotoStorageSaver-Setup.exe`, a self-contained NSIS installer for
Google Photos Quota Reclaim.

The installer bundles:
- The app itself (`source/`, plus its production `node_modules` — just `ws`,
  a pure-JS package with no native bindings, so it's safe to build on any OS)
- `adb/` — the Windows platform-tools already checked into the repo root
- A portable Windows Node.js runtime, so the target machine needs **no**
  separate Node.js install — only Google Chrome (or Chromium)

It installs per-user to `%LOCALAPPDATA%\GPhotoStorageSaver` (no admin
rights / UAC prompt needed), creates Start Menu + Desktop shortcuts that run
`Launch.bat`, and registers a normal Add/Remove Programs entry with an
uninstaller.

## Build

From Linux, macOS, or Windows, with `node`, `npm`, `curl`, `unzip`, and NSIS's
`makensis` on PATH (`sudo apt install -y nsis` on Debian/Ubuntu):

```bash
./build.sh
```

Output: `installer/dist/GPhotoStorageSaver-Setup.exe`.

## Files

- `installer.nsi` — the NSIS script (source of truth for what gets installed)
- `Launch.bat` — launcher shortcut target; runs the bundled `node.exe` against
  `source/server.mjs`
- `notice.txt` — the license/disclaimer page shown during install (destructive
  Trash + Reupload step warning)
- `build.sh` — stages a clean copy of the app + deps + adb + portable Node,
  then invokes `makensis`
- `build/`, `dist/` — generated, gitignored; safe to delete and rebuild

## Notes

- Uninstalling removes program files but deliberately leaves `downloads/` and
  any `manifest*.json*` files in place, since those hold the user's in-progress
  recovery state, not just installed program files.
- Bump `NODE_VERSION` in `build.sh` and `DisplayVersion` in `installer.nsi` when
  updating.
