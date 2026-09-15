import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCdpTabs, connectCdp, tryGetAccountEmail, getSelectedAccount, normalizeAccountPath } from '../lib/cdp.mjs';
import { getTokens, listAllAlbums, clearAlbumsCache } from '../lib/rpc.mjs';
import { readManifest, manifestStats } from '../lib/manifest.mjs';
import { broadcast, log, currentOp, sseClients, requestStop, opEnd } from '../lib/sse.mjs';
import { launchChrome, deleteProfile } from '../lib/chrome.mjs';
import { checkAdb, hasAdbBinary, listAdbDevices } from '../lib/adb.mjs';
import { CHROME_PROFILE_DIR, DOWNLOADS_DIR, MANIFEST_FILE, PORT, WORK_DIR } from '../lib/config.mjs';
import { scanStep, scanFullStep } from '../steps/scanStep.mjs';
import { downloadStep } from '../steps/downloadStep.mjs';
import { enrichStep } from '../steps/enrichStep.mjs';
import { restoreAlbumsStep } from '../steps/albumsStep.mjs';
import { trashReuploadStep, repushStep, pushStep } from '../steps/trashReuploadStep.mjs';
import { verifyStep } from '../steps/verifyStep.mjs';
import { cleanupPixelStep, matchManifestStep, matchAlbumsStep, switchAccountStep, resetVerifyStep, openAccountTabsStep, collectFiles, resetAllStep } from '../steps/miscSteps.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const emailCacheMap = new Map();

function getDirSizeSync(dirPath) {
  let totalSize = 0;
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      const fp = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        totalSize += getDirSizeSync(fp);
      } else if (file.isFile()) {
        try { totalSize += fs.statSync(fp).size; } catch {}
      }
    }
  } catch {}
  return totalSize;
}

export function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  const raw = await new Promise(resolve => {
    let data = ''; req.on('data', c => data += c); req.on('end', () => resolve(data));
  });
  try { return JSON.parse(raw); } catch { return {}; }
}

function handleCors(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end();
}

function serveIndexHtml(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(__dirname, '..', 'index.html')).pipe(res);
}

