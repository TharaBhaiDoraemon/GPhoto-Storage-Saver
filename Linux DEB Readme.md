# Linux DEB Readme

Steps taken to build a `.deb` package for this project (Debian/Ubuntu).

## 1. Checked what tooling was available

- `dpkg-deb` and `dpkg-scanpackages` — already installed (part of base
  Debian/Ubuntu tooling), so no `sudo`/package install was needed this time
- `lintian` — not installed, but not required to build a `.deb`, only to lint
  it against full Debian archive policy
- Confirmed the real Debian/Ubuntu package names: `nodejs` (already
  installed, v18.19.1) and `adb` (provides the Android Debug Bridge command)

## 2. Decided the dependency strategy (different from the Windows build)

Unlike the Windows `.exe`, this package does **not** bundle a Node.js
runtime or `adb` binaries. On Debian/Ubuntu those are ordinary `apt`
packages, so the `.deb` just declares them as dependencies
(`Depends: nodejs (>= 18), adb`) and lets `apt`/`dpkg` install them
automatically — this is standard Debian packaging practice, versus the
Windows approach where bundling made sense because there's no system
package manager to lean on.

## 3. Worked out where the app's writable state should live

Read `source/lib/config.mjs` again: `WORK_DIR` (which `downloads/` and
`manifest.json` live under) has an environment-variable override
(`process.env.WORK_DIR`), so the launcher script can point it at the user's
own home directory instead of the read-only `/usr/lib` install location —
avoiding permission problems and keeping user data out of system
directories.

## 4. Chose the on-disk package layout

- `/usr/lib/gphoto-storage-saver/` — app code (`api/`, `lib/`, `steps/`,
  `index.html`, `server.mjs`, `package.json`) plus its production
  `node_modules` (just `ws`, pure JS, no native bindings — safe to package
  as `Architecture: all`)
- `/usr/bin/gphoto-storage-saver` — a shell launcher script that creates
  `~/.local/share/gphoto-storage-saver/downloads`, exports `WORK_DIR` to
  point there, `cd`s into the app dir, and execs `node server.mjs`
- `/usr/share/applications/gphoto-storage-saver.desktop` — app menu entry
  (`Terminal=true` so log output stays visible, matching how the Windows
  shortcut keeps a console window open)
- `/usr/share/doc/gphoto-storage-saver/` — `README.md`, `copyright`, and a
  gzipped `changelog.Debian.gz`, per Debian doc policy

## 5. Wrote the Debian control file (`deb/control`)

- `Package: gphoto-storage-saver`, `Architecture: all`
- `Depends: nodejs (>= 18), adb`
- `Recommends:` a Chrome/Chromium browser (needed to actually use the app,
  but not force-installed since browser packaging varies by distro)
- `Maintainer`, `Homepage` (pulled from the actual `git remote -v` URL
  rather than a placeholder), and a `Description` summarizing the app and
  flagging the destructive Trash+Reupload step

## 6. Wrote the launcher script, desktop entry, copyright, and changelog

Small supporting files under `deb/`: `gphoto-storage-saver` (launcher),
`gphoto-storage-saver.desktop`, `copyright`, `changelog`.

## 7. Wrote `deb/build.sh`

Stages a clean package tree under `deb/build/`, copies in the app source,
runs `npm install --omit=dev --omit=optional` for just `ws`, installs the
launcher/desktop/doc files with correct permissions, computes
`Installed-Size` from the staged tree's actual size, assembles
`DEBIAN/control`, and runs:

```bash
dpkg-deb --root-owner-group --build "$PKG_ROOT" "$DIST_DIR/gphoto-storage-saver_1.0.0_all.deb"
```

`--root-owner-group` fakes root:root ownership inside the archive without
needing actual root/`sudo` on the build machine.

## 8. Built and verified

Ran `./build.sh`, then checked the result with `dpkg-deb --info` and
`dpkg-deb --contents` to confirm: correct metadata/dependencies, the
launcher script landed executable at `/usr/bin/`, the desktop entry and docs
were present, and `file` reported it as a valid Debian binary package.

## 9. Wrote `deb/README.md`

Documents the package layout, how to build it, and how to install/run/
remove it (`sudo apt install ./gphoto-storage-saver_1.0.0_all.deb`,
`gphoto-storage-saver`, `sudo apt remove gphoto-storage-saver`).

## 10. Cleaned up git hygiene

- Added `deb/build/` and `deb/dist/` to `.gitignore`, mirroring the
  Windows installer's `installer/build/` and `installer/dist/`
- Verified only the small source files (`control`, `gphoto-storage-saver`,
  `gphoto-storage-saver.desktop`, `copyright`, `changelog`, `build.sh`,
  `README.md`) would be staged in git — no build output
- Did not commit anything, since it wasn't requested

## Result

Final output: `deb/dist/gphoto-storage-saver_1.0.0_all.deb`, rebuildable via:

```bash
cd deb && ./build.sh
```
