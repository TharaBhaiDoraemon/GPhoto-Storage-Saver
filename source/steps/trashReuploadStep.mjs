import fs from 'fs';
import path from 'path';
import { connectCdp } from '../lib/cdp.mjs';
import { getTokens, enumerateAll, listAllAlbums } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { adb, adbAsync, adbPush, checkAdb, safeName } from '../lib/adb.mjs';
import { log, opStart, opEnd, isStopRequested } from '../lib/sse.mjs';

async function saveAlbumMembershipsForItems(cdp, tokens, manifest, itemsNeedingAlbums) {
  log(`Saving album memberships for ${itemsNeedingAlbums.length} items...`);
  const albums = await listAllAlbums(cdp, tokens);
  log(`Found ${albums.length} albums.`);
  const targetKeys = new Set(itemsNeedingAlbums.map(i => i.mediaKey));
  const keyToItem = new Map(manifest.map(i => [i.mediaKey, i]));
  for (let i = 0; i < albums.length; i++) {
    const { albumId, title } = albums[i];
    const albumItems = await enumerateAll(cdp, tokens, { albumId });
    for (const rawItem of albumItems) {
      const key = rawItem?.[0];
      if (!key || !targetKeys.has(key)) continue;
      const item = keyToItem.get(key);
      if (!item) continue;
      if (!item.albums) item.albums = [];
      if (!item.albums.find(a => a.albumId === albumId))
        item.albums.push({ albumId, albumTitle: title });
    }
    if ((i + 1) % 10 === 0) log(`  Albums: ${i + 1}/${albums.length}`);
  }
  writeManifest(manifest);
  log('Album memberships saved.', 'success');
}

async function trashPhoto(cdp, tokens, dedupKey) {
  const tr = await cdp.evaluate(`
    (async () => {
      const d = [null, 1, [${JSON.stringify(dedupKey)}], 3];
      const w = [[['XwAOJf', JSON.stringify(d), null, 'generic']]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(w)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
      const p = new URLSearchParams({ rpcids: 'XwAOJf', 'source-path': '/photos', 'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c' });
      const r = await fetch(${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + p, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
      });
      const t = await r.text();
      return { status: r.status, hasError: t.includes('"er"'), body: t };
    })()`);
  if (tr.status !== 200 || tr.hasError) throw new Error(`Trash status=${tr.status} body=${tr.body}`);
}

