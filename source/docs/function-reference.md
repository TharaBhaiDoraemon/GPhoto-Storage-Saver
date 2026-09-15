# Function reference & improvement notes

Every function in this codebase, file by file, with what it does and — where there's something
genuinely worth flagging — a concrete note on how it could be improved. This is a companion to
the other docs, not a replacement:

- [architecture.md](architecture.md) — the overall shape of the system, data lifecycle
- [api-reference.md](api-reference.md) — HTTP endpoints and their request/response shapes
- [operations.md](operations.md) — what each pipeline step does, step by step, semantically
- [cdp-rpc.md](cdp-rpc.md) — how the CDP/RPC layer talks to Google Photos
- [frontend.md](frontend.md) — frontend structure (i18n, SSE wiring, layout)
- [dead-code-audit.md](dead-code-audit.md) — what was checked/removed as unused (2026-09-14)

Read this doc when you need to know **what a specific function does and whether it's safe to
touch**. Read the others when you need the bigger picture first.

---

## Architectural notes (not tied to one function)

Things that would matter to whoever picks this project up next, that don't belong to any single
function below:

1. **No automated tests anywhere in this project.** Every change so far (including everything in
   this session) has been verified by `node --check` (syntax only) and manual reasoning about the
   code paths, never by running a test suite — because there isn't one. The riskiest code to leave
   untested is exactly the code most tempting to skip testing: `trashReuploadStep` (irreversible),
   the CDP/RPC layer (breaks silently and confusingly if Google changes response shapes), and the
   manifest filter conditions each step relies on (a wrong filter silently processes the wrong set
   of items). At minimum, the pure functions — `deduplicateItems`, `buildQuotaManifestEntries`,
   `manifestStats`, `normalizeAccountPath`, `buildFilenameToItemMap`, `applyQuotaInfo`,
   `computeViewerItems` (frontend) — are unit-testable with zero mocking and would catch real
   regressions cheaply.
2. **The server binds `0.0.0.0` with no authentication** (`server.mjs`). Anyone on the same
   network segment who can reach the port can trigger `trash-reupload` (irreversible deletion),
   `reset-all` (wipes the Chrome profile, manifest, and `downloads/`), or read `manifest.json`'s
   contents. This is fine for the intended "single user, single machine" use case but is worth a
   comment or a bind-to-`127.0.0.1`-by-default change if this is ever run on a shared machine or
   exposed past localhost.
3. **Hardcoded Google RPC IDs with no fallback.** `XwAOJf` (trash), `lcxiM` (library page),
   `EWgK9e` (batch quota), `snAcKc` (album page), `E1Cajb`/`laUYf` (album restore, personal/shared),
   `w7TP3c` (archive), `pLFTfd` (download URL) are magic strings scattered across `lib/rpc.mjs`,
   `steps/trashReuploadStep.mjs`, `steps/albumsStep.mjs`, and `steps/downloadStep.mjs`. If Google
   renames or reshapes any of these (they're obfuscated internal IDs, not a public API — this can
   happen without notice), the failure mode is a cryptic `RPC XwAOJf: empty response` or a parse
   error deep in a batch loop, not a clear "Google changed something." Centralizing them as named
   constants in one file (even just for the ID strings, e.g. `lib/rpcIds.mjs`) wouldn't prevent
   breakage but would make it far faster to find every call site when one does break.
4. **Retry strategy is inconsistent and ad hoc.** `batchQuotaInfo` retries twice, `fetchLibraryPage`
   (verify) retries four times with linear backoff, most other RPC calls don't retry at all. A
   single shared `withRetry(fn, { attempts, backoffMs })` helper in `lib/rpc.mjs` would make this
   a deliberate policy instead of copy-pasted judgment calls, and make it obvious which calls
   *don't* retry (and why).
5. **Timing constants are magic numbers repeated at call sites, not named.** The 3000ms
   post-navigate settle wait appears in `switchAccountStep` and `openAccountTabsStep` independently;
   `MAX_ACCOUNT_PROBE = 6` lives only in `miscSteps.mjs`; `tryGetAccountEmail`'s 3500ms timeout is
   inline. None of these are wrong, but a next person tuning one (e.g. slower network making 3s
   too short) has to know to search for the literal number rather than find one named export.
6. **`manifest.json` has no write-concurrency protection.** Every step does `readManifest()` →
   mutate in memory → `writeManifest()`, and several long-running steps (`verifyStep`,
   `trashReuploadStep`) write partway through a run to avoid losing progress on failure. Since
   `currentOp` already serializes operations to one-at-a-time, this is safe *in practice* — but
   it's an invariant enforced by discipline (every step must check/set `currentOp`) rather than
   by the storage layer itself. A step added later that forgets to go through `opStart`/`opEnd`
   (or a GET-triggered code path — see `resolveAllAccountEmails`, which runs on every `/api/status`
   poll *unblocked* by `currentOp`) could interleave writes.
7. **No persistence for `scanMode` or the pinned account across a page reload / server restart.**
   `scanMode` (frontend) and `selectedAccountPath` (backend, `lib/cdp.mjs`) both reset to their
   defaults on reload/restart. This is arguably intentional (start each session from a known-safe
   state), but if not, it's a one-line `localStorage`/on-disk persistence away from surviving a
   restart, and worth a deliberate decision either way rather than being incidental.

---

## `lib/config.mjs`

Pure constants, no functions. Everything else in the backend imports from here rather than reading
`process.env` or building paths directly — keep it that way; it's the one file that knows about
environment variables and directory layout.

**Improve:** `CHROME_PATHS` is a hardcoded list of install locations per OS. It's already got a
`CHROME_PATH` env var escape hatch (checked first in `findChrome()`), which covers the common case,
but the hardcoded paths will drift out of date as OS package managers change default install
locations (e.g. a future Flatpak/Snap path). Low priority since the fallback exists.

---

## `lib/sse.mjs`

The event bus: every operation's progress (`log`, `opStart`, `opEnd`) and the periodic `stats`
broadcast flow through here to every connected browser tab via Server-Sent Events.

### `requestStop()` / `isStopRequested()`
A single shared boolean flag. `requestStop()` sets it; `trashReuploadStep` and `downloadStep`'s
worker loops poll `isStopRequested()` between items and bail out cleanly. Nothing else currently
respects it (e.g. `verifyStep`'s page-fetch loop doesn't check it, so a "Stop" click during a long
verify run has no effect — only the trash/download workers actually stop).

