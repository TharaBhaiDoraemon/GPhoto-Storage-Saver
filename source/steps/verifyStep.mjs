import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, callRpc, batchQuotaInfo } from '../lib/rpc.mjs';
import { readManifest, writeManifest, manifestStats } from '../lib/manifest.mjs';
import { log, opStart, opEnd, broadcast } from '../lib/sse.mjs';

function buildFilenameToItemMap(items) {
  const map = new Map();
  for (const i of items) {
    const name = (i.pushedAs || i.filename).toLowerCase();
    map.set(name, i);
    // Also index without extension as fallback
    const noExt = name.replace(/\.[^.]+$/, '');
    if (noExt !== name && !map.has(noExt)) map.set(noExt, i);
  }
  return map;
}

function applyQuotaInfo(item, qi, newMediaKey) {
  if (item.verified === true) return null; // already confirmed — skip
  if (qi?.[30]?.[0] !== 1 && qi?.[14] === 2) {
    item.verified = true;
    item.newMediaKey = newMediaKey ?? qi?.[0];
    item.verifiedAt = new Date().toISOString();
    return item.mediaKey;
  }
  item.verified = false;
  item.verifyNote = qi?.[30]?.[0] === 1 ? 'Still takes space' : 'Not original quality';
  return null;
}

// lcxiM occasionally throws (WS/network hiccup) or returns an empty response (no wrb.fr) on a
// transient blip, not because the library actually ended — pagination truly ends via pageToken
// going null. Retry a few times before giving up, so a blip doesn't kill or silently truncate
// a run that may already be hundreds of pages in.
async function fetchLibraryPage(cdp, tokens, pageToken, page) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      log(`Retrying page ${page + 1} (${attempt}/3)...`, 'warn');
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
    try {
      const payload = await callRpc(cdp, 'lcxiM', [pageToken, null, 500, null, 1, 1], tokens, { allowEmpty: true });
      if (payload) return payload;
      lastErr = new Error('empty response');
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`lcxiM failed repeatedly at page ${page + 1} (${lastErr.message}) — Google may be rate-limiting; try again shortly.`);
}

export async function verifyStep() {
  opStart('verify');
  let cdp;
  try {
    cdp = await connectCdp();
    const manifest = readManifest();
    // verified !== true includes both undefined (not yet tried) and false (tried but still
    // consuming quota) — we want to re-check false items on subsequent runs.
    // consumesQuota (not just reuploadComplete) so this also works as a plain cross-account
    // presence check: scan account A (e.g. with "Scan all library"), switch Chrome to account B
    // via /api/switch-account, then Verify — it matches those filenames/dedupKeys against
    // whichever account is currently connected, without requiring this tool's own
    // trash+reupload to have run first.
    const items = manifest.filter(i => i.consumesQuota && i.verified !== true);
    if (!items.length) {
      const msg = 'No items to verify';
      log(msg, 'success');
      opEnd('verify', true, msg);
      return { ok: true, verified: 0 };
    }
    log(`Verifying ${items.length} items...`);
    const tokens = await getTokens(cdp);
    const nameMap = buildFilenameToItemMap(items);
    // dedupKey → item map for fast candidate lookup on each lcxiM page
    const dedupKeyMap = new Map(items.filter(i => i.dedupKey).map(i => [i.dedupKey, i]));

    function applyPageResults(qis, pageMediaMap, verified) {
      for (const qi of qis) {
        const newMediaKey = qi?.[0];
        const fname = (qi?.[2] ?? '').toLowerCase();
        const noExt = fname.replace(/\.[^.]+$/, '');
        let item = nameMap.get(fname) || nameMap.get(noExt);
        // Fallback: match via dedupKey from the lcxiM item
        if (!item && dedupKeyMap.size > 0) {
          const rawItem = pageMediaMap.get(newMediaKey);
          if (rawItem?.[3]) item = dedupKeyMap.get(rawItem[3]);
        }
        if (!item) continue;
        const key = applyQuotaInfo(item, qi, newMediaKey);
        if (key) verified.add(key);
      }
    }

    // Freshly re-uploaded items land near the front of a newest-first library listing, so most
    // runs resolve within the first few pages — stop as soon as every target is accounted for
    // instead of always walking the whole library (that's what makes this loop expensive and,
    // by extension, more exposed to failing partway through on a large library).
    const verified = new Set();
    let pageToken = null, page = 0, pending = null;

    async function drainPending() {
      if (!pending) return;
      const { qis, pageMediaMap } = await pending;
      pending = null;
      applyPageResults(qis, pageMediaMap, verified);
      // Persist as we go — a later failure shouldn't discard matches already found.
      writeManifest(manifest);
      // Broadcast so the frontend's stat cards and any open "not verified" viewer update live,
      // item-by-item, instead of only jumping once at opEnd.
      broadcast('stats', { stats: manifestStats(manifest) });
    }

    do {
      const payload = await fetchLibraryPage(cdp, tokens, pageToken, page);
      const pageItems = payload?.[0] ?? [];
      pageToken = payload?.[1] ?? null;
      page++;
      log(`Fetched page ${page} (${pageItems.length} items)`);

      // Process the previous page's quota results while this page's fetch was in flight —
      // keeps a page of overlap for throughput without buffering the whole library in memory.
      await drainPending();
      if (verified.size >= items.length) break;

      const candidateKeys = pageItems.map(i => i?.[0]).filter(Boolean);
      if (candidateKeys.length > 0) {
        const pageMediaMap = new Map(pageItems.filter(i => i?.[0]).map(i => [i[0], i]));
        pending = batchQuotaInfo(cdp, tokens, candidateKeys).then(qis => ({ qis, pageMediaMap }));
      }
    } while (pageToken);
    await drainPending();

    const allDone = verified.size >= items.length;
    const summary = `Verified ${verified.size}/${items.length} items.${!allDone ? ' Run again after Pixel finishes backup.' : ''}`;
    log(summary, allDone ? 'success' : 'warn');
    opEnd('verify', allDone, summary);
    return { ok: true, verified: verified.size };
  } catch (err) {
    log(`Verify failed: ${err.message}`, 'error');
    opEnd('verify', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp?.close(); }
}