async function permanentDeleteFromTrash(cdp, tokens, dedupKey) {
  const r = await cdp.evaluate(`
    (async () => {
      const d = [null, 2, [${JSON.stringify(dedupKey)}], 2];
      const w = [[['XwAOJf', JSON.stringify(d), null, 'generic']]];
      const body = 'f.req=' + encodeURIComponent(JSON.stringify(w)) + '&at=' + encodeURIComponent(${JSON.stringify(tokens.at)}) + '&';
      const p = new URLSearchParams({ rpcids: 'XwAOJf', 'source-path': '/trash', 'f.sid': ${JSON.stringify(tokens.fsid)}, bl: ${JSON.stringify(tokens.bl)}, pageId: 'none', rt: 'c' });
      const resp = await fetch(${JSON.stringify(`https://photos.google.com${tokens.path}data/batchexecute?`)} + p, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
      });
      const t = await resp.text();
      return { status: resp.status, hasError: t.includes('"er"'), body: t };
    })()`);
  if (r.status !== 200 || r.hasError) throw new Error(`XwAOJf/trash status=${r.status} hasError=${r.hasError} body=${r.body}`);
}

export async function repushStep({ concurrency = 3, device } = {}) {
  opStart('repush');
  if (!checkAdb(device)) {
    const msg = 'No ADB device connected';
    log(msg, 'error');
    opEnd('repush', false, msg);
    return { ok: false, error: msg };
  }
  try {
    const manifest = readManifest();
    const pending = manifest.filter(i => i.trashedAt && i.downloadedAs && !i.reuploadComplete);
    const items = pending.length > 0 ? pending : manifest.filter(i => i.trashedAt && i.downloadedAs);
    if (!items.length) {
      const msg = 'No trashed items to repush';
      log(msg, 'success');
      opEnd('repush', true, msg);
      return { ok: true, done: 0 };
    }
    const missing = items.filter(i => !fs.existsSync(i.downloadedAs));
    if (missing.length) log(`Warning: ${missing.length} files missing from disk (will be skipped).`, 'warn');
    const toPush = items.filter(i => fs.existsSync(i.downloadedAs));
    if (!toPush.length) {
      const msg = 'All files missing from disk — nothing to push';
      log(msg, 'error');
      opEnd('repush', false, msg);
      return { ok: false, error: msg };
    }
    const poolSize = Math.max(1, Math.min(concurrency, 10));
    log(`Repushing ${toPush.length} items to Pixel (concurrency: ${poolSize}).`);
    let counter = 0, done = 0, errors = 0;
    const iter = toPush[Symbol.iterator]();
    async function worker() {
      for (;;) {
        const { value: item, done: d } = iter.next();
        if (d) break;
        const n = ++counter;
        const label = item.filename || item.mediaKey.slice(0, 16);
        try {
          const sizeStr = item.sizeBytes ? ` (${(item.sizeBytes / 1024 / 1024).toFixed(1)} MB)` : '';
          log(`[${n}/${toPush.length}] Pushing ${label}${sizeStr}...`);
          await pushPhotoToPixel(item, device);
          item.reuploadComplete = true;
          item.reuploadedAt = new Date().toISOString();
          delete item.trashError;
          done++;
          log(`  ✓ ${label}`);
        } catch (err) {
          log(`  ✗ ${label}: ${err.message}`, 'error');
          item.trashError = err.message;
          errors++;
        }
        if ((done + errors) % 10 === 0) writeManifest(manifest);
      }
    }
    await Promise.all(Array.from({ length: poolSize }, worker));
    writeManifest(manifest);
    try {
      adb('shell am force-stop com.google.android.apps.photos', { serial: device });
      adb('shell am start -a android.intent.action.MAIN -n com.google.android.apps.photos/.home.HomeActivity', { serial: device });
      log('Photos app restarted.', 'success');
    } catch (err) { log(`Could not restart Photos: ${err.message}`, 'warn'); }
    const summary = `Repushed ${done}/${toPush.length} items${errors ? `, ${errors} errors` : ''}.`;
    log(summary, errors > 0 ? 'warn' : 'success');
    opEnd('repush', errors === 0, summary);
    return { ok: true, done, errors };
  } catch (err) {
    log(`Repush failed: ${err.message}`, 'error');
    opEnd('repush', false, err.message);
    return { ok: false, error: err.message };
  }
}

export async function pushStep({ concurrency = 3, device } = {}) {
  opStart('push');
  if (!checkAdb(device)) {
    const msg = 'No ADB device connected';
    log(msg, 'error');
    opEnd('push', false, msg);
    return { ok: false, error: msg };
  }
  try {
    const manifest = readManifest();
    // Push-only: leaves the cloud copy alone entirely. Skips anything already handled by the
    // trash+reupload pipeline (trashedAt/reuploadComplete) or already pushed by this same op.
    const items = manifest.filter(i => i.downloaded && i.downloadedAs && !i.trashedAt && !i.reuploadComplete && !i.pushedOnly);
    if (!items.length) {
      const msg = 'No items to push';
      log(msg, 'success');
      opEnd('push', true, msg);
      return { ok: true, done: 0 };
    }
    const missing = items.filter(i => !fs.existsSync(i.downloadedAs));
    if (missing.length) log(`Warning: ${missing.length} files missing from disk (will be skipped).`, 'warn');
    const toPush = items.filter(i => fs.existsSync(i.downloadedAs));
    if (!toPush.length) {
      const msg = 'All files missing from disk — nothing to push';
      log(msg, 'error');
      opEnd('push', false, msg);
      return { ok: false, error: msg };
    }
    const poolSize = Math.max(1, Math.min(concurrency, 10));
    log(`Pushing ${toPush.length} items to Pixel (concurrency: ${poolSize}) — cloud copies are left untouched.`);
    let counter = 0, done = 0, errors = 0;
    const iter = toPush[Symbol.iterator]();
    async function worker() {
      for (;;) {
        const { value: item, done: d } = iter.next();
        if (d) break;
        const n = ++counter;
        const label = item.filename || item.mediaKey.slice(0, 16);
        try {
          const sizeStr = item.sizeBytes ? ` (${(item.sizeBytes / 1024 / 1024).toFixed(1)} MB)` : '';
          log(`[${n}/${toPush.length}] Pushing ${label}${sizeStr}...`);
          await pushPhotoToPixel(item, device);
          item.pushedOnly = true;
          item.pushedOnlyAt = new Date().toISOString();
          done++;
          log(`  ✓ ${label}`);
        } catch (err) {
          log(`  ✗ ${label}: ${err.message}`, 'error');
          errors++;
        }
        if ((done + errors) % 10 === 0) writeManifest(manifest);
      }
    }
    await Promise.all(Array.from({ length: poolSize }, worker));
    writeManifest(manifest);
    try {
      adb('shell am force-stop com.google.android.apps.photos', { serial: device });
      adb('shell am start -a android.intent.action.MAIN -n com.google.android.apps.photos/.home.HomeActivity', { serial: device });
      log('Photos app restarted.', 'success');
    } catch (err) { log(`Could not restart Photos: ${err.message}`, 'warn'); }
    const summary = `Pushed ${done}/${toPush.length} items to device${errors ? `, ${errors} errors` : ''}. Cloud copies untouched.`;
    log(summary, errors > 0 ? 'warn' : 'success');
    opEnd('push', errors === 0, summary);
    return { ok: true, done, errors };
  } catch (err) {
    log(`Push failed: ${err.message}`, 'error');
    opEnd('push', false, err.message);
    return { ok: false, error: err.message };
  }
}

function getMimeInfo(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.mp4':
      return { mime: 'video/mp4', uri: 'content://media/external/video/media' };
    case '.mov':
      return { mime: 'video/quicktime', uri: 'content://media/external/video/media' };
    case '.m4v':
      return { mime: 'video/x-m4v', uri: 'content://media/external/video/media' };
    case '.3gp':
      return { mime: 'video/3gpp', uri: 'content://media/external/video/media' };
    case '.mkv':
      return { mime: 'video/x-matroska', uri: 'content://media/external/video/media' };
    case '.webm':
      return { mime: 'video/webm', uri: 'content://media/external/video/media' };
    case '.png':
      return { mime: 'image/png', uri: 'content://media/external/images/media' };
    case '.gif':
      return { mime: 'image/gif', uri: 'content://media/external/images/media' };
    case '.webp':
      return { mime: 'image/webp', uri: 'content://media/external/images/media' };
    case '.heic':
    case '.heif':
      return { mime: 'image/heif', uri: 'content://media/external/images/media' };
    case '.dng':
      return { mime: 'image/x-adobe-dng', uri: 'content://media/external/images/media' };
    default:
      return { mime: 'image/jpeg', uri: 'content://media/external/images/media' };
  }
}

async function pushPhotoToPixel(item, device) {
  const rawName = path.basename(item.downloadedAs);
  const pushName = safeName(rawName);
  const remote = `/sdcard/DCIM/Camera/${pushName}`;
  const localSize = fs.statSync(item.downloadedAs).size;

  let remoteSize = -1;
  try {
    const out = await adbAsync(`shell stat -c %s "${remote}"`, { timeout: 10000, serial: device });
    remoteSize = parseInt(out, 10);
  } catch {}

  if (remoteSize !== localSize) {
    await adbPush(item.downloadedAs, remote, { serial: device });
  }

  item.pushedAs = pushName;
  const { mime, uri } = getMimeInfo(pushName);
  try {
    await adbAsync(`shell content insert --uri ${uri} --bind "_data:s:${remote}" --bind "mime_type:s:${mime}" --bind "_display_name:s:${pushName}"`, { timeout: 10000, serial: device });
  } catch {}
  try {
    await adbAsync(`shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://${remote}"`, { timeout: 10000, serial: device });
  } catch {}
}

