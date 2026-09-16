# Windows EXE Readme

Steps taken to build a self-contained Windows `.exe` installer for this project.

## 1. Investigated the project structure

Read `source/package.json`, `README.md`, `Google Photos Quota Reclaim.bat`,
`server.mjs`, `lib/config.mjs`, and `lib/adb.mjs` to understand: it's a plain
Node.js app (no framework/build step), depends only on `ws`, serves a GUI on
`localhost:8080`, auto-launches Chrome via CDP, talks to a phone via `adb`,
and resolves `WORK_DIR`/`adb/`/`downloads/` relative to the folder structure
(`root/source`, `root/adb`, `root/downloads`).

## 2. Checked what tooling was available

- `makensis` (NSIS) — not installed
- `pkg` / `nexe` — not installed
- Confirmed NSIS was installable via `apt` but needed `sudo`, so the user was
  asked to run `sudo apt install -y nsis` themselves rather than doing it
  silently.

## 3. Asked the user two decisions

- Whether to wait for NSIS to be installed vs. fall back to a plain ZIP —
  user chose to install NSIS.
- Whether to bundle a portable Node.js runtime so users need zero
  prerequisites vs. requiring system Node — user chose to bundle it.

## 4. Confirmed internet access, picked a Node.js version

Fetched the current Node.js LTS version (`v24.21.0`) from
`nodejs.org/dist/index.json`.

## 5. Downloaded and extracted the portable Windows Node.js build

Downloaded `node-v24.21.0-win-x64.zip` into a scratch directory and pulled
out just `node.exe`.

## 6. Staged the app for packaging

- Copied `source/{api,lib,steps,index.html,package.json,package-lock.json,server.mjs}`
  (left out `docs/`, not needed at runtime)
- Ran `npm install --omit=dev --omit=optional` to install just `ws`,
  confirming it has no native `.node` bindings — safe to build cross-platform
  from Linux
- Copied the existing `adb/` folder (already Windows binaries)
- Created an empty `downloads/` folder
- Wrote `Launch.bat` (`cd source && node.exe server.mjs`, with an error
  pause), converted to CRLF line endings for Windows

## 7. Wrote the NSIS installer script (`installer.nsi`)

- Per-user install to `%LOCALAPPDATA%\GPhotoStorageSaver`
  (`RequestExecutionLevel user`) so no admin/UAC prompt
- MUI2 wizard: welcome → license/disclaimer page (`notice.txt`, warning about
  the destructive Trash+Reupload step) → install directory → start menu
  folder → install progress → finish (with "launch now" option)
- Install section: copies `Launch.bat`, `README.md`, `source/`, `adb/`,
  bundled `node/node.exe`; creates `downloads/`; writes registry keys for
  `HKCU\...\Uninstall` (Add/Remove Programs entry); creates Start Menu +
  Desktop shortcuts
- Uninstall section: removes program files and shortcuts/registry, but
  deliberately leaves `downloads/` and manifest files alone since those hold
  user recovery state, not just program files

## 8. Compiled and verified

Ran `makensis installer.nsi`, checked the output with `file` to confirm it's
a valid Windows PE installer (~28 MB).

## 9. Made it reproducible in the repo

- Moved everything into a proper `installer/` folder in the project:
  `installer.nsi`, `Launch.bat`, `notice.txt`
- Wrote `installer/build.sh` — a script that redoes steps 5–8 from scratch
  (stage source, `npm install`, copy `adb/`, download/cache the Node zip, run
  `makensis`) so the installer can be rebuilt anytime after code changes
- Wrote `installer/README.md` documenting how to build it and what's included
- Re-ran `./build.sh` end-to-end from the committed layout to confirm it
  reproduces the installer correctly

## 10. Cleaned up git hygiene

- Added `installer/build/` and `installer/dist/` to `.gitignore` (build
  cache and the 28 MB output shouldn't be committed)
- Verified with `git add -n` that only the small source scripts
  (`installer.nsi`, `Launch.bat`, `notice.txt`, `build.sh`, `README.md`)
  would be staged — no binaries
- Did not commit anything, since it wasn't requested

## Result

Final output: `installer/dist/GPhotoStorageSaver-Setup.exe`, rebuildable via:

```bash
cd installer && ./build.sh
```