function handleSseConnection(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'stats', stats: manifestStats(readManifest()) })}\n\n`);
  clearAlbumsCache(); // page refresh → fresh album data on next fetch
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

async function resolveEmailForTab(tab, account) {
  if (!tab) return null;
  const now = Date.now();
  const cached = emailCacheMap.get(account);
  if (cached) {
    // A failed lookup (page still mid-navigation, account-switcher DOM not rendered yet, or the
    // tab briefly disappearing — e.g. /u/0/ often has a transient duplicate right after launch:
    // the bare-URL bootstrap tab from launchChrome() plus the dedicated /u/0/ tab
    // openAccountTabsStep() opens next to it, until the bootstrap tab is closed a few seconds
    // later) gets a much shorter TTL than a success. Otherwise one unlucky poll locks in "no
    // email" for the full 30s even though the very next 10s poll would likely succeed.
    const ttl = cached.email ? 30000 : 8000;
    if (now - cached.at < ttl) return cached.email;
  }
  const email = await tryGetAccountEmail(tab.webSocketDebuggerUrl);
  // Never let a failed re-probe erase an email already resolved successfully — a backgrounded
  // (not-currently-focused) tab is exactly where Chrome is most likely to deprioritize
  // rendering the account-switcher UI this depends on, so the account you're NOT looking at is
  // the one most likely to transiently fail here. Keep the last known-good value; a failure
  // only resets the retry clock (short TTL above), never blanks what we already know.
  const resolved = email ?? cached?.email ?? null;
  emailCacheMap.set(account, { email: resolved, at: now });
  return resolved;
}

// Resolves every open Google Photos tab's email, not just the "current" one — with several
// accounts logged into Chrome, each shows up as its own tab, and the account-switcher dropdown
// needs all of their emails to annotate /u/0/, /u/1/, /u/2/, etc. Keyed by normalizeAccountPath()
// (never the raw '/') so it always matches the dropdown's /u/N/ option values.
async function resolveAllAccountEmails(photosTabs) {
  const tabByAccount = new Map();
  for (const t of photosTabs) {
    const m = t.url?.match(/photos\.google\.com(\/u\/\d+\/)/);
    const acct = normalizeAccountPath(m ? m[1] : '/');
    if (!tabByAccount.has(acct)) tabByAccount.set(acct, t);
  }
  await Promise.all([...tabByAccount.entries()].map(([acct, t]) => resolveEmailForTab(t, acct)));
}

async function handleStatusRequest(res) {
  // Computed independently of the CDP/Chrome-tab lookup below, and always included in the
  // response — ADB and CDP are unrelated subsystems. A CDP hiccup (flaky tab fetch, a stalled
  // account-email lookup) must never wipe out adbDevices/manifest/currentOp along with it, or
  // the device selector (and stats) silently vanish for a poll cycle even though ADB is fine.
  const base = {
    manifest: manifestStats(readManifest()),
    currentOp,
    adbBinaryFound: hasAdbBinary(),
    adbConnected: checkAdb(),
    adbDevices: listAdbDevices(),
    workDir: WORK_DIR,
    downloadsDir: DOWNLOADS_DIR,
    downloadCount: fs.existsSync(DOWNLOADS_DIR) ? collectFiles(DOWNLOADS_DIR).length : 0,
  };
  try {
    const tabs = await getCdpTabs();
    const photosTabs = tabs.filter(t => t.url?.includes('photos.google.com'));
    const accountMatch = photosTabs[0]?.url.match(/photos\.google\.com(\/u\/\d+\/)/);
    const account = accountMatch?.[1] ?? (photosTabs.length > 0 ? '/' : null);
    await resolveAllAccountEmails(photosTabs);
    const accountEmail = account != null ? emailCacheMap.get(normalizeAccountPath(account))?.email ?? null : null;
    const knownEmails = {};
    for (const [p, d] of emailCacheMap.entries()) { if (d.email) knownEmails[p] = d.email; }
    const selectedAccount = getSelectedAccount();
    return json(res, {
      ...base,
      cdpConnected: photosTabs.length > 0,
      account,
      accountEmail,
      knownEmails,
      // Account pinned via the account switcher — operations refuse to run against any other
      // account while this is set. null = never pinned (ops just use whichever tab they find).
      selectedAccount,
      accountMismatch: !!(selectedAccount && account && normalizeAccountPath(account) !== selectedAccount),
      photosTabs: photosTabs.map(t => ({ url: t.url, title: t.title })),
    });
  } catch (err) {
    // Still report the cached emails even on a CDP hiccup — building this needs no live CDP
    // call (it's a pure read of the in-memory cache), so there's no reason a transient
    // getCdpTabs()/probe failure should blank out every account's email in the dropdown.
    const knownEmails = {};
    for (const [p, d] of emailCacheMap.entries()) { if (d.email) knownEmails[p] = d.email; }
    return json(res, { ...base, cdpConnected: false, knownEmails, selectedAccount: getSelectedAccount(), error: err.message });
  }
}

async function handleAlbumsRequest(res) {
  try {
    const cdp = await connectCdp();
    const tokens = await getTokens(cdp);
    const albums = await listAllAlbums(cdp, tokens);
    cdp.close();

    // Compute quota item counts per album from manifest
    const manifest = readManifest();
    const albumQuotaCounts = new Map();
    for (const item of manifest) {
      if (!item.consumesQuota) continue;
      for (const a of item.albums || []) {
        albumQuotaCounts.set(a.albumId, (albumQuotaCounts.get(a.albumId) || 0) + 1);
      }
    }
    const albumsWithQuota = albums.map(a => ({
      ...a,
      quotaCount: albumQuotaCounts.get(a.albumId) || 0,
    }));

    return json(res, { albums: albumsWithQuota });
  } catch (err) {
    return json(res, { error: err.message }, 500);
  }
}

function handleChromeInfoRequest(res) {
  const exists = fs.existsSync(CHROME_PROFILE_DIR);
  let sizeMb = null;
  if (exists) {
    try {
      const bytes = getDirSizeSync(CHROME_PROFILE_DIR);
      sizeMb = Math.round(bytes / 1024 / 1024);
    } catch {}
  }
  return json(res, { profileDir: CHROME_PROFILE_DIR, exists, sizeMb });
}

function buildOperationsMap(body) {
  return {
    '/api/scan-full':      () => scanFullStep(body),
    '/api/scan':           () => scanStep(body),
    '/api/download':       () => downloadStep(body),
    '/api/enrich':         () => enrichStep(),
    '/api/trash-reupload': () => trashReuploadStep(body),
    '/api/repush':         () => repushStep(body),
    '/api/push':           () => pushStep(body),
    '/api/verify':         () => verifyStep(),
    '/api/reset-verify':   () => resetVerifyStep(),
    '/api/restore-albums': () => restoreAlbumsStep(),
    '/api/cleanup-pixel':  () => cleanupPixelStep(body),
    '/api/reset-all':      () => resetAllStep(),
    '/api/match':          () => body.albumIds?.length ? matchAlbumsStep(body) : matchManifestStep(),
    '/api/switch-account': () => body.path ? switchAccountStep(body.path) : Promise.resolve({ error: 'path required' }),
    '/api/open-account-tabs': () => openAccountTabsStep(),
    '/api/reset-manifest': () => {
      if (fs.existsSync(MANIFEST_FILE)) fs.unlinkSync(MANIFEST_FILE);
      broadcast('stats', manifestStats([]));
      log('Manifest deleted.', 'warn');
      return Promise.resolve({ ok: true });
    },
  };
}

export async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') return handleCors(res);
  if (pathname === '/' || pathname === '/index.html') return serveIndexHtml(res);
  if (pathname === '/api/events') return handleSseConnection(req, res);
  if (pathname === '/api/status' && req.method === 'GET') return handleStatusRequest(res);
  if (pathname === '/api/albums' && req.method === 'GET') return handleAlbumsRequest(res);
  if (pathname === '/api/manifest' && req.method === 'GET') {
    const m = readManifest();
    return json(res, { manifest: m, stats: manifestStats(m) });
  }
  if (pathname === '/api/launch-chrome' && req.method === 'POST') {
    try { return json(res, launchChrome()); }
    catch (err) { return json(res, { error: err.message }, 500); }
  }
  if (pathname === '/api/delete-profile' && req.method === 'POST') {
    try { return json(res, deleteProfile()); }
    catch (err) { return json(res, { error: err.message }, 500); }
  }
  if (pathname === '/api/chrome-info' && req.method === 'GET') return handleChromeInfoRequest(res);
  if (pathname === '/api/stop' && req.method === 'POST') {
    requestStop();
    log('Stop requested by user.', 'warn');
    return json(res, { ok: true });
  }

  if (req.method !== 'POST') { res.writeHead(404); return res.end('Not found'); }

  const body = await parseBody(req);

  if (currentOp) {
    return json(res, { error: `Operation '${currentOp}' is running`, busy: true }, 409);
  }

  const ops = buildOperationsMap(body);

  if (ops[pathname]) {
    ops[pathname]().catch(err => {
      console.error(err);
      // A step's own try/catch already calls opEnd() and resolves — this only fires for an
      // exception that escaped the step entirely (e.g. connectCdp() failing before its try
      // block). Must use the real opEnd(), not just broadcast a copy of it: broadcasting alone
      // fixes the client's local UI but leaves the server's currentOp stuck forever, permanently
      // greying out every operation button and 409-ing every future request until restart.
      opEnd(pathname.slice(5), false, err.message || String(err));
    });
    return json(res, { ok: true, queued: pathname.slice(5) });
  }

  res.writeHead(404);
  res.end('Not found');
}
