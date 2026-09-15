#!/usr/bin/env node
import http from 'http';
import { handle, json } from './api/router.mjs';
import { PORT, WORK_DIR, DOWNLOADS_DIR } from './lib/config.mjs';
import { openAppWindow, killAllLaunchedChrome } from './lib/chrome.mjs';
import { sseClients } from './lib/sse.mjs';

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) json(res, { error: err.message }, 500);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\nGoogle Photos Recovery GUI`);
  console.log(`  ${url}`);
  console.log(`  Work dir: ${WORK_DIR}`);
  console.log(`  Downloads: ${DOWNLOADS_DIR}\n`);
  openAppWindow(url);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, closing Chrome windows and shutting down...`);
  killAllLaunchedChrome();
  // SSE connections stay open forever otherwise, which would make server.close()'s callback
  // never fire — end them explicitly so shutdown doesn't hang on a live GUI tab.
  for (const res of sseClients) { try { res.end(); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
