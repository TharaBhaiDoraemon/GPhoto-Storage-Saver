import fs from 'fs';
import path from 'path';
import { connectCdp, connectToTab, getCdpTabs, setSelectedAccount } from '../lib/cdp.mjs';
import { getTokens, enumerateAll, batchQuotaInfo } from '../lib/rpc.mjs';
import { readManifest, writeManifest } from '../lib/manifest.mjs';
import { adb, checkAdb } from '../lib/adb.mjs';
import { deleteProfile } from '../lib/chrome.mjs';
import { log, opStart, opEnd } from '../lib/sse.mjs';
import { DOWNLOADS_DIR, MANIFEST_FILE, CDP_URL } from '../lib/config.mjs';

export async function cleanupPixelStep({ device } = {}) {
  opStart('cleanup-pixel');
  try {
    if (!checkAdb(device)) throw new Error('No ADB device connected');
    log('Removing files from /sdcard/DCIM/Camera/...');
    adb('shell rm -f /sdcard/DCIM/Camera/*', { serial: device });
    const summary = 'Pixel camera roll cleaned.';
    log(summary, 'success');
    opEnd('cleanup-pixel', true, summary);
    return { ok: true };
  } catch (err) {
    log(`Cleanup failed: ${err.message}`, 'error');
    opEnd('cleanup-pixel', false, err.message);
    return { ok: false, error: err.message };
  }
}

export function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (stat.isFile() && entry.name.toLowerCase() !== 'readme.md') {
          results.push(fullPath);
        }
      } catch {}
    }
  }
  walk(dir);
  return results;
}

export async function resetAllStep() {
  opStart('reset-all');
  try {
    log('Reset All: deleting Chrome profile, resetting manifest, and clearing downloads/...', 'warn');

    // 1. Delete Profile
    const profileResult = deleteProfile(); // logs its own "Deleted Chrome profile: ..." line when it removes one
    if (!profileResult.deleted) log('No Chrome profile to delete.');

    // 2. Reset manifest — same effect as /api/reset-manifest
    if (fs.existsSync(MANIFEST_FILE)) fs.unlinkSync(MANIFEST_FILE);
    log('Manifest deleted.', 'warn');

    // 3. rm -rf everything inside downloads/. fs.rmSync never follows a symlink argument into
    // its target (it just unlinks the symlink itself) — same as real `rm -rf`, so anything a
    // downloads/ subfolder is symlinked to elsewhere on disk is untouched.
    let removed = 0;
    if (fs.existsSync(DOWNLOADS_DIR)) {
      for (const name of fs.readdirSync(DOWNLOADS_DIR)) {
        fs.rmSync(path.join(DOWNLOADS_DIR, name), { recursive: true, force: true });
        removed++;
      }
    }
    log(`Removed ${removed} item${removed === 1 ? '' : 's'} from downloads/.`);
    // opEnd() below broadcasts fresh stats itself (readManifest() returns [] once the file
    // is gone), so no separate stats broadcast is needed here.

    const summary = `Deleted Chrome profile, reset the manifest, and cleared downloads/ (${removed} item${removed === 1 ? '' : 's'}).`;
    log(summary, 'warn');
    opEnd('reset-all', true, summary);
    return { ok: true, removed };
  } catch (err) {
    log(`Reset failed: ${err.message}`, 'error');
    opEnd('reset-all', false, err.message);
    return { ok: false, error: err.message };
  }
}

export async function matchManifestStep() {
  opStart('match');
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) throw new Error(`downloads/ not found at ${DOWNLOADS_DIR}`);
    const downloadFiles = collectFiles(DOWNLOADS_DIR);
    const downloadMap = new Map(downloadFiles.map(f => [path.basename(f).toLowerCase(), f]));
    log(`${downloadFiles.length} media files found in downloads/`);
    const manifest = readManifest();
    let matched = 0;
    for (const item of manifest) {
      if (item.downloaded && item.downloadedAs) continue;
      const fname = item.filename?.toLowerCase();
      if (!fname) continue;
      const localPath = downloadMap.get(fname);
      if (!localPath) continue;
      item.downloaded = true;
      item.downloadedAs = localPath;
      matched++;
    }
    writeManifest(manifest);
    const total = manifest.filter(i => i.consumesQuota).length;
    const readyCount = manifest.filter(i => i.downloaded && i.downloadedAs).length;
    const summary = `Matched ${matched} new files (${readyCount}/${total} ready). Total quota: ${total}.`;
    log(summary, 'success');
    opEnd('match', true, summary);
    return { ok: true, matched, ready: readyCount };
  } catch (err) {
    log(`Match failed: ${err.message}`, 'error');
    opEnd('match', false, err.message);
    return { ok: false, error: err.message };
  }
}

