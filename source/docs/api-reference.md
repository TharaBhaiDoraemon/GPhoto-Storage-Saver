# API Reference

Base URL: `http://localhost:8080`

All POST bodies are JSON. All responses are JSON. Operations that run long-term return `{ ok: true, queued: "name" }` immediately and stream progress via SSE.

---

## GET /api/events

Server-Sent Events stream. Connect once; stays open.

**Event types:**

| `type`         | Payload fields                              | When                              |
|----------------|---------------------------------------------|-----------------------------------|
| `log`          | `text: string`, `level: info|success|warn|error` | Any log line from an operation |
| `stats`        | `stats: ManifestStats`                      | After each operation completes    |
| `opStart`      | `name: string`                              | Operation begins                  |
| `opEnd`        | `name: string`, `ok: boolean`, `summary: string` | Operation finishes           |

`ManifestStats`: `{ total, quota, downloaded, enriched, albumsSaved, trashed, verified, restored }`

---

## GET /api/status

Current state snapshot.

```jsonc
{
  "cdpConnected": true,
  "account": "/u/0/",           // current Google Photos account path, null if not connected
  "photosTabs": [{ "url": "...", "title": "..." }],
  "manifest": ManifestStats,
  "currentOp": null,            // string name of running operation, or null
  "adbConnected": true,
  "workDir": "C:\\...\\project",
  "downloadsDir": "C:\\...\\project\\downloads",
  "downloadCount": 215
}
```

---

## GET /api/albums

Fetches all albums from Google Photos. Requires CDP connection.

```jsonc
{
  "albums": [
    { "albumId": "AF1Q...", "title": "Vacation 2023", "count": 142 }
  ]
}
```

---

## GET /api/manifest

Full manifest array plus stats.

```jsonc
{ "manifest": [...], "stats": ManifestStats }
```

---

## GET /api/chrome-info

Returns info about the temporary Chrome profile directory.

```jsonc
{ "profileDir": "C:\\...\\Temp\\Chrome-GPhotos-CDP", "exists": true, "sizeMb": 48 }
```

---

## POST /api/scan

Find quota-consuming items. If `albumIds` provided, only scans those albums.

**Body:** `{ "albumIds"?: string[] }`

Runs: `opScan`

---

## POST /api/download

Download quota-consuming items directly into `downloads/`, bypassing the manual Takeout + GooglePhotosTakeoutHelper Neo workflow. Skips items that already have `downloaded=true`.

**Body:** `{ "concurrency"?: number, "mediaKeys"?: string[] }` (concurrency default 3, capped at 6). When `mediaKeys` is given, only those items are considered — e.g. the unverified-items viewer's "Download" button scopes to exactly the rows currently shown/filtered there.

Runs: `opDownload`

---

## POST /api/enrich

Fill in missing `dedupKey` values by re-enumerating the library.

**Body:** `{}`

Runs: `opEnrich`

---

## POST /api/save-albums

Save album membership for all manifest items. Must run before trash.

**Body:** `{}`

Runs: `opSaveAlbums`

---

## POST /api/trash-reupload

Trash items from Google Photos and push to Pixel via ADB. Optionally saves album memberships first.

**Body:**
```jsonc
{
  "saveAlbumsFirst": true,      // default true — save albums before trashing
  "mediaKeys"?: string[]        // if provided, only process these specific items
}
```

Runs: `opTrashReupload`

---

## POST /api/push

Push downloaded items to the device via ADB only — no cloud trash, no deletion. Skips items already handled by `/api/trash-reupload` (`trashedAt`/`reuploadComplete`) or already pushed by this endpoint (`pushedOnly`). Marks pushed items `pushedOnly=true`, `pushedOnlyAt`.

**Body:** `{ "concurrency"?: number }` (default 3, capped at 10)

Runs: `opPush`

---

## POST /api/verify

