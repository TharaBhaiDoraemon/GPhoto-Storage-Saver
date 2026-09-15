import fs from 'fs';
import { execSync, spawn } from 'child_process';
import { CHROME_PATHS, CHROME_PROFILE_DIR, CHROME_GUI_PROFILE_DIR } from './config.mjs';
import { log } from './sse.mjs';

// PIDs of every Chrome window this process has spawned (the CDP automation browser and the
// GUI app window), so a Ctrl+C shutdown can close them instead of leaving them orphaned.
const launchedPids = new Set();

function trackChild(child) {
  if (child.pid) {
    launchedPids.add(child.pid);
    child.on('exit', () => launchedPids.delete(child.pid));
  }
  child.unref();
  return child;
}

export function killAllLaunchedChrome() {
  for (const pid of launchedPids) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        // Negative PID = signal the whole process group (spawned with detached:true, so
        // Chrome is the group leader — this reaches its renderer/GPU/utility subprocesses too).
        process.kill(-pid, 'SIGTERM');
      }
    } catch {}
  }
  launchedPids.clear();
}

export function findChrome() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const found = CHROME_PATHS.find(p => fs.existsSync(p));
  if (found) return found;

  if (process.platform !== 'win32') {
    const candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
    for (const bin of candidates) {
      try {
        const sysPath = execSync(`which ${bin}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        if (sysPath && fs.existsSync(sysPath)) return sysPath;
      } catch {}
    }
  }

  throw new Error('Chrome not found. Set CHROME_PATH environment variable or install Google Chrome/Chromium.');
}

export function launchChrome() {
  const chromePath = findChrome();
  trackChild(spawn(chromePath, [
    '--remote-debugging-port=9222',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
    'https://photos.google.com',
  ], { detached: true, stdio: 'ignore' }));
  log(`Chrome launched with profile: ${CHROME_PROFILE_DIR}`, 'info');
  return { ok: true, profileDir: CHROME_PROFILE_DIR };
}

export function openAppWindow(url) {
  try {
    const chromePath = findChrome();
    trackChild(spawn(chromePath, [
      `--app=${url}`,
      `--user-data-dir=${CHROME_GUI_PROFILE_DIR}`,
    ], { detached: true, stdio: 'ignore' }));
  } catch {
    try {
      // "" is a required placeholder — cmd.exe's `start` treats the first quoted argument as
      // the window title; without it, a URL that ever picked up a `&` (a legal URL character
      // cmd.exe treats as a command separator) would silently truncate.
      if (process.platform === 'win32') execSync(`start "" "${url}"`);
      else if (process.platform === 'darwin') execSync(`open ${url}`);
      else execSync(`xdg-open ${url}`);
    } catch {}
  }
}

export function deleteProfile() {
  if (!fs.existsSync(CHROME_PROFILE_DIR)) {
    return { ok: true, note: 'Profile directory does not exist' };
  }
  fs.rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true });
  log(`Deleted Chrome profile: ${CHROME_PROFILE_DIR}`, 'warn');
  return { ok: true, deleted: CHROME_PROFILE_DIR };
}
