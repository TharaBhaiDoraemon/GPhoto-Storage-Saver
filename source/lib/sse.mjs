import { manifestStats } from './manifest.mjs';
import { readManifest } from './manifest.mjs';

export const sseClients = new Set();
export let currentOp = null;
let stopRequested = false;

export function requestStop() { stopRequested = true; }
export function isStopRequested() { return stopRequested; }

export function broadcast(type, payload) {
  const msg = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

function localTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function log(msg, level = 'info') {
  const ts = localTimestamp();
  broadcast('log', { text: `[${ts}] ${msg}`, level });
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

export function opStart(name) {
  currentOp = name;
  stopRequested = false;
  broadcast('opStart', { name });
}

export function opEnd(name, ok, summary = '') {
  currentOp = null;
  broadcast('opEnd', { name, ok, summary });
  broadcast('stats', { stats: manifestStats(readManifest()) });
}
