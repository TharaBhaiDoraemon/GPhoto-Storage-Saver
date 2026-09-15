# Dead code audit — 2026-09-14

Full sweep of `source/` for code that's defined but never actually used. Nothing that's
in use was touched or rewritten — this is removals only.

## What was checked

- **Backend exports** (`export function/const/class` in every `.mjs` file): traced each one
  to a real call site in another file. All were genuinely used except the three imports below.
- **Backend local helpers** (non-exported `function` in each file): checked each is called at
  least once within its own file. None were dead.
- **Backend imports**: checked every named import is actually referenced (not just imported)
  in the file that imports it.
- **Frontend JS functions** (`index.html`'s `<script>` block): checked every top-level
  `function` declaration has a real call site (an `onclick=`/`onchange=` attribute or a call
  from other JS).
- **Frontend top-level variables** (`let`/`const`): same check.
- **CSS classes**: every class selector in `<style>` checked against the markup and any
  JS `className`/`classList` usage (including template-literal-constructed class names, e.g.
  `` `log-${level}` ``).
- **i18n keys**: every key in the `en:` block of `LANGS` checked against a matching `t('key')`
  call site.
- **`getElementById()` calls**: cross-checked against actual element `id`s in the markup, to
  catch JS left over from a refactor that points at markup which no longer exists.
- **Docs**: grepped for references to already-removed identifiers (`chkScanAll`,
  `scanAllAltDot`, `step1Skipped`, etc. from the step-1/step-2 merge earlier this session).

## Removed (confirmed unused)

- **`toggleAlbum(id)`** (`index.html`) — declared, never called. The album checkbox rows use
  their own native `onchange="onAlbumChange()"` handler directly; this function looks like a
  leftover from an earlier version where the whole row (rather than just the checkbox) toggled
  selection by hand.
- **Three unused imports in `api/router.mjs`**:
  - `execSync` (from `child_process`) — no exec calls happen in this file; all shelling out is
    encapsulated in `lib/adb.mjs` / `lib/chrome.mjs`, which this file already imports and uses.
  - `writeManifest` (from `lib/manifest.mjs`) — `/api/reset-manifest` deletes the manifest file
    directly (`fs.unlinkSync`) rather than writing an empty array back.
  - `ADB_PATH` (from `lib/config.mjs`) — this file never touches the ADB binary path directly;
    that's encapsulated in `lib/adb.mjs`'s own functions (`hasAdbBinary()`, `checkAdb()`, etc.),
    which it already imports instead.

## Found but intentionally left alone

- **`/api/enrich` (`steps/enrichStep.mjs`)** — not called from any UI button in `index.html`,
  but it's a real, working, documented standalone endpoint (`CLAUDE.md`'s steps table calls it
  out explicitly as "standalone dedupKey enrich" — a manual/API-only utility to backfill
  `dedupKey`s without a full re-scan). Not dead code, just not wired to a button. Left as-is.

## Not found

No unused CSS, no unused i18n keys, no `getElementById()` calls pointing at nonexistent
elements, no other unused backend exports/imports/local functions, no unused top-level frontend
variables, and no stale doc references to already-removed features.
