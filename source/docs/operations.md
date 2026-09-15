# Operations

Each operation follows the same pattern:
1. Call `opStart(name)` → sets `currentOp`, broadcasts SSE
2. Open a fresh CDP session
3. Do work, call `log()` throughout
4. Write manifest to disk
5. Call `opEnd(name, ok, summary)` → clears `currentOp`, broadcasts SSE + updated stats
6. Close CDP in `finally`

---

## opScan({ albumIds? })

**Purpose:** Enumerate library (or specific albums) and add quota-consuming items to manifest.

**Steps:**
1. `enumerateAll()` with `lcxiM` RPC — collects `[mediaKey, dedupKey]` pairs for every item
2. `batchQuotaInfo()` with `EWgK9e` RPC — gets filename, size, quota status
3. Filters for `lastArr[0] === 1` (takes up space)
4. Deduplicates against existing manifest by `mediaKey`
5. Appends new items to manifest

**Key behaviour:** dedupKey is extracted from `lcxiM` results (position `[3]`), so items scanned via this function don't need a separate enrich step.

**When to use:** First step of any workflow. Re-run anytime to pick up new quota-consuming uploads.

---

## opDownload({ concurrency? })

**Purpose:** Fetch quota-consuming items directly from Google Photos into `downloads/`, as an alternative to the manual Takeout + `GooglePhotosTakeoutHelper Neo` workflow. Sets `downloaded`/`downloadedAs` the same way `opMatch`/`opMatchAlbums` do, so downstream steps don't care which path was used.

**Steps:**
1. Filters manifest for `consumesQuota && !downloaded`
2. `Network.getCookies` (CDP) for `photos.google.com` / `video-downloads.googleusercontent.com` — the actual file GET is a plain Node `fetch`, not routed through the browser like the batchexecute RPCs
3. Per item: `pLFTfd` RPC → signed download URL → `fetch()` → streamed to `downloads/<filename>`
4. Sets `downloaded=true`, `downloadedAs`, `downloadedBytes`, `downloadedAt`
5. Filenames disambiguated with a `_<mediaKey suffix>` when two items share the same `filename`

**Trade-off vs. Takeout:** faster and no manual step, but the downloaded file won't carry the EXIF/GPS metadata that `GooglePhotosTakeoutHelper Neo` restores from Takeout's sidecar JSON. Use Takeout first if you need that metadata preserved.

---

## opEnrich()

**Purpose:** Fill in `dedupKey` for manifest items that are missing it.

This is only needed for items added by an older version of the scan script, or for items found in the archive (mode 2) which weren't scanned through `opScan`.

**Steps:**
1. Find manifest items where `dedupKey` is falsy
2. Paginate `lcxiM` mode 1 (library)
3. For each page, match `item[0]` (mediaKey) → `item[3]` (dedupKey)
4. Stop early once all targets are found

**Limitation:** Items in the Google Photos archive won't be found — they require mode 2. The log will say "X not found (may be archived)."

---

## opSaveAlbums()

**Purpose:** Record which albums each manifest item belongs to, before the destructive trash step.

**Steps:**
1. `listAllAlbums()` via `F2A0H` RPC
2. For each album: `enumerateAll()` with `albumId` via `lcxiM`
3. Cross-reference returned mediaKeys against manifest
4. Writes `item.albums = [{ albumId, albumTitle }]` per item

**Must run before `opTrashReupload`** — after deletion the original album membership is gone from Google's side.

---

## opTrashReupload({ mediaKeys?, saveAlbumsFirst? })

**Purpose:** The destructive core step. Trashes items from Google Photos and pushes local files to Pixel via ADB.

**Safety checks (pre-flight):**
- ADB device must be connected
- All target items must have `downloaded=true` and `downloadedAs` pointing to an existing file
- All target items must have `dedupKey`

**Steps:**
1. If `saveAlbumsFirst=true` (default): runs inline album save for items missing `albums`
2. Processes in batches of 10:
   - Trash via `XwAOJf` RPC (uses `dedupKey`, not `mediaKey`)
   - `adb push` to `/sdcard/DCIM/Camera/<safeName>`
   - `adb shell content insert` for MediaStore (non-fatal if fails)
   - Marks `reuploadComplete=true` only if **both** trash and push succeed
3. Saves manifest after each batch
4. Restarts Google Photos app on Pixel to trigger backup

**Filter behaviour:** If `mediaKeys` array is provided, only those items are processed. Otherwise, all `consumesQuota && downloaded && dedupKey && !reuploadComplete` items.

**Critical:** An item is never marked complete if only trash succeeded but push failed — that would mean the photo is deleted with no local copy pushed. The `trashError` field records failures.

---

## opPush({ concurrency? })

**Purpose:** Non-destructive counterpart to `opTrashReupload` — pushes downloaded files to the device via ADB without touching the cloud copy at all (no trash, no deletion). Useful for getting files onto the device (e.g. so a second Google account signed into the Pixel backs them up) while keeping the originals in the first account.

**Filter behaviour:** `downloaded && downloadedAs && !trashedAt && !reuploadComplete && !pushedOnly` — items already handled by `opTrashReupload`/`opRepush` or already pushed by this op are skipped.

**Steps:** `adb push` + MediaStore insert (shared `pushPhotoToPixel()` helper with `opTrashReupload`), then restarts Google Photos on the Pixel. Marks `pushedOnly=true`, `pushedOnlyAt` on success — never sets `reuploadComplete` or `trashedAt`.

---

