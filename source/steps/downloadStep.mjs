import path from 'path';
import { createWriteStream } from 'fs';
import { mkdir, stat } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, callRpc } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { log, opStart, opEnd, isStopRequested } from '../lib/sse.mjs';
import { DOWNLOADS_DIR } from '../lib/config.mjs';

// pLFTfd resolves a mediaKey to a signed, short-lived original-quality download
// URL. The URL is buried at an unpredictable depth in the response array, so we
// just walk it looking for the first https:// string.
function findUrl(obj, depth = 0) {
  if (depth > 5) return null;
  if (typeof obj === 'string' && obj.startsWith('https://')) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function getDownloadUrl(cdp, tokens, mediaKey) {
  const payload = await callRpc(cdp, 'pLFTfd', [[mediaKey], [1]], tokens, { allowEmpty: true });
  return payload ? findUrl(payload) : null;
}

function safeFsName(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '_');
}

// Files are named after item.filename, so a collision (two items sharing a
// filename) needs a disambiguating suffix — mirrors the naming scheme
// matchManifestStep expects when linking pre-downloaded files.
function buildUniqueNamer(manifest) {
  const nameCounts = new Map();
  for (const item of manifest) {
    const name = item.filename || `${item.mediaKey}.bin`;
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  return (item) => {
    const filename = item.filename || `${item.mediaKey}.bin`;
    const safe = safeFsName(filename);
    if ((nameCounts.get(filename) || 0) > 1) {
      const ext = safe.includes('.') ? safe.slice(safe.lastIndexOf('.')) : '';
      const base = safe.includes('.') ? safe.slice(0, safe.lastIndexOf('.')) : safe;
      return `${base}_${item.mediaKey.slice(-8)}${ext}`;
    }
    return safe;
  };
}

export async function downloadStep({ concurrency = 3, mediaKeys } = {}) {
  opStart('download');
  let cdp;
  try {
    cdp = await connectCdp();
    const manifest = readManifest();
    // mediaKeys, when given, scopes the run to exactly those items (e.g. "download these" from
    // the unverified-items viewer) instead of every not-yet-downloaded quota item.
    const items = manifest.filter(i =>
      i.mediaKey && i.consumesQuota && !i.downloaded &&
      (mediaKeys ? mediaKeys.includes(i.mediaKey) : true)
    );
    if (!items.length) {
      const msg = 'No items to download';
      log(msg, 'success');
      opEnd('download', true, msg);
      return { ok: true, downloaded: 0 };
    }
    await mkdir(DOWNLOADS_DIR, { recursive: true });

    const tokens = await getTokens(cdp);
    // Fetched Node-side (not through the browser) — a plain signed GET plus the
    // browser's session cookies is enough, no need to inject via CDP like the
    // batchexecute RPC calls do.
    const cookiesResp = await cdp.send('Network.getCookies', {
      urls: ['https://photos.google.com', 'https://video-downloads.googleusercontent.com'],
    });
    const cookieHeader = cookiesResp.cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const getUniqueName = buildUniqueNamer(manifest);
    log(`Downloading ${items.length} items directly (no Takeout needed)...`);

    const poolSize = Math.max(1, Math.min(concurrency, 6));
    let counter = 0, done = 0, errors = 0, wasStopped = false;
    const iter = items[Symbol.iterator]();

    async function worker() {
      for (;;) {
        if (isStopRequested()) { wasStopped = true; break; }
        const { value: item, done: iterDone } = iter.next();
        if (iterDone) break;

        const n = ++counter;
        const label = item.filename || item.mediaKey.slice(0, 16);
        try {
          const url = await getDownloadUrl(cdp, tokens, item.mediaKey);
          if (!url) throw new Error('No download URL in response');

          const resp = await fetch(url, { headers: { Cookie: cookieHeader }, redirect: 'follow' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const outPath = path.join(DOWNLOADS_DIR, getUniqueName(item));
          await pipeline(Readable.fromWeb(resp.body), createWriteStream(outPath));
          const { size } = await stat(outPath);
          if (item.sizeBytes && Math.abs(size - item.sizeBytes) > 1024) {
            log(`  Warn: size mismatch for ${label} (got ${size}, expected ${item.sizeBytes})`, 'warn');
          }

          item.downloaded = true;
          item.downloadedAs = outPath;
          item.downloadedBytes = size;
          item.downloadedAt = new Date().toISOString();
          done++;
          log(`[${n}/${items.length}] ✓ ${label} (${(size / 1024 / 1024).toFixed(2)} MB)`);
        } catch (err) {
          log(`[${n}/${items.length}] ✗ ${label}: ${err.message}`, 'error');
          errors++;
        }
        if ((done + errors) % 10 === 0) writeManifest(manifest);
      }
    }

    await Promise.all(Array.from({ length: poolSize }, worker));
    writeManifest(manifest);

    const summary = wasStopped
      ? `Stopped. ${done} downloaded, ${errors} errors, ${items.length - done - errors} skipped.`
      : `Downloaded ${done}/${items.length} items${errors ? `, ${errors} errors` : ''}.`;
    log(summary, wasStopped || errors > 0 ? 'warn' : 'success');
    opEnd('download', !wasStopped && errors === 0, summary);
    return { ok: true, downloaded: done, errors, stopped: wasStopped };
  } catch (err) {
    log(`Download failed: ${err.message}`, 'error');
    opEnd('download', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp?.close(); }
}