export async function trashReuploadStep({ mediaKeys: filterKeys, saveAlbumsFirst = true, emptyTrash = false, concurrency = 3, device } = {}) {
  opStart('trash-reupload');
  if (!checkAdb(device)) {
    const msg = 'No ADB device connected';
    log(msg, 'error');
    opEnd('trash-reupload', false, msg);
    return { ok: false, error: msg };
  }
  let cdp;
  try {
    cdp = await connectCdp();
    const manifest = readManifest();
    const items = manifest.filter(i =>
      i.downloaded && i.downloadedAs && i.dedupKey && !i.reuploadComplete &&
      (filterKeys ? filterKeys.includes(i.mediaKey) : i.consumesQuota)
    );
    const missing = items.filter(i => !fs.existsSync(i.downloadedAs));
    if (missing.length > 0) {
      const msg = `${missing.length} files missing from disk.`;
      log(msg, 'error');
      opEnd('trash-reupload', false, msg);
      return { ok: false, error: msg };
    }
    if (!items.length) {
      const msg = 'No items ready for trash+reupload';
      log(msg, 'success');
      opEnd('trash-reupload', true, msg);
      return { ok: true, done: 0 };
    }
    const poolSize = Math.max(1, Math.min(concurrency, 10));
    log(`${items.length} items to process (concurrency: ${poolSize}).`);

    if (saveAlbumsFirst) {
      const itemsNeedingAlbums = items.filter(i => !i.albums);
      if (itemsNeedingAlbums.length > 0) {
        const tokens2 = await getTokens(cdp);
        await saveAlbumMembershipsForItems(cdp, tokens2, manifest, itemsNeedingAlbums);
      }
    }

    const tokens = await getTokens(cdp);
    let counter = 0;
    let completedCount = 0;
    let totalDone = 0;
    let totalErrors = 0;
    let wasStopped = false;
    const iter = items[Symbol.iterator]();

    async function worker() {
      for (;;) {
        if (isStopRequested()) { wasStopped = true; break; }
        const { value: item, done } = iter.next();
        if (done) break;

        const n = ++counter;
        const label = item.filename || item.mediaKey.slice(0, 16);
        try {
          log(`[${n}/${items.length}] Trashing ${label}...`);
          await trashPhoto(cdp, tokens, item.dedupKey);
          item.trashedAt = new Date().toISOString();

          if (emptyTrash) {
            try {
              await permanentDeleteFromTrash(cdp, tokens, item.dedupKey);
              log(`  Permanently deleted from trash: ${label}`);
            } catch (e) {
              log(`  Could not permanently delete: ${e.message}`, 'warn');
            }
          }

          const sizeStr = item.sizeBytes ? ` (${(item.sizeBytes / 1024 / 1024).toFixed(1)} MB)` : '';
          log(`  Pushing ${label}${sizeStr}...`);
          await pushPhotoToPixel(item, device);
          item.reuploadComplete = true;
          item.reuploadedAt = new Date().toISOString();
          delete item.trashError;
          totalDone++;
          log(`  ✓ ${label}`);
        } catch (err) {
          log(`  ✗ ${label}: ${err.message}`, 'error');
          item.trashError = err.message;
          totalErrors++;
        }

        completedCount++;
        if (completedCount % 10 === 0) writeManifest(manifest);
      }
    }

    await Promise.all(Array.from({ length: poolSize }, worker));
    writeManifest(manifest);

    if (wasStopped) {
      log(`Stopped. Processed: ${completedCount}/${items.length}, pushed: ${totalDone}, errors: ${totalErrors}.`, 'warn');
    }

    try {
      adb('shell am force-stop com.google.android.apps.photos', { serial: device });
      adb('shell am start -a android.intent.action.MAIN -n com.google.android.apps.photos/.home.HomeActivity', { serial: device });
      log('Photos app restarted.', 'success');
    } catch (err) { log(`Could not restart Photos: ${err.message}`, 'warn'); }

    const summary = wasStopped
      ? `Stopped. ${totalDone} pushed, ${totalErrors} errors, ${items.length - completedCount} skipped.`
      : `Done: ${totalDone} processed, ${totalErrors} errors.`;
    log(summary, wasStopped || totalErrors > 0 ? 'warn' : 'success');
    opEnd('trash-reupload', !wasStopped && totalErrors === 0, summary);
    return { ok: true, done: totalDone, errors: totalErrors, stopped: wasStopped };
  } catch (err) {
    log(`Trash+Reupload failed: ${err.message}`, 'error');
    opEnd('trash-reupload', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp?.close(); }
}
