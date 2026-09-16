# macOS App Bundle

Builds `GPhotoStorageSaver-mac-arm64.zip` and `GPhotoStorageSaver-mac-x64.zip`,
each containing a self-contained `GPhotoStorageSaver.app` for macOS (Apple
Silicon and Intel respectively).

Like the Windows `.exe` and the Linux AppImage, this bundles its own Node.js
runtime and `adb` binary, so the only thing still expected on the target Mac
is Google Chrome/Chromium. Node.js has no single "universal" download from
nodejs.org, so there are two separate `.app` builds, one per CPU
architecture; Google's macOS `adb` is already a universal binary and is
shared by both.

**This is built and packaged from Linux and has not been run on real macOS.**
The bundle structure, `Info.plist`, and binary architectures have all been
verified by inspection (`file`, permission round-trip through the zip), but
actually launching it should be tested on a real Mac before relying on it.

## Layout inside the .app

- `Contents/Info.plist` — bundle metadata
- `Contents/MacOS/GPhotoStorageSaver` — the launcher script (`CFBundleExecutable`);
  sets `WORK_DIR` to `~/Library/Application Support/GPhotoStorageSaver` (so
  `downloads/` and `manifest.json` live in the user's home directory, not
  inside the read-only bundle) and execs the bundled `node`
- `Contents/MacOS/node` — portable Node.js runtime (arch-specific)
- `Contents/MacOS/adb` — Android Debug Bridge (universal binary); the
  launcher prepends `Contents/MacOS` to `PATH` so `source/lib/adb.mjs`'s
  existing `which adb` PATH-fallback picks it up with no code changes
- `Contents/Resources/app/` — app code + `node_modules` (just `ws`, pure JS,
  no native bindings)
- `Contents/Resources/gphoto-storage-saver.icns` — icon, generated from the
  shared `../assets/icon.png`

## Build

From any machine (Linux, macOS, or Windows/WSL) with `node`, `npm`,
`python3` (with Pillow: `pip install pillow`), `curl`, `unzip`, `tar`, and
`zip` on PATH:

```bash
./build.sh
```

Output: `mac/dist/GPhotoStorageSaver-mac-arm64.zip` and
`mac/dist/GPhotoStorageSaver-mac-x64.zip`.

## Install / run on macOS

1. Unzip and drag `GPhotoStorageSaver.app` to `/Applications` (or run it in
   place).
2. **The app is unsigned** (no Apple Developer certificate was used, and
   none is available in this build environment). macOS Gatekeeper will
   refuse to open it with a plain double-click the first time. Instead:
   - Right-click (or Control-click) the app → **Open** → confirm **Open** in
     the dialog, **or**
   - Run once from Terminal: `xattr -cr /path/to/GPhotoStorageSaver.app`
     to clear the quarantine flag, then open normally.
3. Launching from Finder hides console output (standard for GUI-launched
   apps); the app opens its own browser window regardless. To see log
   output, run the executable directly instead:
   `./GPhotoStorageSaver.app/Contents/MacOS/GPhotoStorageSaver`

## Files

- `Launcher` — the `Contents/MacOS/GPhotoStorageSaver` script (entry point)
- `Info.plist` — bundle metadata template
- `make_icns.py` — converts `../assets/icon.png` to `.icns` using Pillow
  (avoids needing macOS's `iconutil`, which isn't available on Linux)
- `build.sh` — stages app code once, then assembles one `.app` per
  architecture and zips each
- `build/`, `dist/` — generated, gitignored; safe to delete and rebuild

## Notes

- Bump `NODE_VERSION` in `build.sh` when updating the bundled Node.js.
- No `.dmg` is produced — building a real macOS disk image requires
  `hdiutil`, which only exists on macOS itself. A plain `.zip` of the `.app`
  is the standard cross-platform-buildable alternative; if you have access
  to a Mac and want a `.dmg`, unzip the app there and run:
  `hdiutil create -volname "Google Photos Quota Reclaim" -srcfolder GPhotoStorageSaver.app -ov -format UDZO GPhotoStorageSaver.dmg`
- Code signing / notarization requires an Apple Developer account and
  Apple's own tools; neither is available in this build environment, hence
  the Gatekeeper workaround above.
