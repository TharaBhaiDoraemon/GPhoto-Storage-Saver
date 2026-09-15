import { WebSocket } from 'ws';
import { CDP_URL } from './config.mjs';
import { log } from './sse.mjs';

// Account the user last explicitly picked via the account-switcher (set by switchAccountStep()
// once its own navigate+getTokens confirms the switch actually landed). null = never pinned —
// every op behaves exactly as before (first Google Photos tab found, no cross-check). Once set,
// connectCdp() and getTokens() both refuse to silently operate against a different account, so a
// stray second Photos tab (or the connected tab navigating away on its own) can't quietly change
// which account a scan/verify/trash-reupload actually runs against.
let selectedAccountPath = null;

export function setSelectedAccount(path) { selectedAccountPath = path ? normalizeAccountPath(path) : null; }
export function getSelectedAccount() { return selectedAccountPath; }

// Google renders the primary account (index 0) at the bare origin sometimes and as an explicit
// /u/0/ path other times — treat them as the same account everywhere in this module. Also: the
// input isn't always already a clean account prefix — tokens.path (the `eptZe` global read by
// getTokens()) can carry the in-app SPA route too, e.g. "/u/1/_/PhotosUi/" — so always strip down
// to just the leading "/u/N/" rather than assuming the caller already did.
export function normalizeAccountPath(p) {
  if (!p || p === '/') return '/u/0/';
  const m = p.match(/^(\/u\/\d+\/)/);
  return m ? m[1] : p;
}

function tabAccountPath(url) {
  const m = url?.match(/photos\.google\.com(\/u\/\d+\/)/);
  return normalizeAccountPath(m ? m[1] : '/');
}

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`JS: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
    return result.result?.value;
  }

  close() { try { this.ws.close(); } catch {} }
}

// Attaches a fresh CDP session to a specific already-known tab descriptor (as returned by
// getCdpTabs() or Chrome's /json/new) — bypasses connectCdp()'s "pick the right Photos tab"
// selection entirely, for callers that already know exactly which tab they want (e.g. opening
// and probing several account tabs by hand).
export async function connectToTab(tab) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return new CdpSession(ws);
}

export async function connectCdp() {
  let res;
  try {
    res = await fetch(`${CDP_URL}/json`);
  } catch (err) {
    throw new Error('Chrome is not connected on port 9222. Please click "Launch Chrome" in the interface to open Chrome with remote debugging.');
  }
  const tabs = await res.json();
  const photosTabs = tabs.filter(t => t.url?.includes('photos.google.com'));
  if (!photosTabs.length) throw new Error('No Google Photos tab found. Open photos.google.com in Chrome with --remote-debugging-port=9222');

  let tab = photosTabs[0];
  if (selectedAccountPath) {
    const matches = photosTabs.filter(t => tabAccountPath(t.url) === selectedAccountPath);
    if (!matches.length) {
      const open = photosTabs.map(t => tabAccountPath(t.url)).join(', ');
      throw new Error(`Expected the Google Photos tab on account ${selectedAccountPath} (last selected via the account switcher), but no open tab matches — open tab(s): ${open}. Switch to that account in Chrome, or use the account switcher again.`);
    }
    tab = matches[0];
  } else if (photosTabs.length > 1) {
    log(`Multiple Google Photos tabs open (${photosTabs.map(t => tabAccountPath(t.url)).join(', ')}) and no account pinned — using ${tabAccountPath(tab.url)}. Use the account switcher to pin the intended one, or close the extra tab(s).`, 'warn');
  }

  return connectToTab(tab);
}

export async function getCdpTabs() {
  try {
    const res = await fetch(`${CDP_URL}/json`);
    return await res.json();
  } catch { return []; }
}

export async function tryGetAccountEmail(wsUrl) {
  return new Promise(resolve => {
    const done = v => { clearTimeout(t); resolve(v); };
    const t = setTimeout(() => resolve(null), 3500);
    let ws;
    (async () => {
      try {
        ws = new WebSocket(wsUrl, { perMessageDeflate: false });
        await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
        const tmp = new CdpSession(ws);
        const email = await tmp.evaluate(`
          (() => {
            const el = document.querySelector('[data-email]');
            if (el?.dataset?.email?.includes('@')) return el.dataset.email;
            for (const e of document.querySelectorAll('[aria-label]')) {
              const m = (e.getAttribute('aria-label') || '').match(/[\\w.+\\-]+@[\\w.\\-]+\\.\\w+/);
              if (m) return m[0];
            }
            return null;
          })()`);
        tmp.close();
        done(email);
      } catch { try { ws?.close(); } catch {} done(null); }
    })();
  });
}