export async function matchAlbumsStep({ albumIds }) {
  opStart('match');
  let cdp;
  try {
    cdp = await connectCdp();
    if (!fs.existsSync(DOWNLOADS_DIR)) throw new Error(`downloads/ not found at ${DOWNLOADS_DIR}`);
    const downloadFiles = collectFiles(DOWNLOADS_DIR);
    const downloadMap = new Map(downloadFiles.map(f => [path.basename(f).toLowerCase(), f]));
    log(`${downloadFiles.length} media files found in downloads/`);
    const tokens = await getTokens(cdp);
    const manifest = readManifest();
    const existingKeys = new Set(manifest.map(m => m.mediaKey));
    let added = 0, matched = 0;
    for (const albumId of albumIds) {
      log(`Enumerating album ${albumId}...`);
      const rawItems = await enumerateAll(cdp, tokens, { albumId });
      log(`  ${rawItems.length} items in album`);
      const keys = rawItems.map(i => i?.[0]).filter(Boolean);
      const qis = await batchQuotaInfo(cdp, tokens, keys);
      const quotaMap = new Map(qis.map(qi => [qi?.[0], qi]));
      const dedupMap = new Map(rawItems.filter(i => i?.[0] && i?.[3]).map(i => [i[0], i[3]]));
      for (const rawItem of rawItems) {
        const mediaKey = rawItem?.[0];
        if (!mediaKey) continue;
        const qi = quotaMap.get(mediaKey);
        const filename = qi?.[2] ?? '';
        if (!filename) continue;
        const matchedFile = downloadMap.get(filename.toLowerCase());
        if (!matchedFile) continue;
        matched++;
        const downloadedAs = matchedFile;
        if (existingKeys.has(mediaKey)) {
          const existing = manifest.find(m => m.mediaKey === mediaKey);
          if (existing && !existing.downloadedAs) { existing.downloadedAs = downloadedAs; existing.downloaded = true; }
          continue;
        }
        manifest.push({
          mediaKey,
          dedupKey: dedupMap.get(mediaKey) || null,
          filename,
          sizeBytes: qi?.[5] ?? 0,
          consumesQuota: qi?.[30]?.[0] === 1,
          isOriginalQuality: qi?.[14] === 2,
          downloaded: true,
          downloadedAs,
        });
        existingKeys.add(mediaKey);
        added++;
      }
      log(`  Matched ${matched} files so far`);
    }
    writeManifest(manifest);
    const summary = `Matched ${matched} files. Added ${added} new items.`;
    log(summary, 'success');
    opEnd('match', true, summary);
    return { ok: true, matched, added };
  } catch (err) {
    log(`Match failed: ${err.message}`, 'error');
    opEnd('match', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp?.close(); }
}

// Google Photos accounts are indexed contiguously from /u/0/ — stop probing at the first
// index that isn't actually signed in rather than assuming a fixed count.
const MAX_ACCOUNT_PROBE = 6;

async function waitForCdpReady(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tabs = await getCdpTabs();
      if (tabs.length) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function openNewTab(url) {
  const endpoint = `${CDP_URL}/json/new?${encodeURIComponent(url)}`;
  // Chrome wants PUT here; older builds only understood GET — try both.
  let res = await fetch(endpoint, { method: 'PUT' });
  if (res.status === 405) res = await fetch(endpoint, { method: 'GET' });
  if (!res.ok) throw new Error(`Chrome refused to open a new tab (HTTP ${res.status})`);
  return res.json();
}

async function closeTab(targetId) {
  try { await fetch(`${CDP_URL}/json/close/${targetId}`); } catch {}
}

// Confirms a probed tab is a genuine, signed-in account at exactly the requested URL — not
// just "the address bar still says /u/N/" (Google can render an in-app error/sign-in page
// without changing the URL), and not just "some Photos page loaded" (could be a redirect to a
// different account than the one requested).
async function verifyAccountTab(tab, targetUrl) {
  const session = await connectToTab(tab);
  try {
    const actualUrl = await session.evaluate('location.href');
    if (actualUrl !== targetUrl) return { ok: false, reason: `landed on ${actualUrl} instead` };
    const hasSession = await session.evaluate(`!!window.WIZ_global_data`);
    if (!hasSession) return { ok: false, reason: 'no active Google Photos session on this page' };
    return { ok: true };
  } finally { session.close(); }
}

export async function openAccountTabsStep() {
  opStart('open-account-tabs');
  try {
    log('Waiting for Chrome to come up on the debug port...');
    if (!(await waitForCdpReady())) throw new Error('Chrome did not come up on the debug port in time.');

    // Snapshot every Photos tab that exists *before* this run (the bootstrap tab launchChrome()
    // opened, plus any left over from a previous run) — closed at the end, but only once we
    // know we have working replacements, and never one we ourselves just opened.
    const previousPhotosTabs = (await getCdpTabs()).filter(t => t.url?.includes('photos.google.com'));

    log('Checking how many Google accounts are signed in...');
    const opened = [];
    for (let n = 0; n < MAX_ACCOUNT_PROBE; n++) {
      const targetUrl = `https://photos.google.com/u/${n}/`;
      const tab = await openNewTab(targetUrl);
      await new Promise(r => setTimeout(r, 3000)); // let the SPA load and settle any redirect
      const verdict = await verifyAccountTab(tab, targetUrl).catch(err => ({ ok: false, reason: err.message }));
      if (!verdict.ok) {
        log(`Account ${n}: not signed in (${verdict.reason}) — stopping.`, n === 0 ? 'error' : 'info');
        await closeTab(tab.id);
        break;
      }
      log(`Account ${n}: ${targetUrl} confirmed.`, 'success');
      opened.push({ index: n, url: targetUrl, tabId: tab.id });
    }

    if (!opened.length) {
      const msg = 'No signed-in Google account found at photos.google.com.';
      log(msg, 'error');
      opEnd('open-account-tabs', false, msg);
      return { ok: false, error: msg };
    }

    const openedIds = new Set(opened.map(t => t.tabId));
    for (const t of previousPhotosTabs) {
      if (!openedIds.has(t.id)) await closeTab(t.id);
    }

    const summary = `Opened ${opened.length} account tab${opened.length === 1 ? '' : 's'}: ${opened.map(t => t.url).join(', ')}`;
    log(summary, 'success');
    opEnd('open-account-tabs', true, summary);
    return { ok: true, accounts: opened.map(t => t.url) };
  } catch (err) {
    log(`Opening account tabs failed: ${err.message}`, 'error');
    opEnd('open-account-tabs', false, err.message);
    return { ok: false, error: err.message };
  }
}

export async function resetVerifyStep() {
  opStart('reset-verify');
  try {
    const manifest = readManifest();
    let reset = 0;
    for (const item of manifest) {
      if (item.verified === undefined && item.verifiedAt === undefined && item.verifyNote === undefined && item.newMediaKey === undefined) continue;
      delete item.verified;
      delete item.verifiedAt;
      delete item.verifyNote;
      delete item.newMediaKey;
      reset++;
    }
    writeManifest(manifest);
    const summary = `Reset verification state for ${reset} item${reset === 1 ? '' : 's'}. Ready to verify again (e.g. against a different account).`;
    log(summary, 'warn');
    opEnd('reset-verify', true, summary);
    return { ok: true, reset };
  } catch (err) {
    log(`Verify reset failed: ${err.message}`, 'error');
    opEnd('reset-verify', false, err.message);
    return { ok: false, error: err.message };
  }
}

export async function switchAccountStep(accountPath) {
  opStart('switch-account');
  let cdp;
  try {
    // Unpin first — otherwise our own getTokens() below would reject itself for landing on the
    // *new* account while the *old* one is still pinned from before this switch.
    setSelectedAccount(null);
    cdp = await connectCdp();
    await cdp.send('Page.navigate', { url: `https://photos.google.com${accountPath}` });
    await new Promise(r => setTimeout(r, 3000));
    const tokens = await getTokens(cdp);
    // Pin the confirmed account — every subsequent op (scan/verify/trash-reupload/...) now
    // refuses to run unless it's connected to exactly this account.
    setSelectedAccount(tokens.path);
    const summary = `Switched to ${tokens.path}`;
    log(summary, 'success');
    opEnd('switch-account', true, summary);
    return { ok: true, path: tokens.path };
  } catch (err) {
    log(`Switch account failed: ${err.message}`, 'error');
    opEnd('switch-account', false, err.message);
    return { ok: false, error: err.message };
  } finally { cdp?.close(); }
}
