# Debian/Ubuntu Package

Builds `gphoto-storage-saver_1.0.0_all.deb`, a `.deb` package for Google
Photos Quota Reclaim.

Unlike the Windows installer, this package does **not** bundle a Node.js
runtime or `adb` binaries — on Debian/Ubuntu those are just `apt`
dependencies (`nodejs`, `adb`), which the package declares in `Depends:`
so `apt`/`dpkg` will pull them in automatically. Google Chrome/Chromium is
listed as a `Recommends:` since it's required to actually use the app but
isn't packaged in Debian's own repos the same way across distros.

## Layout installed

- `/usr/lib/gphoto-storage-saver/` — app code + `node_modules` (just `ws`,
  pure JS, no native bindings)
- `/usr/bin/gphoto-storage-saver` — launcher script; sets `WORK_DIR` to
  `~/.local/share/gphoto-storage-saver` (so `downloads/` and `manifest.json`
  live in the user's own home directory, not under `/usr`) and execs `node`
- `/usr/share/applications/gphoto-storage-saver.desktop` — app menu entry
- `/usr/share/doc/gphoto-storage-saver/` — README, copyright, changelog

## Build

From a Debian/Ubuntu machine (or any Linux with `dpkg-deb`), with `node` and
`npm` on PATH:

```bash
./build.sh
```

No `sudo`/root needed — `dpkg-deb --root-owner-group` fakes root ownership
in the archive without requiring it on the build machine.

Output: `deb/dist/gphoto-storage-saver_1.0.0_all.deb`.

## Install / run / uninstall

```bash
sudo apt install ./dist/gphoto-storage-saver_1.0.0_all.deb   # installs + pulls in nodejs, adb
gphoto-storage-saver                                          # or launch from the app menu
sudo apt remove gphoto-storage-saver                          # uninstall (keeps ~/.local/share data)
```

## Files

- `control` — Debian control file (package metadata, dependencies)
- `gphoto-storage-saver` — the `/usr/bin` launcher wrapper script
- `gphoto-storage-saver.desktop` — app menu entry
- `copyright`, `changelog` — Debian doc policy files
- `build.sh` — stages app + deps + metadata, then runs `dpkg-deb --build`
- `build/`, `dist/` — generated, gitignored; safe to delete and rebuild

## Notes

- Bump `VERSION` in `build.sh` and `Version:` in `control` together when
  releasing an update.
- `Installed-Size` in the control file is computed automatically from the
  staged tree at build time.
