# GPhoto-Storage-Saver (Google Photos Quota Reclaim)

A web-based GUI application that reclaims Google Photos storage quota by re-uploading your media
through a Google Pixel phone, which backs it up quota-free. It drives an authenticated Chrome
browser session (so it never needs your password or an API key) and your Pixel over USB.

---

## Features

- **Scan & Prepare** (step 1): finds quota-consuming media via Chrome DevTools Protocol (CDP) —
  choose specific albums in the sidebar, or flip the **Scan Albums / Scan All Library** toggle to
  scan the entire library at once. Also enriches items with `dedupKey`s and records their album
  memberships.
- **Match Downloads / Download** (step 2): links files you've already placed in `downloads/`
  (e.g. via Google Takeout) to scanned items, or skips Takeout entirely with a direct **Download**
  button that pulls originals straight from Google Photos.
- **Trash + Reupload, or Push-only** (step 3): the core (destructive, irreversible) step deletes
  each item from the cloud and pushes it to the Pixel's camera roll via ADB. A separate
  non-destructive **Push** button pushes files to the device *without* touching the cloud copy —
  useful for moving photos to a second account without freeing the first account's quota.
  **Repush** retries just the on-device push half for anything that trashed successfully but
  failed to push.
- **Verify** (step 4): confirms each item is quota-free wherever the currently-connected Google
  account is — this doubles as a **cross-account presence check**: scan account A, switch Chrome
  to account B, and Verify without ever running Trash + Reupload. A **Verify Reset** button clears
  verification state so a batch can be re-checked (e.g. against a different account). The
  "not yet verified" list view updates live as items get confirmed mid-run, with a **Download
  these** button scoped to exactly what's currently shown/filtered in it.
- **Album & Archive Restoration** (step 5): restores album organization and re-archives items that
  were archived before the pipeline touched them, using their post-reupload identity.
- **Cleanup Pixel** (step 6): clears the pushed files from the Pixel's camera folder once backup is
  confirmed. **Reset** / **Reset All** / **Verify Reset** give you three different granularities of
  starting over.
- **Multi-account support, fully automatic**: clicking **Launch Chrome** opens Chrome, then
  automatically discovers every Google account signed into that browser profile and opens one
  confirmed tab per account (`/u/0/`, `/u/1/`, `/u/2/`, ...). The account switcher shows each
  account's resolved email next to its slot and pins whichever one you pick — every operation then
  refuses to run against a different account until you switch again, so a stray extra tab can
  never silently redirect an operation to the wrong account.
- **Live-updating viewers**: the View buttons on Scan/Match/Verify open a searchable list of the
  relevant items that refreshes in place as the underlying operation makes progress, instead of a
  static snapshot you have to re-open.
- **Dark / Light & Multi-Theme UI**: custom color themes (AMOLED, Charcoal, Slate, Grey in dark
  mode; White, Paper, Mist, Grey in light mode) plus accent color and localization support (`en`,
  `ru`, `zh_TW`, `zh_CN`, `ja_JP`).

---

## Architecture & How It Works

1. **Local Node.js server**: serves a single-page interface, orchestrates every step, and manages
   ADB operations. No build step, no framework — one `index.html`, a handful of `.mjs` files.
2. **Chrome CDP (DevTools Protocol)**: connects to a Chrome instance running with
   `--remote-debugging-port=9222`. Every Google Photos API call is injected into that browser tab
   (not made directly from Node), so your session cookies never leave Chrome.
3. **Android Debug Bridge (ADB)**: pushes photos to `/sdcard/DCIM/Camera/` on your connected
   Google Pixel phone, triggering the Google Photos app to back them up under the Pixel's
   quota-free upload perk.
4. **Account pinning**: once you've used the account switcher, `connectCdp()` and every RPC call
   verify — by both the tab's URL and a live in-page check — that they're talking to the account
   you actually selected, refusing to run rather than silently operating on the wrong one.

---

## Prerequisites

- **Node.js** (v18 or higher recommended)
- **Google Chrome** or Chromium — the app launches it itself with remote debugging enabled; you
  don't need to start it by hand
- **Google Pixel Phone** (Pixel 1 through Pixel 5 have the permanent free-backup exemption this
  tool relies on) with USB debugging enabled — only needed for the Trash + Reupload / Push /
  Cleanup Pixel steps; Scan, Match, and Verify work without a phone connected
- **ADB**: bundled in `adb/` for Windows, or installed via your system package manager on
  Linux/macOS (e.g. `sudo apt install adb`)

---

## Quick Start

### 1. Install dependencies & start the server