Confirm items are now quota-free in whichever Google account is currently connected via CDP. Matches every manifest item with `consumesQuota=true` (not just ones this tool trashed+reuploaded) by filename/dedupKey against the connected account's library — so it also works as a plain cross-account presence check: scan account A (see `/api/scan-full`), switch to account B with `/api/switch-account`, then verify.

Normally run 1–4 hours after `opTrashReupload`, once the Pixel has finished backing up.

**Body:** `{}`

Runs: `opVerify`

---

## POST /api/reset-verify

Clear `verified` / `verifiedAt` / `verifyNote` / `newMediaKey` on every manifest item so `/api/verify` can be re-run from scratch (e.g. to re-check against a different account after switching). Does not touch scan/download/trash state.

**Body:** `{}`

Runs: `opResetVerify`

---

## POST /api/restore-albums

Re-add items to their original albums using `newMediaKey`.

**Body:** `{}`

Runs: `opRestoreAlbums`

---

## POST /api/cleanup-pixel

Remove pushed files from `/sdcard/DCIM/Camera/*` via ADB.

**Body:** `{}`

Runs: `opCleanupPixel`

---

## POST /api/match

Enumerate selected albums, check quota, match filenames against `downloads/` directory, add matched items to manifest with `downloaded=true`.

**Body:** `{ "albumIds": string[] }` — required

Runs: `opMatchAlbums`

---

## POST /api/switch-account

Navigate the Google Photos tab to a different account path (`/u/0/`, `/u/1/`, …), then **pins** that account: once the switch is confirmed (`getTokens()` reads back the new account's own `eptZe` global), every subsequent operation refuses to run unless it's connected to exactly that account. This closes the multi-tab ambiguity gap — `connectCdp()` will only pick a tab whose URL matches the pinned account (erroring if none do), and `getTokens()` double-checks the live page's own account global as a second, authoritative layer. `GET /api/status` exposes the pin as `selectedAccount`, and `accountMismatch: true` if the currently-detected tab no longer matches it.

**Body:** `{ "path": "/u/1/" }`

---

## POST /api/launch-chrome

Launch Chrome with `--remote-debugging-port=9222` and the temp profile, opened to bare `https://photos.google.com` (a bootstrap tab). The frontend immediately follows this with `/api/open-account-tabs`.

```jsonc
{ "ok": true, "profileDir": "C:\\...\\Temp\\Chrome-GPhotos-CDP" }
```

---

## POST /api/open-account-tabs

Waits for Chrome's debug port to come up, then probes `https://photos.google.com/u/0/`, `/u/1/`, `/u/2/`, … in new tabs (via Chrome's `/json/new` HTTP endpoint) until one isn't actually signed in — Google accounts are indexed contiguously from 0, so the first gap ends the probe. Each candidate tab is verified two ways before being kept: `location.href` must equal the exact requested URL (an in-app error/sign-in page can leave the address bar unchanged, so URL-matching alone isn't enough), and `window.WIZ_global_data` must be present (a real, loaded Photos session). Tabs that fail either check are closed immediately. Once all confirmed account tabs are open, every Photos tab that existed *before* this run (the launch-chrome bootstrap tab, leftovers from a previous run) is closed — but never a tab this run just opened itself.

**Body:** `{}`

Runs: `opOpenAccountTabs`

```jsonc
{ "ok": true, "accounts": ["https://photos.google.com/u/0/", "https://photos.google.com/u/1/"] }
```

---

## POST /api/delete-profile

Delete the temp Chrome profile directory. Chrome must be closed first.

```jsonc
{ "ok": true, "deleted": "C:\\...\\Temp\\Chrome-GPhotos-CDP" }
// or if it didn't exist:
{ "ok": true, "note": "Profile directory does not exist" }
```

---

## Error responses

`409 Conflict` — another operation is running:
```jsonc
{ "error": "Operation 'scan' is running", "busy": true }
```

`500 Internal Server Error`:
```jsonc
{ "error": "No Google Photos tab found. Open photos.google.com in Chrome with --remote-debugging-port=9222" }
```