**Improve:** the "Stop" button in the UI is only wired to `trash-reupload` (see
`index.html`'s `stopBtn.style.display = currentOp === 'trash-reupload' ? ... `), so this isn't a
current bug, just a latent inconsistency if Stop is ever exposed for other long-running ops
(verify, scan-full) without also adding `isStopRequested()` checks to their loops.

### `broadcast(type, payload)`
Writes one `data: {...}\n\n` SSE frame to every connected client in `sseClients`. Swallows write
errors per-client (a dead/disconnected client doesn't throw for the others).

### `localTimestamp()`
Formats `Date.now()` as `YYYY-MM-DD HH:MM:SS` in the server's local timezone, for the `[timestamp]`
prefix on every log line. Not exported — internal to `log()`.

### `log(msg, level)`
Prints to both the server console and every connected browser (via `broadcast('log', ...)`).
`level` is one of `info`/`success`/`warn`/`error`/`op`, used purely for the frontend's CSS class
(`log-${level}`) — the backend doesn't validate it, an unrecognized level just produces a
class name with no matching CSS rule (silently unstyled, not an error).

### `opStart(name)` / `opEnd(name, ok, summary)`
Set/clear the module-level `currentOp` busy flag (which every `POST /api/*` route checks to
return `409` if something's already running — see `api/router.mjs`'s `handle()`), and broadcast
`opStart`/`opEnd` SSE events so every tab's UI updates in sync. `opEnd` also re-broadcasts fresh
`stats` — this is *the* mechanism that keeps the frontend's stat cards in sync after any step
finishes, so every step must call it exactly once on every exit path (success, failure, and the
"nothing to do" early-return case) — this file has no automated check for that invariant; it's
enforced by every step file following the same `try { ... opEnd(true) } catch { opEnd(false) }`
shape by convention.

**Improve:** `currentOp` and `opStart`/`opEnd` assume exactly one operation at a time, checked only
by `POST` routes. `GET /api/status`'s `resolveAllAccountEmails()` call runs unconditionally, even
mid-operation — see the architectural note above.

---

## `lib/manifest.mjs`

The only file that touches `manifest.json` on disk. Every step reads the whole file, mutates
in-memory objects, and writes the whole file back — there's no incremental/streaming I/O, which is
fine at the current scale (a few thousand items → a manifest of a few MB) but would need
rethinking if this ever needs to track tens of thousands of items.

### `readManifest()`
Returns `[]` if the file doesn't exist *or* fails to parse (corrupt JSON) — the corrupt case is
silently swallowed, not logged. If `manifest.json` is ever partially written (e.g. the process is
killed mid-`writeManifest`), the next read silently returns an empty manifest and every step
behaves as if nothing has ever been scanned, with zero indication that data was lost versus
genuinely starting fresh.

**Improve:** `writeManifest` isn't atomic (see below) which makes this failure mode more likely
than it needs to be; and even independent of that, logging a warning here ("manifest.json exists
but failed to parse, ignoring") rather than a silent `catch {}` would save real debugging time the
first time this happens to someone.

### `writeManifest(data)`
Writes the manifest as pretty-printed JSON via a single `fs.writeFileSync`. Not atomic — a crash
or power loss mid-write can leave a truncated/corrupt file, which `readManifest()` will then
silently treat as "empty" (see above).

**Improve:** write to a temp file (`manifest.json.tmp`) and `fs.renameSync` over the real path.
Rename is atomic on the same filesystem, so a reader never observes a partially-written file. This
is a small, self-contained, low-risk change — worth doing given how often this function is called
(every step calls it, several call it multiple times per run to checkpoint progress).

### `manifestStats(manifest)`
Computes every count shown in the UI's stat cards (`total`, `quota`, `downloaded`, `enriched`,
`albumsSaved`, `trashed`, `trashedCount`, `pendingRepush`, `verified`, `restored`) by filtering the
whole array once per field — so O(9n) per call. Called on nearly every state change (`opEnd`,
every SSE `stats` broadcast, every `/api/status` and `/api/manifest` response).

**Improve:** at current scale (thousands of items) this is unmeasurably fast and not worth
touching. If the manifest ever grows to tens of thousands of items and this starts showing up in
profiling, a single pass building all counts in one loop (instead of 9 separate `.filter().length`
passes) would cut the constant factor by ~9x — but this is premature optimization until there's
evidence it matters.

---

## `lib/adb.mjs`

Everything that shells out to the `adb` binary. No function here talks to Google or CDP.

### `getAdbPath()`
Resolves the adb binary: bundled path first (`ADB_PATH`, i.e. `<project>/adb/adb[.exe]`), then
`PATH` (via `which`/`where`), then throws with an OS-appropriate install hint. Called by every
other function in this file (not cached — re-resolves on every single `adb`/`adbAsync`/`adbPush`
call).

**Improve:** re-running `which`/`where` (a subprocess spawn) on every single ADB command is wasteful
— it's cheap in absolute terms but happens dozens of times during a single `trash-reupload` run
(once per pushed file). Caching the resolved path in a module-level variable after the first
successful resolution would remove that overhead with no behavior change (the bundled-path check
is a cheap `fs.existsSync` and would still run first, so a newly-added bundled binary would still
be picked up on next server start).

### `hasAdbBinary()`
`true`/`false` wrapper around `getAdbPath()` — swallows the "not found" error into a boolean, used
by `/api/status`'s `adbBinaryFound` field to distinguish "no device" from "no adb binary at all" in
the UI.

### `serialPrefix(serial)` *(not exported)*
Builds the `-s "<serial>" ` CLI prefix for targeting a specific device when more than one is
connected. Returns `''` when `serial` is falsy (single-device / unspecified case).

### `adb(cmd, options)`
Synchronous (`execSync`) one-shot adb command, returns trimmed stdout. Default 60s timeout. Used
for short, fire-and-forget commands (`shell rm -f ...`, `shell am force-stop ...`,
`devices -l`).

**Improve:** using `execSync` means the whole Node event loop blocks while a command runs — for a
60-second-timeout command that actually takes close to that long (unlikely for the current use
cases, all fast shell commands, but not enforced), this would stall SSE broadcasts and every other
concurrent request. `adbAsync` already exists and doesn't have this problem; there's no strong
reason `adb()` couldn't be rewritten in terms of it, other than the call sites currently wanting a
synchronous return value inline.

### `adbAsync(cmd, options)`
Non-blocking (`child_process.exec`) version with configurable timeout (default: none) and a 50MB
output buffer. Used for potentially slower/streaming operations (`content insert`, `stat`, media
scanner broadcast).

### `adbPush(localPath, remotePath, options)`
Runs `adb push` via `execFile` (not `exec`) specifically so `localPath`/`remotePath` never pass
through a shell — avoids shell-injection/quoting issues that `exec`-based commands elsewhere in
this file rely on manual `JSON.stringify`/quote-wrapping to avoid. This is the right pattern; the
other two functions building shell command strings by interpolation (`adb`, `adbAsync`) are the
exception, not this one.

**Improve:** worth noting explicitly (as this comment does) since it's easy for a future addition
to this file to copy the `exec`-with-string-interpolation pattern instead of this safer one,
without realizing why this function is different.

### `listAdbDevices()`
Parses `adb devices -l` output into `{ serial, state, model }` objects. Returns `[]` on any error
(e.g. adb not found) rather than throwing — callers (`checkAdb`, `/api/status`) treat "no devices"
and "adb broken" identically, which is fine for the current UI (both show as "not connected") but
loses the distinction if a future caller needs to tell them apart.

### `checkAdb(serial)`
`true` if any device (or the specific `serial`, if given) is in the `device` state (authorized and
ready — as opposed to `unauthorized`/`offline`).

### `safeName(name)`
Strips filesystem-unsafe characters (`/\?%*:|"<>` and spaces) from a filename before pushing it to
the Pixel's `/sdcard/DCIM/Camera/`, replacing each with `_`. Simple character-class replace, no
edge cases worth flagging.

---

## `lib/cdp.mjs`

The Chrome DevTools Protocol layer: opening/attaching sessions to Chrome tabs, and the
account-pinning safety net that grew out of this session's work (see `CLAUDE.md`'s "Критические
ограничения" section for the design rationale in short form).

### `setSelectedAccount(path)` / `getSelectedAccount()`
Get/set the module-level `selectedAccountPath` — the account the user last explicitly picked via
`switchAccountStep`. `setSelectedAccount` always runs the value through `normalizeAccountPath`
first, so callers never need to normalize themselves; this is what makes the whole pinning
mechanism robust to `tokens.path` sometimes carrying extra route segments (see
`normalizeAccountPath`'s own note).

**Improve:** this state is a plain module-level variable — it resets on every server restart (see
architectural note #7 above). If that's ever undesirable, it needs exactly one line added
(`fs.writeFileSync`/`readFileSync` a tiny state file, or reuse the existing `WORK_DIR` for a
`.selected-account` file) plus a load-on-startup call.

### `normalizeAccountPath(p)`
Canonicalizes any account-path-shaped string down to `/u/N/`: bare `/` → `/u/0/` (Google's primary
account sometimes renders without an explicit index), and anything with extra trailing route
segments (`/u/1/_/PhotosUi/`, an in-app SPA route Google's own `eptZe` global can carry) gets
truncated to just the leading `/u/N/`. This function is the fix for two real bugs found and fixed
earlier in this session — anything that compares account identifiers *anywhere* in this codebase
should go through this function first, never compare raw strings.

### `tabAccountPath(url)` *(not exported)*
Extracts and normalizes the account path from a Chrome tab's `.url` (as opposed to
`normalizeAccountPath`, which takes an already-known path string / `eptZe` value). Used only
inside `connectCdp()`'s tab-selection logic.

### `class CdpSession`
Thin wrapper around a raw `ws` WebSocket to one Chrome tab's debugger endpoint. `send(method,
params)` does the request/response ID-matching bookkeeping (a `Map` of pending promises keyed by
message ID); `evaluate(expression)` is a convenience wrapper around `Runtime.evaluate` that
throws if the evaluated JS threw. `close()` swallows any error (fine — closing an already-closed
socket isn't exceptional).

**Improve:** there's no timeout on `send()` — if Chrome never responds to a request (tab crashed,
network partition to a remote debug target, etc.), the returned promise hangs forever and whatever
`await`ed it hangs with it. Every step already has its own outer logic (mostly none, actually —
most steps have no per-RPC timeout at all, relying on the *operation* eventually being visibly
stuck rather than erroring). A default timeout in `send()` (reject after e.g. 30s with a clear
"Chrome tab stopped responding" error) would turn a silent hang into an actionable error message.

### `connectToTab(tab)`
Attaches a fresh `CdpSession` to a specific, already-known tab descriptor (from `getCdpTabs()` or
Chrome's `/json/new`) — no tab-selection logic, just connects to exactly the tab you hand it.
Added this session for `openAccountTabsStep`, which needs to talk to several specific tabs by
identity rather than relying on `connectCdp()`'s "find the right Photos tab" heuristics.
`connectCdp()` itself is now implemented in terms of this (see below).

### `connectCdp()`
The main entry point every step calls to get a working CDP session. Fetches Chrome's tab list,
filters to `photos.google.com` tabs, then picks one:
- If an account is pinned (`selectedAccountPath` set), only a tab whose URL matches that exact
  account is acceptable — throws a descriptive error listing what *is* open if none match.
- Otherwise, picks the first Photos tab found, logging a warning if more than one exists (so a
  stray second tab doesn't silently determine which account an operation runs against without at
  least a log line about it).

**Improve:** the "first tab" fallback (when nothing is pinned) is inherently non-deterministic —
Chrome's tab ordering from `/json` isn't documented/guaranteed to be creation order, so which
account an unpinned operation targets could, in principle, vary between calls if Chrome's internal
ordering ever changes. In practice this has been observed to be stable (creation order) across
this session's testing, but it's an assumption, not a guarantee. The warning log is the current
mitigation; a stronger one would be requiring an explicit pin before any operation runs when more
than one Photos tab is open, rather than silently picking one.

### `getCdpTabs()`
Fetches Chrome's `/json` tab list, returns `[]` on any failure (network error, Chrome not running)
rather than throwing — callers that need to distinguish "no tabs" from "Chrome unreachable" can't,
from this function alone (`connectCdp()` handles this by throwing its own more specific error
*before* calling this, using a separate `fetch` with its own catch).

### `tryGetAccountEmail(wsUrl)`
Best-effort scrape of the signed-in account's email from a tab's DOM: looks for a `[data-email]`
attribute first, then falls back to scanning every `[aria-label]` for an email-shaped string. Runs
with its own 3.5s timeout (resolves `null`, doesn't throw) so a slow/broken tab can't hang the
caller. This is inherently fragile — it depends entirely on Google Photos' current DOM structure
and attribute naming, which is unversioned and can change without notice (see architectural note
#3, same class of risk as the RPC IDs).

**Improve:** if this selector ever stops matching (Google redesigns the account switcher), the
failure mode is silent — every account just permanently shows no email, with no error surfaced
anywhere distinguishing "genuinely not found" from "selector broke." A one-time startup or
periodic sanity check (e.g. "if this has returned null for every account for the last N minutes
while accounts are known to exist, log a warning suggesting the DOM selector may need updating")
would turn a silent, slow-to-notice failure into a noisy, fast-to-diagnose one. Not worth building
preemptively, but worth remembering if the email-in-dropdown feature ever "just stops working" —
check this function's selectors first.

---

## `lib/chrome.mjs`

Spawning and killing Chrome processes. No CDP/network calls here — purely `child_process`.

### `trackChild(child)` *(not exported)*
Records a spawned child's PID in `launchedPids` (for cleanup on shutdown) and calls `.unref()` so
the spawned process doesn't keep the Node event loop alive by itself.

### `killAllLaunchedChrome()`
On shutdown (`server.mjs`'s `SIGINT`/`SIGTERM` handler), kills every process this server spawned —
signals the whole process group (`-pid`) on POSIX so Chrome's renderer/GPU/utility subprocesses
die with it, or `taskkill /T` on Windows for the same effect. Best-effort — swallows errors per-PID
(a process that already exited isn't a failure).

### `findChrome()`
Resolves a Chrome/Chromium binary: `CHROME_PATH` env var first, then the hardcoded
`CHROME_PATHS` list (see config.mjs's improve-note), then (non-Windows only) `which` against a
list of common binary names. Throws with an actionable message if nothing is found.

### `launchChrome()`
Spawns Chrome with remote debugging enabled on port 9222, a dedicated temp profile
(`CHROME_PROFILE_DIR`), pointed at bare `https://photos.google.com` (the "bootstrap tab" — see
`openAccountTabsStep`'s docs in `steps/miscSteps.mjs`, which immediately supersedes this tab with
one dedicated tab per signed-in account). Returns immediately once the process is spawned — does
**not** wait for Chrome to actually finish starting or for the debug port to come up (that's
`openAccountTabsStep`'s `waitForCdpReady()`'s job, called right after this from the frontend).

**Improve:** this function's name and `handleStatusRequest`/router-level `handle`'s reachable-but-
unrelated meaning could confuse a first-time reader — "launch Chrome" here means "spawn the
process," not "Chrome is now usable." Worth keeping in mind if this function is ever changed to
also wait for readiness — that would be a behavior change every caller needs to be aware of (the
frontend currently does its own separate wait via the `open-account-tabs` op).

### `openAppWindow(url)`
Opens the GUI itself in an app-style Chrome window (`--app=<url>`, a *separate* profile from the
automation Chrome — `CHROME_GUI_PROFILE_DIR`, not `CHROME_PROFILE_DIR`) on server startup, so the
user gets a native-feeling window instead of "open your browser and navigate to localhost:8080."
Falls back to `start`/`open`/`xdg-open` (default browser) if Chrome isn't found — the one place in
this codebase that degrades gracefully instead of hard-failing when Chrome is missing, since this
window is a convenience, not a functional requirement (the server still works if you just open the
URL in any browser yourself).

### `deleteProfile()`
Recursively deletes the automation Chrome profile directory (`CHROME_PROFILE_DIR`). No-ops
(returns `{ ok: true, note: ... }` rather than erroring) if the directory doesn't exist. Chrome
must be closed first — an open Chrome holding file locks on the profile will make this throw
(surfaced to the user as a 500 via the route handler, with Chrome's OS-level error message, which
may not be an obviously actionable message to a non-technical user).

**Improve:** the "Chrome must be closed" requirement isn't checked/enforced here — it's purely
documented in comments and the UI's confirm dialog. A pre-check (are any of `launchedPids` still
alive?) with a clearer error message ("Close Chrome first" instead of whatever `EBUSY`/`EPERM`
message the OS gives) would be a small, genuinely useful UX improvement.

---

## `lib/rpc.mjs`

Everything that actually talks to Google Photos: token extraction, the generic RPC call wrapper,
and several higher-level operations built on it (pagination, batch quota lookups, archiving,
listing albums).

### `clearAlbumsCache()`
Empties both album caches (`_albumListCache`, `_albumContentCache`). Called on every SSE
(re)connection (i.e. every page load/refresh) and at the start of every scan, so stale album data
never survives a refresh or a deliberate re-scan.

### `getTokens(cdp)`
Reads Google's `window.WIZ_global_data` inline globals from the currently-loaded page — `at`
(CSRF token), `fsid` (session id), `bl` (build label), `path` (`eptZe`, the account/route path).
This is the foundation every RPC call is built on (`callRpc` takes a `tokens` object shaped exactly
like this). Also the second, authoritative layer of the account-pinning safety net (see
`lib/cdp.mjs`'s notes): if an account is pinned and the live page's own `eptZe` doesn't match after
normalization, this throws rather than silently proceeding against the wrong account.

**Improve:** entirely dependent on `WIZ_global_data` continuing to exist with these exact property
names (`SNlM0e`, `FdrFJe`, `cfb2h`, `eptZe`) — same fragility class as the RPC IDs and the email
DOM scrape (architectural note #3). If Google ever renames these, every operation in the app fails
at the very first step with `WIZ_global_data not found` or (worse) a `TypeError` if the object
exists but a property is renamed rather than removed — worth hardening the destructuring to name
which specific field is missing, for a faster diagnosis.

### `callRpc(cdp, rpcId, data, tokens, options)`
The one function that actually sends a `batchexecute` RPC request — every Google Photos API call
in this app goes through this. Builds the wrapped/encoded request body (Google's `f.req=` format),
injects `fetch()` into the page via `cdp.evaluate()` (not a direct Node-side request — see
`CLAUDE.md`'s note on why: so the browser's session cookies attach automatically), and parses the
`)]}'`-prefixed, `wrb.fr`-tagged response format back into plain JSON.

`options.allowEmpty` — if true, returns `null` instead of throwing when the response has no
`wrb.fr` line (used by callers that treat "empty" as a valid, meaningful result rather than an
error, e.g. `fetchLibraryPage`'s retry logic and `batchQuotaInfo`).

`options.sourcePath` — overrides the `source-path` header Google expects (defaults to
`window.location.pathname`, i.e. wherever the tab is currently navigated); used when a call needs
a *different* source-path than the tab's current URL (e.g. archive enumeration, shared-album
restores).

**Improve:** no timeout (same issue as `CdpSession.send()`, which this ultimately calls into via
`cdp.evaluate`) and no retry of its own — every retry loop in this codebase (`batchQuotaInfo`,
`fetchLibraryPage`) is implemented by the *caller* wrapping `callRpc` in its own loop, not by this
function. Centralizing that here (per architectural note #4) would mean every RPC call
automatically benefits from a consistent retry policy instead of only the two call sites that
happened to need it badly enough to write their own loop.

### `enumerateAll(cdp, tokens, options)`
Generic paginated enumeration — walks `lcxiM` (library, or `mode`-selected variant) or `snAcKc`
(a specific album) page by page until `pageToken` comes back null, accumulating every item.
`options.archive` switches to archive enumeration (a different `source-path` and payload
position). `options.onPage(pageNum, totalSoFar, pageItems)` is an optional progress callback,
called after every page — used by scan/download/etc. to log progress as it goes rather than only
at the end.

**Improve:** accumulates the *entire* result in memory (`items.push(...pageItems)` every page,
never streamed to disk). For a library scan this could be tens of thousands of raw RPC result
arrays held in memory simultaneously before `scanStep` even starts processing them. Fine at
observed scale (~2000-9000 items in this session's actual usage); would need to become a streaming
generator/callback-only design if used against a library an order of magnitude larger.

### `buildQuotaRequestData(mediaKeys)` *(not exported)*
Builds the deeply-nested request payload shape `EWgK9e` expects for a batch of media keys. Pure
data transformation, no side effects — the nested-array-of-nulls padding is copied from observed
real request shapes (reverse-engineered from the network tab), not derived from any documented
schema, so **do not "simplify" this shape** without testing against a real account; the padding
`null`s at specific positions may be meaningful to Google's backend even though they look inert.

### `batchQuotaInfo(cdp, tokens, mediaKeys)`
Looks up quota/storage-saver/original-quality status for up to `QUOTA_BATCH_SIZE` (5000) media
keys per RPC call, batching larger requests automatically. Retries each batch up to twice on
failure; a batch that fails both times is logged and **skipped** (not retried on a later call, not
surfaced as a partial-failure return value — the caller's resulting array is just silently shorter
than `mediaKeys`, which every caller currently tolerates because a rescan will pick up any
still-missing items next time).

Repacks Google's response shape into a stable `qi` array every caller reads by fixed index —
`qi[0]`=mediaKey, `qi[2]`=filename, `qi[5]`=sizeBytes, `qi[14]`=isOriginalQuality marker,
`qi[30][0]`=consumesQuota marker. This repacking is what lets every downstream caller
(`scanStep`, `verifyStep`, `matchAlbumsStep`) share one reading convention regardless of exactly
how Google's raw response is shaped.

**Improve:** the "skip on double failure, log a warning" behavior means a scan/verify run can
silently under-count without the operation itself reporting failure (`opEnd(..., true, ...)` still
fires with `ok: true`) — a user watching only the final summary line, not the log, could believe a
scan completed fully when a batch was actually dropped. Surfacing a count of skipped items in the
final summary (not just a mid-run warn log) would make partial failures visible where the user is
actually looking.

### `archivePhoto(cdp, tokens, dedupKey)`
Sends the `w7TP3c` RPC to move an item into (or out of — same RPC, direction encoded in `data`)
Google Photos' archive. Used only by `restoreAlbumsStep`'s "re-archive" pass. Throws on any
non-200 or error-flagged response.

### `enumerateAlbumCached(cdp, tokens, albumId)`
Cached wrapper around `enumerateAll({ albumId })` — first call for a given `albumId` in this
process's lifetime does the real enumeration and caches the result in `_albumContentCache`; every
later call for the same album returns the cached array without a network round-trip. Cache is
cleared by `clearAlbumsCache()`. Used by `saveAlbumMemberships` (checking many albums for
membership, potentially re-checking the same album across multiple scan/trash-reupload runs in one
session) and `switchAccountStep`-adjacent flows.

**Improve:** the cache has no size bound and no TTL — for a library with hundreds of albums, this
could accumulate a meaningful amount of memory over a long server session, though nowhere near a
practical concern at any scale actually observed. `clearAlbumsCache()` being called on every SSE
reconnect (i.e. every page load) is the de facto TTL in practice.

### `listAllAlbums(cdp, tokens)`
Fetches the *entire* album list by scraping and parsing the embedded `ds:5` JSON blob out of the
raw HTML of `https://photos.google.com/u/N/albums` (not a `batchexecute` RPC — a plain page fetch,
because there's no known RPC that returns the full album list directly). The bracket-matching
parser (hand-rolled, walking the HTML string character by character tracking string/escape state
and bracket depth) exists because the embedded JSON is surrounded by other page markup that can't
be split on with a regex reliably (nested brackets, strings containing brackets, etc.).
Result is cached in `_albumListCache` — first call per process (or since the last
`clearAlbumsCache()`) does the real fetch+parse; every later call returns the cached array.

`info[0] === 4` is read as "shared/collaborative album" — this magic number, like the RPC IDs, was
reverse-engineered from observed data, not documented anywhere by Google.

**Improve:** this is the single most fragile function in the codebase — it depends on (a) the
`ds:5` marker string still appearing in the HTML, (b) the JSON blob still being valid embedded
JSON at that location, and (c) the specific object key `'72930366'` and its `[0]`/`[1]`/`[3]`
positions still meaning what they're assumed to mean, none of which Google has any obligation to
keep stable. If this stops working, the error message (`'ds:5 block not found...'` or
`'JSON.parse: ...'`) at least localizes the problem to this function specifically, which is more
than some of the RPC-based failures give you.

---

## `steps/scanStep.mjs`

Step 1's backend: finds every item that "consumes quota" and adds it to the manifest, either from
selected albums or the whole library, plus (in the "full" variant) fills in `dedupKey`s and saves
album memberships in the same pass.

### `enumerateLibrary(cdp, tokens)` *(not exported)*
Enumerates the whole library plus the whole archive, tags every archived item's key (both
`mediaKey` and `dedupKey`, since either might be what a later lookup uses) into `archivedKeys`.
Used when no album filter is given (`albumIds` empty/absent).

### `enumerateSelectedAlbums(cdp, tokens, albumIds)` *(not exported)*
For each selected album: fetches its items, records which items belong to it
(`albumToKeys`) and which were uploaded by someone other than the account owner
(`albumToForeignKeys`, detected via a `[7]`-position marker `[20]` on the raw item — another
reverse-engineered magic number). Also enumerates the archive (same as `enumerateLibrary`) since
archived-but-selected-album items still need to be found. Returns richer metadata than
`enumerateLibrary` (album membership, shared-album flags) since the album-scoped path needs it and
the whole-library path doesn't.

### `deduplicateItems(rawItems)` *(not exported)*
Dedupes raw RPC items by `dedupKey` (preferred) or `mediaKey` (fallback) — the same physical photo
can appear multiple times across albums/pages, and this collapses those to one entry before quota
lookups, so `batchQuotaInfo` isn't asked about the same key twice.

### `buildDedupMap(uniqueItems)` *(not exported)*
Builds a `mediaKey → dedupKey` lookup from the already-deduplicated items — a small pure helper,
no side effects.

### `buildQuotaManifestEntries(...)` *(not exported)*
The core "does this item belong in the manifest" filter and entry-builder — takes raw quota-lookup
results (`qi` arrays from `batchQuotaInfo`), keeps only items where `qi[30][0] === 1` (consumes
quota), skips anything already in the manifest (via `existingKeys`), attaches album membership (and
`isOtherOwner`/`isSharedAlbum` flags) from the maps built earlier, and stamps `isArchived`. This is
the single place that decides the shape of a freshly-scanned manifest entry — see the field list in
`CLAUDE.md`'s "Схема данных" section for the full lifecycle.

**Improve:** takes 9 positional parameters, several of them optional with defaults, several of
them Maps constructed just to be passed straight through. Not wrong, but a single options object
(`{ quotaInfos, existingKeys, dedupMap, albumToKeys, albumTitleMap, archivedKeys, archiveScanned,
albumToForeignKeys, albumSharedMap }`) would make call sites self-documenting instead of requiring
the reader to count positions against the signature.

### `saveAlbumMemberships(cdp, manifest, albumIds)` *(not exported)*
After a scan, checks every album the scan *didn't* already cover (i.e. every album except the ones
passed in `albumIds`, or every album at all for a full-library scan) for membership of any
`consumesQuota` item — so an item found via "scan all library" still gets its correct album tags
for the later "restore into albums" step, not just membership in whichever album it happened to be
selected through.

**Improve:** for a "scan all library" run with many albums, this is O(albums × items-per-album)
network calls (mitigated by `enumerateAlbumCached`, but only within a single process's cache
lifetime — a fresh server start pays the full cost again on the next scan). No progress bar beyond
the `Albums: N/M` log line every 10 albums; for a library with hundreds of albums this could be the
single longest-running phase of a scan without much visibility into it beyond the log panel.

### `scanStep({ albumIds })`
The `/api/scan` handler — the "basic" scan (album-scoped only if `albumIds` given, whole library
otherwise), no dedupKey enrichment beyond whatever's already attached to raw RPC results, no
"scan all library" toggle-mode awareness beyond `albumIds` being empty/absent. Superseded in the
UI by `scanFullStep` (`/api/scan-full`, wired to the actual "Scan" button in the merged Scan &
Prepare step) — kept as a separate, simpler entry point; documented as "standalone" for the same
reason `enrichStep` is (see `dead-code-audit.md`).

### `enrichDedupKeys(cdp, tokens, manifest)` *(not exported, `scanFullStep`-only)*
Paginates the whole library looking for `dedupKey`s for any manifest item that doesn't have one
yet (stops early once every target is found). Effectively the same logic as
`enrichStep.mjs`'s `findDedupKeysInLibrary` — **this is duplicated code**, not shared. See
`steps/enrichStep.mjs`'s note below for the concrete suggestion.

### `scanFullStep({ albumIds })`
The `/api/scan-full` handler — what the UI's "Scan" button actually calls. Same core scan logic as
`scanStep`, plus: `scanAll = !albumIds?.length` decides whole-library vs. album-scoped (this is
where the "Scan All Library" toggle's intent actually gets interpreted, on the backend side —
the frontend just decides whether to send `albumIds` at all), then always runs
`enrichDedupKeys` and `saveAlbumMemberships` afterward regardless of scan mode.

---

## `steps/downloadStep.mjs`

Step 2's alternative path: downloads original-quality files directly from Google Photos, bypassing
the manual Google Takeout + GooglePhotosTakeoutHelper workflow.

### `findUrl(obj, depth)` *(not exported)*
Walks an arbitrarily-nested array/object looking for the first string starting with `https://` —
used because the signed download URL in `pLFTfd`'s response is at an unpredictable depth/position
(another reverse-engineered response shape, unlike the fixed-position `qi` arrays elsewhere). Depth
capped at 5 to avoid runaway recursion on an unexpected shape.

**Improve:** "first https:// string found" is a heuristic, not a guarantee it's *the* download URL
— if Google's response ever includes another URL earlier in traversal order (e.g. a tracking
pixel, a thumbnail URL), this would silently return the wrong URL rather than erroring, and the
resulting download would just fail with an HTTP error or wrong-content mismatch further down
(caught by the size-mismatch warning, but not by this function itself).

### `getDownloadUrl(cdp, tokens, mediaKey)` *(not exported)*
Calls `pLFTfd` for one media key, extracts the URL via `findUrl`. Returns `null` (not throw) if the
RPC returns nothing — the caller (`downloadStep`'s worker) turns that into a per-item error log
line, not a fatal error for the whole run.

### `safeFsName(name)` *(not exported)*
Filesystem-unsafe character stripping — nearly identical to `lib/adb.mjs`'s `safeName` (same
character class, `[/\\?%*:|"<>]` here vs. `[ /\\?%*:|"<>]` there — this one is missing the space in
the character class, a tiny inconsistency). **This is duplicated logic that should be one shared
function** (see improve-note at the end of this section).

### `buildUniqueNamer(manifest)` *(not exported)*
Returns a closure that, given a manifest item, produces a safe, collision-free local filename —
counts how many manifest items share each `filename` up front, and only items in a collision group
get a disambiguating `_<mediaKey suffix>` appended, so the common (no-collision) case keeps clean,
readable filenames. Built once per `downloadStep` run (not per-item) since the collision counts
need the whole manifest to compute.

### `downloadStep({ concurrency, mediaKeys })`
The `/api/download` handler. Filters to `consumesQuota && !downloaded` items, optionally further
scoped to a specific `mediaKeys` list (added this session, for the "Download these" button in the
unverified-items viewer — see `api-reference.md`'s note on this). Fetches signed download URLs
per-item via CDP (so the RPC call gets the right cookies/tokens), but the actual file bytes are
fetched **Node-side directly** (`fetch(url, { headers: { Cookie: cookieHeader } })`, not through
`cdp.evaluate`) — reusing the browser's cookies (grabbed once via `Network.getCookies`) without
needing every byte to round-trip through the browser process. Runs a worker pool
(`Math.min(concurrency, 6)`), checkpoints the manifest to disk every 10 completions, and respects
`isStopRequested()` between items.

**Improve:** `safeFsName` here and `safeName` in `lib/adb.mjs` do almost the same job with a subtly
different character class — worth consolidating into one shared function in a common location
(there's no existing "string utils" file; this alone probably doesn't justify creating one, but if
a third near-duplicate ever appears, it would).

---

## `steps/enrichStep.mjs`

Standalone dedupKey backfill — not wired to any UI button (see `dead-code-audit.md`), reachable
only via `POST /api/enrich` directly.

### `findDedupKeysInLibrary(cdp, tokens, targetKeys)` *(not exported)*
Paginates the whole library looking for `dedupKey`s matching a target set of `mediaKey`s, stopping
early once every target is found. **This is the same logic as `scanStep.mjs`'s
`enrichDedupKeys`**, duplicated rather than shared.

**Improve:** genuinely worth fixing — these two functions are close to line-for-line identical
(same pagination loop, same early-stop condition, same per-page logging shape), just with
`enrichDedupKeys` also mutating the manifest in place and this one returning a `Map` for the
caller to apply separately. Extracting one shared `findDedupKeysInLibrary(cdp, tokens, targetKeys)`
into `lib/rpc.mjs` (next to `enumerateAll`, which it's a specialized variant of) and having both
`scanStep.mjs` and `enrichStep.mjs` call it would remove ~25 lines of duplication and, more
importantly, mean a bug fix in the pagination/retry logic only needs to happen once.

### `applyDedupKeys(manifest, found)` *(not exported)*
Applies a `mediaKey → dedupKey` map to matching manifest items in place, returns the count applied.
Small, pure-ish (mutates `manifest` items but takes no other action) helper.

### `enrichStep()`
The `/api/enrich` handler — finds every manifest item missing a `dedupKey`, looks them up, applies
and saves. Early-returns with a success log if nothing needs enriching.

---

## `steps/trashReuploadStep.mjs`

The destructive core of the pipeline (step 3: "Trash + Reupload") plus its two safer companions
added this session (`repushStep`, `pushStep`).

### `saveAlbumMembershipsForItems(cdp, tokens, manifest, itemsNeedingAlbums)` *(not exported)*
Inline album-membership backfill run just before trashing, for any item that reached this step
without album data already saved (i.e. `saveAlbumsFirst: true`, the default, and the item wasn't
already tagged by a prior scan's `saveAlbumMemberships`). Checks *every* album in the account
(`listAllAlbums`, unfiltered — unlike `scanStep.mjs`'s `saveAlbumMemberships`, which skips albums
already covered by the scan) for membership of just the items that need it.

**Improve:** this and `scanStep.mjs`'s `saveAlbumMemberships` are two different implementations of
"find which albums a set of items belongs to," with different filtering strategies (album-scoped
skip-list here is absent; there it exists). Not identical enough to trivially merge, but close
enough that a future bug fix in one ("album membership missed for X reason") should prompt
checking whether the same bug exists in the other.

### `trashPhoto(cdp, tokens, dedupKey)` *(not exported)*
Sends the `XwAOJf` RPC with `source-path: '/photos'` to move one item to trash. Requires
`dedupKey`, not `mediaKey` (see `CLAUDE.md`'s critical-constraints note on this — it's the single
most-repeated gotcha across this codebase's docs, because getting it backwards produces a
confusing failure, not an obviously-wrong-key error).

### `permanentDeleteFromTrash(cdp, tokens, dedupKey)` *(not exported)*
Same `XwAOJf` RPC, different `data`/`source-path` (`/trash`, "permanently delete" mode) — empties
an item from trash immediately after trashing it, when `emptyTrash: true` is requested. This
prevents Google Photos from auto-restoring the trashed original when the re-uploaded copy with the
same content arrives (a real failure mode this option exists specifically to prevent).

### `repushStep({ concurrency, device })`
The `/api/repush` handler — re-attempts *only the push* for items that were already trashed
(`trashedAt` set) but never successfully completed the push half (`!reuploadComplete`, e.g. the
`adb push` failed or the device disconnected mid-run). Falls back to re-pushing *every* trashed
item (not just pending ones) if none are specifically pending — a safety net for "the manifest
says done but the file isn't actually on the device" scenarios, at the cost of potentially
re-pushing files that don't actually need it (harmless: `pushPhotoToPixel`'s size-check makes a
redundant push a no-op).

### `pushStep({ concurrency, device })`
Added this session — the non-destructive counterpart: pushes downloaded files to the device
**without trashing anything**, for the cross-account workflow (scan account A, push files, verify
they land in account B without ever touching account A's cloud copies). Filters explicitly away
from anything the destructive pipeline has already touched (`!trashedAt && !reuploadComplete`) or
already pushed by this same op (`!pushedOnly`), so it never steps on `trashReuploadStep`'s or
`repushStep`'s territory.

### `getMimeInfo(filename)` *(not exported)*
Extension → `{ mime, uri }` lookup table for the MediaStore `content insert` call that makes a
pushed file show up correctly in the Pixel's gallery (right MIME type, right media collection —
video vs. image URI). Defaults to `image/jpeg` for any unrecognized extension.

**Improve:** the default-to-JPEG fallback means a genuinely unrecognized file type (something not
in this switch — e.g. a `.avif` or `.raw` file) gets silently mis-tagged as a JPEG in MediaStore
rather than erroring or logging a warning. Probably rare in practice (Google Photos originals are
almost always jpg/heic/mp4/png/etc., all covered), but worth knowing if a user ever reports "some
files show up weird in the gallery after push."

### `pushPhotoToPixel(item, device)` *(not exported)*
The actual push: `safeName`s the local filename, checks the remote file's size via `adb shell stat`
first and **skips the actual `adb push` if the size already matches** (idempotent re-runs, cheap —
this is what makes `repushStep`'s "just re-push everything" fallback safe), then registers the file
with Android's MediaStore (`content insert`) and triggers a media-scanner broadcast so it appears
in the gallery immediately rather than waiting for the next scheduled scan. Sets `item.pushedAs`
(the on-device filename — used later by `verifyStep`'s filename matching) as a side effect,
regardless of which caller (`trashReuploadStep`, `repushStep`, or `pushStep`) invoked it.

**Improve:** the size-match "skip if already there" check is a reasonable idempotency guard but not
a content check — if a file were somehow replaced on-device with a different file of the *same*
byte size, this would incorrectly treat it as already-pushed. Extremely unlikely in this app's own
usage pattern (nothing else touches `/sdcard/DCIM/Camera/` between pushes), not worth hardening
unless a real report of it ever surfaces.

### `trashReuploadStep({ mediaKeys, saveAlbumsFirst, emptyTrash, concurrency, device })`
The `/api/trash-reupload` handler — the pipeline's one genuinely irreversible step. Filters to
items with `downloaded && downloadedAs && dedupKey && !reuploadComplete`, optionally further
scoped via `mediaKeys`. Pre-flight checks every target file actually exists on disk *before*
trashing anything (fails the whole run rather than trashing some items whose local copies turn out
to be missing). Per item: trash → (optionally) empty trash → push → mark
`reuploadComplete`. **Critically, `reuploadComplete` is only set if *both* trash and push
succeed** — an item that trashed successfully but failed to push is left with `trashedAt` set but
`reuploadComplete` unset (`trashError` records why), which is exactly what `repushStep`'s "pending"
filter (`trashedAt && !reuploadComplete`) is built to find and retry. Checkpoints every 10
completions; respects `isStopRequested()` between items; restarts the Pixel's Photos app afterward
(force-stop + relaunch) so its backup scan picks up the newly-pushed files promptly instead of
waiting for its own periodic scan.

---

## `steps/verifyStep.mjs`

Step 4: confirms items are quota-free wherever the currently-connected account is (which, as of
this session's cross-account work, doesn't have to be the account the item was trashed from).

### `buildFilenameToItemMap(items)` *(not exported)*
Builds a `filename.toLowerCase() → item` map for fast lookup while paginating the library —
indexes by `pushedAs` (the actual on-device filename, if the item went through the push pipeline)
falling back to `filename` (the original name, for items that were only ever scanned/verified
without going through push — the cross-account presence-check case). Also indexes the
extension-stripped name as a fallback, since Google sometimes normalizes/re-encodes an uploaded
file's extension.

### `applyQuotaInfo(item, qi, newMediaKey)` *(not exported)*
The actual verify decision: an item is confirmed verified if `qi[30][0] !== 1` (not consuming
quota) **and** `qi[14] === 2` (original quality) — both conditions, not just one; a file that's
backed up but still in Storage Saver quality, or one that's original quality but still consuming
quota (backup not yet fully processed), is correctly treated as "not yet verified," not a false
positive. Sets `verified: false` with a human-readable `verifyNote` on the non-passing case, so a
partially-done item shows *why* it's not done yet rather than just "not verified" with no context.
Already-`verified === true` items are skipped immediately (returns `null` without re-checking) —
this is what makes `resetVerifyStep` necessary to force a re-check of an already-confirmed item.

### `fetchLibraryPage(cdp, tokens, pageToken, page)` *(not exported)*
Wraps a single `lcxiM` page fetch in up to 4 retry attempts with linear backoff (1s, 2s, 3s) —
explicitly because `lcxiM` is observed to occasionally throw or return empty on a transient
blip, *not* because pagination has actually ended (true end-of-pagination is `pageToken` coming
back `null`, a different signal entirely). Without this retry, a single transient glitch partway
through a large library's pagination would kill or silently truncate the whole run.

### `verifyStep()`
The `/api/verify` handler. Filters to `consumesQuota && verified !== true` — deliberately *not*
`reuploadComplete`-gated (a change made this session specifically to support the cross-account
presence-check workflow: scan account A, switch to account B, verify without ever running
trash-reupload at all). Paginates the connected account's library newest-first, matching each
page's items against the target set by filename (falling back to dedupKey via the raw lcxiM item's
own `[3]` position), applying `applyQuotaInfo` to each match. **Pipelines fetch and processing**:
while page N's quota-info batch is being fetched (`pending`), page N+1's raw library page is
already being requested — `drainPending()` processes the previous page's results once the current
page's fetch completes, so the two network round-trips overlap instead of running strictly
sequentially. Persists the manifest and broadcasts fresh `stats` after every page (not just at the
end), so the frontend's stat cards and any open "not verified" viewer update live as items get
confirmed — this was also added this session, specifically so the live viewer feature has
something to refresh *to* mid-run.

Stops early (`if (verified.size >= items.length) break`) once every target has been found — most
runs resolve within the first few pages since freshly re-uploaded items land near the front of a
newest-first listing, so this avoids walking a whole large library on every verify run.

**Improve:** the early-stop assumes newly-verified items cluster near the front of the library.
That's true for the trash-reupload-then-verify workflow (fresh uploads are naturally recent) but
isn't necessarily true for the cross-account presence-check workflow (an item scanned from account
A might have been uploaded to account B at any point in the past, not recently) — a cross-account
verify run could end up walking the *entire* target account's library before finding old matches,
with no different messaging or progress framing to tell the user "this could take a while" versus
the fast-path case. Worth a UI/log hint distinguishing the two expected-duration profiles if
cross-account verify sees more use.

---

## `steps/albumsStep.mjs`

Step 5: restores verified items into their original albums and re-archives items that were
archived before the pipeline touched them.

### `restoreItemsIntoSharedAlbum(cdp, tokens, albumId, albumItems, onBatch)` *(not exported)*
Restores a batch (up to `RESTORE_BATCH` = 50) of items into a **shared/collaborative** album via
the `laUYf` RPC, `source-path: /u/N/share/<albumId>`. Shared albums need a structurally different
request payload (`data` shape) and source-path than personal albums — this is why there are two
near-parallel restore functions rather than one with a flag; the RPC IDs and payload shapes
genuinely differ, not just cosmetically.

### `restoreItemsIntoPersonalAlbum(cdp, tokens, albumId, albumItems, onBatch)` *(not exported)*
Same job, personal (non-shared) albums, via `E1Cajb`, `source-path: /u/N/album/<albumId>`. Simpler
payload than the shared variant (just a flat array of `newMediaKey`s + the album ID).

### `buildSharedAlbumSet(manifest)` *(not exported)*
Scans the whole manifest's `albums` arrays for any item tagged `isSharedAlbum` or (legacy fallback)
`isOtherOwner`, building the set of album IDs that need the shared-album restore path rather than
the personal one. This is how `restoreAlbumsStep` decides which of the two restore functions above
to call per album group.

### `groupItemsByAlbum(items)` *(not exported)*
Groups verified, restore-eligible items by which album(s) they belonged to (an item can belong to
multiple albums, so this can put the same item in multiple groups) — skips `isOtherOwner` items
entirely (photos belonging to another user within a shared album aren't this account's to restore
into that album).

### `restoreAlbumsStep()`
The `/api/restore-albums` handler, two independent passes:
1. **Album restoration** — every item with `verified && newMediaKey && (non-foreign) albums &&
   !albumsRestored`, grouped by album, restored via whichever RPC (shared/personal) that album
   needs, checkpointing the manifest after every album group (not just every item — a run
   interrupted mid-way still preserves progress at album granularity).
2. **Re-archiving** — every item with `verified && newMediaKey && isArchived &&
   !archivedRestored`, archived in small concurrent batches (`ARCHIVE_CONCURRENCY` = 5) with a
   50ms pause between batches (a deliberate light rate-limit — not explained further in the
   code, presumably to avoid tripping Google's abuse detection on a rapid sequence of the same
   RPC).

Both passes use `item.newMediaKey` (assigned by `verifyStep` on successful verification) since the
item's original `mediaKey` no longer exists after reupload — this is the same "match by filename,
not mediaKey" principle documented at the top level (`CLAUDE.md`), applied here as "restore using
the *new* key, not the old one."

---

## `steps/miscSteps.mjs`

A grab-bag of steps that don't fit the main numbered pipeline: cleanup, matching, resets, and the
account-tab management added this session.

### `cleanupPixelStep({ device })`
The `/api/cleanup-pixel` handler — `adb shell rm -f /sdcard/DCIM/Camera/*` (the `-f` specifically
so an already-empty folder doesn't count as an error). Simple, single-command step; no manifest
interaction at all (doesn't track which specific files it removed — just wipes the whole camera
folder, on the assumption that by the time you run this, backup verification has already
confirmed everything that needed to leave the device has left).

**Improve:** wipes the *entire* camera roll, not just files this app pushed — if the user has taken
new photos with the Pixel's camera since the push (unlikely mid-pipeline, but possible), those
would be deleted too, with no distinction made. Worth a warning in the UI's confirm step if one
doesn't already call this out explicitly (check `index.html`'s Cleanup Pixel button/description
wording).

### `collectFiles(dir)`
Recursively lists every file under `dir`, skipping dotfiles and `readme.md` (case-insensitive) —
used both for `downloads/` (matching/pushing) and reused by `handleStatusRequest` for the
`downloadCount` stat. Silently skips directories it can't read (permission errors, etc.) rather
than failing the whole walk.

### `resetAllStep()`
The `/api/reset-all` handler — three destructive actions in sequence: delete the Chrome profile,
delete `manifest.json`, and `rm -rf` everything inside `downloads/`. Explicitly documented not to
follow symlinks into their targets (a `downloads/` subfolder symlinked elsewhere on disk is
untouched, only the symlink itself is removed) — `fs.rmSync`'s default behavior, called out in a
comment because it's easy to assume the opposite.

### `matchManifestStep()`
The plain (non-album-scoped) `/api/match` path — matches files already sitting in `downloads/`
against manifest items by filename, for items that don't already have a matched download. Used
when downloads came from a manual Takeout export rather than the album-aware match flow below.

### `matchAlbumsStep({ albumIds })`
The album-scoped `/api/match` path — for each selected album, enumerates it fresh (independent of
whatever `scanStep`/`scanFullStep` already found), checks quota status, and matches against
`downloads/` by filename — **adds new manifest entries** for matches not already tracked (unlike
`matchManifestStep`, which only updates existing entries). This is the "skip Takeout entirely, work
directly from albums" path.

### `waitForCdpReady(timeoutMs)` *(not exported)*
Polls `getCdpTabs()` every 500ms until it returns a non-empty tab list or `timeoutMs` (default
15s) elapses. Used by `openAccountTabsStep` to wait out the gap between `launchChrome()` returning
(process spawned) and Chrome's debug port actually being ready to accept connections.

### `openNewTab(url)` *(not exported)*
Opens a new Chrome tab at `url` via the `/json/new` HTTP debug endpoint — tries `PUT` first (what
current Chrome versions expect), falls back to `GET` on a `405` (older Chrome versions only
understood `GET` here). Throws with the HTTP status if neither works.

### `closeTab(targetId)` *(not exported)*
Closes a tab via the `/json/close/<id>` HTTP debug endpoint. Best-effort — swallows any error (a
tab that's already gone, or a momentary connection hiccup, isn't worth failing the caller over).

### `verifyAccountTab(tab, targetUrl)` *(not exported)*
Confirms a just-opened tab is a genuine, signed-in account at exactly the URL requested — two
checks, both required: `location.href === targetUrl` exactly (catches redirects to a sign-in page
or a different account), and `window.WIZ_global_data` truthy (catches an in-app error page that
doesn't change the URL but also never loaded real content). See `docs/operations.md`'s
`opOpenAccountTabs` entry for the fuller "why two checks" rationale.

### `openAccountTabsStep()`
The `/api/open-account-tabs` handler, run automatically right after every "Launch Chrome" click.
Waits for Chrome's debug port, snapshots existing Photos tabs, then probes `/u/0/` through
`/u/{MAX_ACCOUNT_PROBE - 1}/` in order — opening a real tab for each, verifying it, and stopping at
the first index that fails (accounts are assumed contiguous from 0, a real Google Photos
guarantee, not an assumption specific to this app). Once done, closes every tab from the initial
snapshot that isn't one of the newly-confirmed ones — this is what makes "close previous tabs"
happen safely (new working tabs are confirmed to exist *before* anything old is torn down).

**Improve:** the probe loop is strictly sequential (each account waits its own full 3-second settle
time before the next one starts) — for 3 accounts that's ~9+ seconds of dead waiting, serial by
construction. Since each account's tab is independent, the 3-second waits could run concurrently
(open all N candidate tabs first, *then* wait once, *then* verify all of them) — this would cut
total wait time from `~3s × N` to `~3s` flat, at the cost of briefly having more tabs open at once
during the probe (not a real problem, since a failed one gets closed regardless). Not done this
session to keep the change minimal and easy to reason about; worth revisiting if account counts
grow past 2-3 in practice and the wait becomes noticeable.

### `resetVerifyStep()`
The `/api/reset-verify` handler — clears `verified`/`verifiedAt`/`verifyNote`/`newMediaKey` from
every manifest item that has any of them set, so `verifyStep` can be re-run from scratch (e.g.
against a different account after switching). Doesn't touch `albumsRestored` — see
`albumsStep.mjs`'s notes on why that's a deliberate, safe asymmetry (restoring already happened
using the old `newMediaKey`; resetting verify doesn't retroactively undo it, just means the item
won't be restore-eligible again until re-verified).

### `switchAccountStep(accountPath)`
The `/api/switch-account` handler — navigates the currently-connected Photos tab to a different
account path, confirms the switch landed, and pins the confirmed account for every subsequent
operation. Unpins *before* navigating (`setSelectedAccount(null)`) specifically so its own
post-navigate `getTokens()` call doesn't reject itself for landing on the new account while the old
one is still pinned — a subtlety worth understanding before touching this function's ordering (see
the inline comment, added this session after this exact bug was hit and fixed).

---

## `api/router.mjs`

The HTTP layer — every route, the operation-dispatch table, and the account-email caching logic
that's had two real bugs found and fixed in it this session.

### `getDirSizeSync(dirPath)` *(not exported)*
Recursively sums file sizes under a directory — used only for `handleChromeInfoRequest`'s "how big
is the Chrome profile" display. Synchronous and recursive with no depth limit; fine for a Chrome
profile directory (bounded, not attacker-controlled), would be a concern if ever pointed at an
arbitrary/untrusted path.

### `json(res, data, status)`
The one place every route sends a JSON response — sets `Content-Type` and
`Access-Control-Allow-Origin: *` (CORS wide open; fine for a localhost-only tool, worth revisiting
per architectural note #2 if this is ever exposed beyond localhost).

### `parseBody(req)` *(not exported)*
Buffers the full request body and `JSON.parse`s it, returning `{}` on any parse failure (malformed
JSON) rather than throwing — every route handler that reads `body.something` gets `undefined`
instead of an error for a bad request body, which is forgiving but means a client-side bug sending
malformed JSON fails silently/confusingly downstream rather than with a clear 400.

### `handleCors(res)` *(not exported)*
Responds to `OPTIONS` preflight requests. Not currently exercised by the frontend (same-origin,
same-port requests don't trigger CORS preflight) but present for any future cross-origin client.

### `serveIndexHtml(res)` *(not exported)*
Streams `index.html` for `/` and `/index.html`. No caching headers set — every request re-reads
the file from disk, which is irrelevant at this app's traffic scale (one browser tab, occasional
reloads) but worth knowing if this is ever load-tested or served to more than a couple of clients.

### `handleSseConnection(req, res)` *(not exported)*
Opens the long-lived `/api/events` SSE stream, sends an initial `stats` frame immediately (so a
freshly-loaded page doesn't sit blank until the next periodic broadcast), clears the album caches
(treating a fresh SSE connection as equivalent to "page was reloaded, get fresh album data next
time it's requested"), and registers the response in `sseClients` (removed on `req.on('close')`).

### `resolveEmailForTab(tab, account)` *(not exported)*
Per-account email cache with a critical invariant added this session: **a failed lookup never
overwrites a previously-successful one** — the cache only ever moves from "unknown" to "known," or
from "known" to a *different* known value on an actual new success, never back to unknown/null.
This exists because a backgrounded (not-currently-focused) Chrome tab is disproportionately likely
to fail a fresh lookup (Chrome deprioritizes rendering work in unfocused tabs, and this function's
underlying DOM scrape depends on that rendering having happened) — without this invariant, the
email for whichever account you're *not* currently looking at would periodically vanish from the
dropdown as its 30-second cache entry expired and a re-probe failed. See the inline comment and
this session's conversation history for the full bug report this fixes.

Uses an 8-second retry TTL for failures vs. 30 seconds for successes — a failed lookup gets
retried on roughly the next status poll (10s interval) rather than waiting the full success TTL.

### `resolveAllAccountEmails(photosTabs)` *(not exported)*
Resolves every distinct account currently represented by an open tab (deduped — if two tabs
happen to be on the same account, only the first is queried), not just whichever tab
`handleStatusRequest` considers "the current one." This is what lets the account-switcher dropdown
show every open account's email, not just the one you happen to be looking at.

### `handleStatusRequest(res)` *(not exported)*
The `/api/status` handler — polled every 10 seconds by every connected browser tab, and the single
most frequently-called non-SSE endpoint in the app. Returns manifest stats, ADB state, and CDP/
account state as one combined payload (`base` fields computed independent of CDP, so a CDP hiccup
never blanks out ADB/manifest info alongside it — see the inline comment). The `catch` branch
(added/fixed this session) still includes `knownEmails` and `selectedAccount` even on a CDP
failure, since building those needs no live CDP call — only a pure read of the in-memory cache —
so a transient `getCdpTabs()` failure no longer blanks the whole account dropdown for a poll cycle.

**Improve:** this function is not gated by `currentOp` (it's a `GET`, and the busy-check only
applies to `POST` routes in `handle()`) — it can and does run concurrently with any in-progress
operation, including ones that are actively opening/closing/navigating tabs
(`openAccountTabsStep`, `switchAccountStep`). This is the root cause class behind both account-
email bugs fixed this session; the fixes (short failure TTL, sticky success values) are mitigations
for the *symptoms* of unsynchronized concurrent access, not a fix for the underlying lack of
synchronization. A more thorough fix would have this function (or at least
`resolveAllAccountEmails`) skip its live CDP probing entirely while `currentOp` is truthy, relying
purely on cached data during that window — deliberately out of scope for this session's
narrowly-targeted bug fixes, but worth considering if a *third* variant of this same race surfaces.

### `handleAlbumsRequest(res)` *(not exported)*
The `/api/albums` handler — fetches the account's full album list and cross-references it against
the manifest to attach a `quotaCount` (how many of *this account's* quota items are in each album)
to every album, for the sidebar's per-album quota-item counts.

### `handleChromeInfoRequest(res)` *(not exported)*
The `/api/chrome-info` handler — whether the Chrome profile directory exists and its size on disk
(via `getDirSizeSync`), for the "Delete Profile" button's confirmation dialog.

### `buildOperationsMap(body)` *(not exported)*
The dispatch table mapping every `POST /api/*` pipeline-operation path to the step function that
handles it, closing over the already-parsed request `body`. Rebuilt on every request (cheap — it's
just object literal construction, not meaningfully worth memoizing) rather than being a
module-level constant, specifically because several entries need `body` values baked into their
closures (`scanFullStep(body)`, `matchAlbumsStep(body)` vs `matchManifestStep()` chosen by
`body.albumIds?.length`, etc.) — a module-level map would need every handler to take `body` as an
explicit late-bound argument instead.

**Improve:** adding a new operation means remembering to add it here *and* nowhere else forgets to
check `currentOp` first, since that check happens once in `handle()` before this map is even built
— that part's fine and consistent. What's easy to get wrong when adding an entry: forgetting that
every step function here is expected to always call `opStart`/`opEnd` on every exit path itself (per
architectural note #6's mention of this being convention, not enforced) — this map has no way to
verify that a newly-added step actually followed that convention.

### `handle(req, res)`
The single entry point every HTTP request flows through (`server.mjs`'s `http.createServer`
callback calls this directly). Static/GET routes are checked first with individual `if` statements
before falling through to the generic `POST`-only, `currentOp`-gated, `buildOperationsMap`-dispatched
path for everything else. The `ops[pathname]().catch(...)` handler is a genuinely important safety
net: if a step's own `async function` body throws *before* reaching its own `try` block (e.g.
`connectCdp()` failing inside a step that hasn't wrapped it — actually every current step does wrap
it, but a future one might not), this `.catch` is what still calls the real `opEnd()` to release
`currentOp`. Without it, a step that throws before its own try/catch would leave `currentOp` stuck
forever, permanently `409`-ing every future request until a server restart — the inline comment on
this exact line explains why it must be the *real* `opEnd()`, not just a broadcast that looks like
one, for exactly this reason.

---

## `server.mjs`

The process entry point — HTTP server setup and graceful shutdown. No exports; this file is never
imported by anything else.

### The `http.createServer` callback (anonymous)
Delegates every request to `handle()` (`api/router.mjs`), with one more safety net on top: if
`handle()` itself throws an *uncaught* rejection (shouldn't happen given `handle()`'s own
try/catches on every route, but this is the last line of defense), logs it and responds 500 —
guarded by `!res.headersSent` since a response can't be sent twice.

### `shutdown(signal)`
Registered for both `SIGINT` (Ctrl+C) and `SIGTERM`. Idempotent (`shuttingDown` flag — a second
signal while already shutting down is a no-op rather than double-running cleanup). Kills every
Chrome process this server spawned, explicitly ends every open SSE connection (`res.end()` —
without this, `server.close()`'s callback would never fire, since a live SSE connection counts as
an open connection keeping the server alive), then closes the HTTP server and exits. A 2-second
watchdog `setTimeout(() => process.exit(0), 2000).unref()` forces the exit even if `server.close()`
somehow hangs (e.g. some other connection type not accounted for above) — `.unref()`'d so it
doesn't itself keep the process alive if the clean path finishes first.

**Improve:** binds `0.0.0.0` (`server.listen(PORT, '0.0.0.0', ...)`), not `127.0.0.1` — see
architectural note #2. This is the one line that would need to change (plus, likely, adding some
minimal auth) if this app's exposure model ever needs to change from "single trusted user on this
machine."

---

## Frontend — `index.html`'s `<script>` block

Roughly 2100 lines of vanilla JS, no framework, no build step, no module system (every function is
a plain global in one `<script>` tag) — see [frontend.md](frontend.md) for the broader structural
notes (i18n system shape, SSE event wiring, layout). This section documents every function; skip
straight to a name via your editor's search rather than reading top to bottom.

**A general note before the per-function list:** every function here is a bare global — there's no
module boundary preventing any function from calling any other, and no way to `import` a subset of
this file elsewhere. That's a deliberate simplicity tradeoff (documented in `CLAUDE.md`:
"Зависимости: только `ws`" — the whole project has almost no dependencies, by design) that's
appropriate for a single-page tool of this size, but means every rename/removal (like this
session's `toggleAlbum` dead-code removal) has to be verified by grepping the whole file rather
than relying on any tooling to catch a broken reference — worth remembering before renaming
anything here.

### i18n core

#### `t(key, ...args)`
The translation lookup every piece of UI text goes through: looks up `key` in the current
language's block, falling back to `en` if missing, calling it as a function (passing `args`
through) if the value is a function (for pluralized/interpolated strings like `(n) => \`${n}
items\``), otherwise returning the raw string. Falls back to the key itself if even `en` is
missing it — so a missing translation shows as a raw key name in the UI (ugly but discoverable)
rather than `undefined` or a blank string.

#### `setText(id, text)` / `setHtml(id, html)`
Tiny `getElementById` + `textContent`/`innerHTML` setters, null-safe (no-op if the element doesn't
exist) — used throughout `applyLang()` and elsewhere to avoid repeating the null-check at every
call site.

**Improve:** `setHtml` is used with `t()`-sourced content in a couple of places (`step2-note`,
`step3-desc`) — since every string in `LANGS` is authored by the project maintainer (not
user-supplied), this isn't an XSS risk today, but it does mean adding a new translated string with
`setHtml` requires remembering it's HTML-interpreted, not plain text — a stray `<`/`&` in a future
translation would render broken rather than erroring.

#### `setLang(l)`
Switches the active language: persists to `localStorage`, re-runs `applyLang()` (re-labels every
static UI string) plus `updateStepStats`/`updateButtonStates` (since some step-status text is
composed dynamically from `t()` calls outside `applyLang()`'s own pass — see `updateStepStats`).

#### `buildPopups()`
(Re)builds the `POPUPS` lookup table (CDP/ADB/Chrome/Albums help popups) from the current
language's strings — called once at init and again at the end of every `applyLang()`, so switching
language mid-session updates any popup content too, not just the always-visible UI chrome.

### Language dropdown

#### `toggleLangDropdown()` / `closeLangDropdown()`
Open/close the language picker dropdown by toggling an `.open` CSS class on both the menu and its
trigger button. A document-level click listener (registered once, not itself a named function)
closes the dropdown when a click lands outside it.

### Theme

#### `toggleThemeDropdown()` / `closeThemeDropdown()`
Same open/close pattern as the language dropdown, independent state/elements.

#### `setThemeMode(mode)` / `setAccent(accent)` / `setShade(shade)` / `setShadeLight(shade)`
Each updates one piece of theme state, persists it to `localStorage`, and calls `applyTheme()` to
re-render. Four near-identical functions differing only in which variable/storage-key they touch.

**Improve:** these four are simple enough that consolidating them (e.g. one `setThemePref(kind,
value)` dispatching on `kind`) would save a little repetition, but at the cost of a slightly less
direct `onclick="setThemeMode('dark')"` call site — genuinely a toss-up, not a strong
recommendation either way.

#### `applyTheme()`
Reads the four theme state variables (`themeMode`, `themeAccent`, `themeShade`, `themeShadeLight`)
and applies them as `data-*` attributes on `<html>` (which the `<style>` block's CSS selectors key
off of — see `index.html`'s CSS custom-property blocks), then updates every theme-picker UI
element's `.active` class and label text to match. Dark and light modes keep independent shade
preferences (switching mode doesn't lose the other mode's shade choice) — the two shade rows are
shown/hidden based on current mode rather than one shared control.

#### `applyLang()`
The big one: re-labels essentially every static piece of UI chrome (buttons, headers, tooltips,
popup content) by calling `setText`/`setHtml` with `t()`-sourced strings for every translatable
element in the page, plus re-applies the current theme labels and rebuilds the popups. Called once
at init and again on every `setLang()`. If a new translatable UI element is added to the markup,
it needs a corresponding `setText`/`setHtml` call added here too — there's no automatic
"translate every element with a `data-i18n-key`" mechanism; each one is wired by hand.

**Improve:** this manual wiring (one `setText` call per translatable element, ~50 of them) is the
single most repetitive-looking function in the file and the easiest place for a future addition to
forget a call site (add a new button's markup, forget to add its `setText` line here — it'll just
silently keep whatever hardcoded English text was in the markup). A `data-i18n="keyName"` attribute
convention plus one generic `document.querySelectorAll('[data-i18n]').forEach(...)` loop would
remove this entire category of "forgot to wire it up" bug, at the cost of a larger one-time
refactor of the existing markup. Worth doing if this file grows much further; not urgent at the
current size.

### Popups & modals

#### `showPopup(id)`
Looks up `id` in `POPUPS`, fills the popup overlay's title/body, gives it a single "Got it" button,
marks it dismissable (click-outside or Escape closes it), and shows it.

#### `showModal({ title, body, buttons })`
The general-purpose confirmation/action modal (used for the Trash & Push confirmation, Reset All
confirmation, and the "files pushed — restore account" / "cleanup done" informational modals).
Builds one `<button>` per entry in `buttons`, each wired to close the modal and then run its
`action` callback. Marked *not* dismissable by click-outside/Escape (`modalDismissable = false`) —
deliberately forcing an explicit button choice for anything important enough to use this instead
of `showPopup`.

#### `closePopup()`
Hides the popup overlay — shared by both `showPopup` and `showModal`'s content (they reuse the
same overlay element, just with different content/button-set/dismissability).

### SSE

#### `connectSSE()`
Opens the `EventSource` to `/api/events` and wires its `onmessage` handler — the single dispatch
point for every real-time update this app receives: `log` (append a line), `stats` (update stat
cards + `refreshOpenViewerIfNeeded`), `opStart`/`opEnd` (step indicators, button states, and a
handful of `msg.name === '...'` special cases for post-operation modals and follow-up actions —
see the inline comments on each). Reconnects automatically after 3s on error (`EventSource`'s
native reconnection also exists but this adds an explicit fallback).

**Improve:** the `opEnd` handler's body is a growing sequence of `if (msg.name === '...')` special
cases (switch-account/open-account-tabs → refresh status, trash-reupload → maybe show a modal,
cleanup-pixel → maybe show a modal, reset-all → reset step indicators). Each addition this session
was a reasonable, minimal, targeted change in isolation, but the function is accumulating
special-cased branches rather than a more extensible dispatch structure (e.g. a
`{ opName: handlerFn }` map similar to `OP_TO_STEP` or the backend's `buildOperationsMap`). Not
worth restructuring preemptively, but worth doing if a few more op-specific behaviors get added
here.

### Step indicators

#### `getStepNum(opName)`
`OP_TO_STEP[opName]` lookup — returns `undefined` for any op with no dedicated pipeline step
(`push`, `repush`, `switch-account`, `open-account-tabs`, `reset-verify`, etc.), which
`setStepRunning`/`setStepDone` both treat as "no step indicator to update," a deliberate no-op.

#### `setStepRunning(opName)` / `setStepDone(opName, ok)`
Update the numbered circle's CSS class/glyph for whichever step an operation maps to (● running,
✓/✗ done/error) — called from the SSE `opStart`/`opEnd` handlers.

### Status polling

#### `refreshStatus()`
Polled every 10 seconds (`setInterval` at the bottom of the file) plus called ad hoc after
specific operations complete (see `connectSSE`'s `opEnd` handler). Fetches `/api/status` and
updates essentially every "live" piece of chrome: the CDP badge (connected/mismatch/color +
account email label), the account switcher dropdown, the ADB badge and device selector, the
manifest stats, and the work-dir/downloads-count labels. Wrapped in a bare `try { ... } catch {}`
— any failure (network error, unexpected response shape) is silently swallowed, leaving the UI
showing its last-known-good state rather than erroring visibly. This is a deliberate choice
(matches the backend's "don't let a transient hiccup blank the UI" philosophy from this session's
bug fixes) but does mean a *persistent* failure (not just a transient one) would also stay silent
indefinitely, with no "connection lost" indicator beyond the CDP badge itself eventually going red
on the next successful-enough poll.

#### `updateAccountSwitcher(r)`
Renders the account-switcher `<select>`'s options (annotating each `/u/N/` value with its known
email, if any) and syncs its selected value to the pinned account (preferred) or whatever the
connected tab reports (fallback), disabling it while any operation is busy and setting its tooltip
to a mismatch warning if `r.accountMismatch` is set.

#### `onAccountSwitch()`
The `<select>`'s `onchange` handler — fires `/api/switch-account` and logs any *dispatch-time*
error (a `409 busy`, say). Does **not** wait for or poll for the actual switch completion — that's
handled by `connectSSE`'s `opEnd` hook now (see this session's fix for the race this used to have,
when it instead used a blind `setTimeout`).

### ADB device selector

#### `updateAdbDeviceSelect(devices)`
Renders the ADB device `<select>` from the current device list — hides it entirely if no usable
(`state === 'device'`) devices exist, logging a one-time warning (via the `adbUnauthorizedWarnShown`
flag, to avoid re-logging every 10-second poll) if devices exist but are stuck
unauthorized/offline. Only actually *shows* the dropdown as a meaningful selector once there's more
than one usable device — a single device doesn't need explicit selection since the backend's
no-`device`-given fallback already targets it correctly.

#### `onAdbDeviceChange()`
The device `<select>`'s `onchange` handler — persists the chosen serial to `localStorage` (or
clears it if de-selected).

### Stats & button states

#### `updateStats(s)`
Sets every stat-card number from the latest manifest stats object, then delegates to
`updateStepStats`, `updateStepDoneFromStats`, and `updateButtonStates` — the three functions that
actually translate raw counts into UI state (text, done-checkmarks, enabled/disabled).

#### `updateStepDoneFromStats(s)`
Derives each step's "done" checkmark purely from manifest counts (`quota > 0` → step 1 done,
`downloaded >= quota` → step 2 done, etc.) — but **only for steps not already marked done**, and
never *un*-marks an already-done step from this derivation alone (a step only leaves "done" by
actually running again, which `setStepRunning` unconditionally overrides to "running," or by an
explicit reset). This asymmetry exists specifically because a step can legitimately finish with
zero items affected (e.g. "no items to restore") and still be genuinely done — deriving done-ness
from a count alone would incorrectly un-mark that the instant this function next runs after
`opEnd` already set the checkmark.

#### `updateStepStats(s)`
Composes the human-readable status line under each step's name — this is where the merged step 1's
combined "N albums selected — M quota items found" (or "Full library scan — ready to scan") text is
built, by concatenating existing `t()`-sourced fragments with an em dash rather than needing
dedicated combined-text translation keys for every mode × state combination (see this session's
work merging steps 1 and 2 — the fragment-reuse approach was a deliberate choice to avoid a
combinatorial explosion of new i18n keys).

#### `updateButtonStates()`
The single function that decides every button's enabled/disabled state, called after nearly every
state change (stats update, SSE opStart/opEnd, language switch, scan-mode toggle, album selection
change). Each button's condition is independent and inline (e.g. `setBtn('btn-verify', (s.total ??
0) > 0 && (s.quota ?? 0) > 0)`) — there's no shared "step readiness" abstraction beyond
`setStepReady` for the numbered-circle indicators; button-enablement and circle-readiness are two
separate, independently-maintained sets of conditions that happen to often (not always) agree.

**Improve:** worth double-checking whenever a button's gating condition changes (as happened
several times this session — the Verify button's condition changed at least twice as its underlying
semantics evolved) that the corresponding `setStepReady` call (if any) for the same step was
updated to match, since nothing enforces they stay in sync — they're independent statements of the
same underlying "is this ready" fact, checked separately, by hand.

#### `setStepReady(n, ready)`
Sets step `n`'s circle to the "ready" (accent-colored, not yet started) state — but only if it's
not already `done`/`running`/`error`, so a completed step's checkmark is never overwritten by a
readiness recalculation.

### Albums sidebar

#### `loadAlbums()`
Fetches `/api/albums`, replaces the sidebar's album list, logs success/failure. Simple async
fetch-and-render with a loading-state button label swap.

#### `renderAlbums()`
Builds the album checkbox list's HTML from the `albums` array — each row shows the album's title,
a plain item count (if no quota items in it) or a highlighted quota-item badge plus the remaining
non-quota count (if it has any). Calls `onAlbumChange()` at the end to sync selection-dependent UI
to the freshly-rendered (all-unchecked) state.

#### `onAlbumChange()`
The shared handler for "album selection changed" (wired as every checkbox's own native `onchange`)
— updates the selected-count label and re-derives step stats/button states, since album selection
feeds directly into step 1's readiness and status text.

#### `getSelectedAlbumIds()`
Reads the DOM directly (`:checked` checkboxes in `#albumList`) rather than maintaining separate
selection state — the checkboxes themselves *are* the source of truth for what's selected, with no
shadow copy that could drift out of sync.

#### `selectAll()` / `selectNone()`
Bulk-check/uncheck every album checkbox, then call `onAlbumChange()` once to sync derived state —
not per-checkbox, just once at the end.

### Operations (POST wrappers)

#### `post(path, body)`
The one shared `fetch(..., { method: 'POST', ... }).then(r => r.json())` wrapper every operation
call goes through. No timeout, no retry — a hung request (server unresponsive) just hangs the
calling `await` indefinitely, same class of gap as `CdpSession.send()`'s lack of a timeout on the
backend.

#### `adbDeviceBody()`
Builds `{ device: selectedAdbDevice }` (or `{}` if none selected) — the fragment every
ADB-touching operation's POST body needs to spread in, so the backend targets the
currently-selected device rather than whatever its own single-device fallback would pick.

#### `runOp(name)`
The generic "just POST `/api/<name>` with the ADB device body" wrapper — used by every simple,
no-special-handling operation (`verify`, `restore-albums`, `cleanup-pixel`). Operations that need
extra logic (confirmation modals, extra body fields, non-standard endpoints) have their own
dedicated function instead (see below) rather than being forced through this one.

#### `runScanFull()`
Builds `/api/scan-full`'s body based on `scanMode` (`{}` for "all library" vs. `{ albumIds }` for
album-scoped) — the frontend half of the scan-mode toggle's actual effect.

#### `setScanMode(mode)`
Updates `scanMode`, the toggle button's `.active` class, and re-derives step stats/button states.
The toggle's own click handlers call this directly; it's the single source of truth for which mode
is active (no separate hidden `<input>` backing it, unlike the old checkbox this replaced).

#### `runTrashReupload()`
Shows the destructive-action confirmation modal first (`showModal`), only firing
`/api/trash-reupload` if the user confirms — the one place `awaitingPixelRestore` gets set to
`true`, which `connectSSE`'s `opEnd` handler checks afterward to decide whether to show the
"restore your account on the Pixel now" follow-up modal.

#### `runRepush()` / `runPush()`
Thin wrappers posting to `/api/repush`/`/api/push` respectively, with the concurrency setting and
ADB device body — no confirmation modal (both are non-destructive, unlike trash-reupload).

#### `stopTrashReupload()`
Posts `/api/stop` and immediately disables the Stop button with a "Stopping..." label — the actual
stop confirmation comes later via the normal `opEnd` SSE event once the running operation's worker
loop notices `isStopRequested()` and exits.

#### `matchAlbums()`
Posts `/api/match` with an empty body — note this is the button wired to the *plain* match path
(`matchManifestStep`, not `matchAlbumsStep`); despite the function's name, it doesn't pass
`albumIds`, so the backend's `body.albumIds?.length ? matchAlbumsStep : matchManifestStep` branch
always takes the `matchManifestStep` side from this particular call site.

**Improve:** this function's name (`matchAlbums`) is a little misleading given it never actually
triggers the album-scoped match path from the current UI — worth a rename (e.g. `runMatch`) or a
comment, since a future reader skimming function names would reasonably assume this is the
album-aware one.

#### `runDownload()`
Posts `/api/download` with an empty body (no `mediaKeys` scoping) — the main step 2 "Download"
button's handler, distinct from `downloadViewerItems()` below (the scoped variant).

#### `downloadViewerItems()`
The "Download these" button inside the unverified-items viewer (added this session) — scopes the
download to exactly the currently-filtered/visible viewer rows (`_viewerFiltered` if a search is
active, else all of `_viewerItems`), further filtered to items missing a local file
(`!i.downloaded`). No-ops silently if nothing in the current view needs downloading.

#### `resetManifest()`
Confirms, then posts `/api/reset-manifest`, then manually resets every step circle to its neutral
number (this one doesn't wait for an SSE `opEnd` since `/api/reset-manifest` is a synchronous
inline handler in the backend, not a queued/`opStart`-tracked operation — see
`buildOperationsMap`'s special-cased entry for it).

#### `resetVerify()`
Confirms, then posts `/api/reset-verify` — no manual step-reset here (unlike `resetManifest`),
since this operation *does* go through the normal `opStart`/`opEnd` SSE lifecycle and the resulting
`stats` broadcast naturally updates everything that needs updating.

#### `resetAll()`
Shows the Reset All confirmation modal, posts `/api/reset-all` on confirm. Step-indicator reset
happens via the SSE `opEnd` handler's `msg.name === 'reset-all'` special case, not here directly —
deliberately, per the inline comment, since this POST only *queues* the operation rather than
waiting for it to finish.

#### `launchChrome()`
Posts `/api/launch-chrome`, then (this session's addition) immediately chains a second POST to
`/api/open-account-tabs` — the backend handles all the actual waiting/probing/tab-management; this
function's job is just to dispatch both and log any dispatch-time errors. The button's own
disabled/loading state is released in a `finally` block right after the *first* POST resolves
(nearly instant, since `launchChrome()` on the backend just spawns a process) — well before the
second, much longer-running operation actually finishes; that's intentional (the button being
clickable again quickly is fine, since a second click would just queue behind the still-running
`open-account-tabs` op and get a `409`), but worth knowing if this function's structure is ever
changed.

#### `deleteProfile()`
Confirms (showing the profile's size, fetched fresh from `/api/chrome-info` first) then posts
`/api/delete-profile`, refreshing the Chrome-info display afterward.

#### `loadChromeInfo()`
Fetches `/api/chrome-info` and shows/hides + labels the "Delete Profile" button accordingly.
Called at init and after any operation that might change the profile's existence/size
(`launchChrome`, `deleteProfile`).

### Log panel

#### `appendLog(text, level)`
Appends one line to the visible log panel (capped at 2000 rendered DOM nodes — older lines are
evicted from the DOM, not from `logHistory`) and to `logHistory` (capped separately at 20000
entries) — the two caps exist independently specifically so "Save Log" can export more history than
what's currently rendered on screen, without keeping an unbounded DOM.

#### `clearLog()`
Empties both the visible log and `logHistory` together — the one place both caps are cleared in
sync (unlike normal appending, where they're maintained independently).

#### `saveLog()`
Exports `logHistory` as a `.txt` file — prefers the File System Access API
(`showSaveFilePicker`, Chrome/Edge-only, lets the user pick the exact save location) with a
same-origin download-link fallback (`Blob` + synthetic `<a download>` click) for any browser
without it. Treats a user cancelling the native save picker (`AbortError`) as a silent no-op, not
an error.

### Collapsible panels

#### `toggleAlbumsSidebar()` / `toggleLogPanel()`
Toggle a CSS class on `<main>` that collapses the respective panel, persisting the choice to
`localStorage`.

#### `restorePanelCollapseState()`
Applies saved collapse preferences on load. The albums sidebar has a third case beyond
"saved collapsed" / "saved expanded": **no saved preference at all** (this browser has never
touched the toggle) — in that case, it starts expanded and auto-collapses after 5 seconds (added
this session, so a first-time user notices the sidebar exists before it tucks itself away), with a
click on the toggle button within that window cancelling the auto-collapse and standing as the
user's real preference from then on.

### Manifest viewer

#### `computeViewerItems(kind, manifest)`
Pure filter function mapping a viewer "kind" (`scanned`/`unmatched`/`unverified`) to the matching
subset of manifest items — the single source of truth for what each of the three viewer buttons
shows, shared between the initial open and every live-refresh.

#### `openViewerForKind(kind, title)`
Fetches the current manifest, sets `_viewerKind`, and opens the viewer with the computed item set
— the entry point for all three `showXItems()` wrapper functions below.

#### `showScannedItems()` / `showUnmatchedItems()` / `showUnverifiedItems()`
One-line wrappers calling `openViewerForKind` with the appropriate kind/title — exist purely so the
three "View" buttons in the markup have distinctly-named `onclick` targets rather than all calling
`openViewerForKind` with inline arguments (a style choice, not a functional necessity).

#### `refreshOpenViewerIfNeeded()`
Called on every SSE `stats` event — if a viewer is currently open, silently re-fetches the
manifest and re-renders in place (preserving the search box's current value and scroll position,
unlike `openViewer` which resets both). This is what makes the unverified-items viewer update live
as `verifyStep` confirms items mid-run, added this session specifically to support that.

#### `openViewer(title, items)`
The initial-open path (as opposed to `refreshOpenViewerIfNeeded`'s in-place refresh): resets the
search box, wires its `oninput` handler, renders, shows the overlay, and focuses the search box
after a short delay (letting the `display: flex` take effect first, so focus doesn't fail on a
still-hidden element).

#### `renderViewerItems(items, query)`
Filters `items` by `query` (matching filename or any album title, case-insensitive substring),
renders each row's HTML (quality badge, archived badge, size, album tags), updates the count label,
and — this session's addition — updates the "Download these" button's visibility/label/enabled
state (only shown for the `unverified` kind, counting how many *currently filtered* rows still need
downloading). `_viewerFiltered` is updated here as a side effect, which is what
`downloadViewerItems()` later reads.

#### `escHtml(s)`
Basic HTML-entity escaping (`& < > "`) for any user/Google-sourced string (filenames, album titles)
interpolated into viewer row HTML — the one place in this file doing manual escaping rather than
`textContent`, because the row markup mixes escaped dynamic content with static HTML structure in
one template string.

#### `closeViewer()`
Hides the overlay and clears `_viewerKind` — this is what stops `refreshOpenViewerIfNeeded` from
doing any more work on subsequent SSE events once the viewer is closed.

### Init (top-level statements, not functions)

The bottom of the file runs, in order: `buildPopups()`, `applyLang()`, `restorePanelCollapseState()`,
`connectSSE()`, `refreshStatus()`, `loadChromeInfo()`, then starts the 10-second `refreshStatus`
polling interval. This ordering matters a little — `applyLang()` needs to run before
`restorePanelCollapseState()` only insofar as the collapse-state function reads `t()` for button
titles, and `connectSSE()` before `refreshStatus()` isn't strictly required (both are independent
fetches) but keeps the "live updates" channel opening before the first snapshot fetch, which feels
like the more sensible order for a reader.