**Linux / macOS:**
```bash
chmod +x start.sh
./start.sh
```
*Or manually:*
```bash
cd source
npm install
node server.mjs
```

**Windows:**
Double-click `Google Photos Quota Reclaim.bat`, or run:
```cmd
cd source
npm install
node server.mjs
```

The server opens its own app window automatically; if it doesn't, open your browser to
`http://localhost:8080`.

### 2. Launch Chrome from the UI

Click **Launch Chrome**. The app starts Chrome with remote debugging enabled on a dedicated,
isolated profile, then automatically opens one confirmed tab per Google account already signed
into that profile. Sign in to any additional Google account(s) you want the app to see, then click
**Launch Chrome** again to pick them up too. The CDP badge turns green once connected; if it turns
amber, the account switcher's pinned account doesn't match the connected tab — pick one and
continue.

### 3. Connect your Google Pixel (only needed for Trash + Reupload / Push / Cleanup)

1. Enable **Developer Options** and turn on **USB Debugging** on your Pixel.
2. Connect it via USB and allow USB debugging when prompted.

### 4. Work through the pipeline

Select albums (or toggle Scan All Library) → Scan → Match/Download → Trash + Reupload (or the
non-destructive Push) → Verify → Restore → Cleanup Pixel. Every step's status line explains what
it's waiting on; the log panel streams progress for whichever step is currently running.

---

## Prebuilt Packages

Instead of running from source, you can build a native package for your platform.
Each is self-contained (bundles its own Node.js runtime except the `.deb`, which
uses `apt` dependencies instead) and reproducible via its own `build.sh`:

| Platform | Format | Build |
|---|---|---|
| Windows | `.exe` installer (NSIS) | [`installer/`](installer/) |
| Debian / Ubuntu | `.deb` package | [`deb/`](deb/) |
| Linux (any x86_64 distro) | `.AppImage` (portable, no install) | [`appimage/`](appimage/) |
| macOS (Apple Silicon & Intel) | `.app` bundle, zipped | [`mac/`](mac/) |

Each directory's `README.md` documents build requirements and layout; a step-by-step
account of how each was built lives in `Windows EXE Readme.md`, `Linux DEB Readme.md`,
`Linux AppImage Readme.md`, and `Mac App Readme.md` at the repo root. The macOS build
is packaged from Linux and is unsigned — see `mac/README.md` for the Gatekeeper
workaround needed on first launch.

### Reproducibility — confirmed

Every `build/` and `dist/` directory was wiped (simulating a completely fresh clone
with no cached downloads) and all four `build.sh` scripts were rerun from scratch, in
parallel:

| Build | Result | Output |
|---|---|---|
| `installer/build.sh` | exit 0 | `GPhotoStorageSaver-Setup.exe` (28 MB) |
| `deb/build.sh` | exit 0 | `gphoto-storage-saver_1.0.0_all.deb` (92 KB) |
| `appimage/build.sh` | exit 0 | `GPhotoStorageSaver-x86_64.AppImage` (44 MB) |
| `mac/build.sh` | exit 0 | `GPhotoStorageSaver-mac-{arm64,x64}.zip` (46/47 MB) |

Each rebuilt cleanly using only what's declared in its own README's "Requires" line —
nothing depended on leftover state from a prior build.

### Consistency checks

- Version `1.0.0` matches across the exe registry entry, deb control file, and mac
  `Info.plist`.
- App display name "Google Photos Quota Reclaim" matches across all four.
- Bundled Node.js version (`v24.21.0`) matches across the exe, AppImage, and mac builds
  — the three that bundle a runtime.
- `.gitignore` uses one consistent `<dir>/build/` + `<dir>/dist/` pair per platform.
- A full-repo `git add -n` dry run confirms only source scripts/config would ever be
  staged — no binaries, no build output, across all four directories.

---

## Documentation

Detailed documentation is available in the [`source/docs/`](source/docs/) directory:
- [Architecture & Design](source/docs/architecture.md)
- [API Reference](source/docs/api-reference.md)
- [CDP & RPC Layer](source/docs/cdp-rpc.md)
- [Operations Guide](source/docs/operations.md)
- [Frontend Structure](source/docs/frontend.md)
- [Function Reference — every function, documented, with improvement notes](source/docs/function-reference.md)
- [Dead Code Audit](source/docs/dead-code-audit.md)

---

## Disclaimer

The **Trash + Reupload** step is destructive and irreversible: it deletes items from the cloud
before the Pixel has finished re-uploading them. Ensure you have reliable offline backups of your
media before running it. If you'd rather avoid the destructive path entirely, use **Push**
instead — it copies files to the Pixel without ever touching the cloud originals.