## opVerify()

**Purpose:** Confirm that items are quota-free in whichever Google account is currently connected via CDP, and record their new mediaKey.

**When to run:** Normally 1–4 hours after `opTrashReupload`, once the Pixel has finished backing up. Can also be run standalone as a cross-account presence check — scan account A (`opScanFull` with "Scan all library"), switch Chrome to account B (`/api/switch-account`), then verify — since it targets every `consumesQuota` item, not only ones this tool trashed.

**Steps:**
1. Builds a map of `filename.toLowerCase() → manifest item` for every `consumesQuota` item not yet `verified===true`
2. Paginates the library with `lcxiM`
3. For each page, calls `batchQuotaInfo()` (EWgK9e)
4. Matches by filename (uses `pushedAs` field first, falls back to `filename`), with a dedupKey fallback
5. Success: `lastArr[0]` is falsy (no space) AND `lastArr[2] === 2` (original quality)
6. Sets `verified=true`, `newMediaKey`, `verifiedAt` on success

**Why match by filename, not mediaKey?** After trash+reupload (or after the same file lands in a different account), the photo has a new mediaKey assigned by Google. The old mediaKey from the manifest no longer exists there.

---

## opResetVerify()

**Purpose:** Clear `verified` / `verifiedAt` / `verifyNote` / `newMediaKey` on every manifest item so `opVerify` can be re-run cleanly — e.g. after verifying against the wrong account, or to re-check against a second account.

**Steps:** Deletes those four fields from each manifest item that has any of them set, writes the manifest, reports how many items were reset.

---

## opRestoreAlbums()

**Purpose:** Re-add verified photos to their original albums using their new mediaKeys.

**Requirements:** `item.verified=true`, `item.newMediaKey`, `item.albums` (saved before trash)

**Steps:**
1. Groups items by `albumId`
2. For each album: calls `zy2MWb` RPC in batches of 50 `newMediaKey`s
3. Sets `albumsRestored=true` per item

---

## opCleanupPixel()

**Purpose:** Remove pushed files from the Pixel's camera roll after backup is confirmed.

Runs `adb shell rm -f /sdcard/DCIM/Camera/*` (`-f` so an already-empty folder isn't treated as an error). Fails cleanly if ADB is not connected.

Run this **after** `opVerify` confirms quota recovery.

---

## opMatchAlbums({ albumIds })

**Purpose:** Album-specific workflow entry point. Finds which photos in the selected albums have matching files in `downloads/` and registers them in the manifest.

**Steps:**
1. Reads `downloads/` directory → builds a case-insensitive filename → path map
2. For each albumId: `enumerateAll()` with `albumId`
3. `batchQuotaInfo()` to get filenames (lcxiM doesn't return filenames)
4. Matches `filename.toLowerCase()` against the downloads map
5. New items are added to manifest with `downloaded=true`, `downloadedAs` set
6. Existing items get `downloadedAs` filled in if it was missing
7. `dedupKey` is extracted from lcxiM results — no separate enrich step needed

**After this runs**, items are ready for `opTrashReupload` with the `mediaKeys` filter.

---

## opSwitchAccount(path)

Navigates the Google Photos CDP tab to `https://photos.google.com{path}` (e.g. `/u/1/`) and waits 3 seconds for the page to load. Reads the new tokens to confirm the switch.

---

## opOpenAccountTabs()

**Purpose:** Right after Chrome launches, discover every signed-in Google account and get each one its own confirmed tab — instead of leaving the user on a single bare `photos.google.com` tab that only reflects whichever account Chrome/Google happens to land on.

**Steps:**
1. Poll `GET /json` on the debug port (up to 15s) until Chrome is actually listening — `launchChrome()` returns the moment the process is spawned, well before the port is up.
2. Snapshot every currently-open Photos tab (the launch-chrome bootstrap tab, plus any left over from a previous run) — these get closed at the very end, never before.
3. For `n = 0, 1, 2, ...` (capped at 6 — Google indexes accounts contiguously from 0, so the first gap ends the loop): open a new tab at `https://photos.google.com/u/{n}/` via Chrome's `/json/new` HTTP endpoint, wait 3s, then verify it two ways:
   - `location.href` equals the exact requested URL (not just "some `/u/n/`-looking" URL — an in-app error/sign-in page can leave the address bar untouched, so this alone doesn't prove the account exists)
   - `window.WIZ_global_data` is present (proves an actual Photos session loaded, not an error page)

   A tab that fails either check is closed immediately and the loop stops (no account beyond that index is probed).
4. Close every tab from the step-2 snapshot that isn't one of the newly-confirmed tabs.

**Why two checks, not just the URL:** Google can serve a sign-in/interstitial page at the requested path without ever changing `location.href` — checking the URL alone would treat a nonexistent account as valid.

---

## Chrome management functions

### launchChrome()

Finds Chrome at standard Windows install paths (or `CHROME_PATH` env var), spawns it with:
- `--remote-debugging-port=9222`
- `--user-data-dir=<CHROME_PROFILE_DIR>`
- Opens `https://photos.google.com`

Uses `spawn(..., { detached: true, stdio: 'ignore' }).unref()` so the Chrome process outlives the Node server.

### deleteProfile()

Calls `fs.rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true })`. Chrome must be closed or the deletion will partially fail on Windows (locked files).

### findChrome()

Checks `CHROME_PATH` env var first, then probes standard paths:
- `C:\Program Files\Google\Chrome\Application\chrome.exe`
- `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`
