import fs from 'fs';
import { execSync, exec, execFile } from 'child_process';
import { ADB_PATH, ADB_EXE, ADB_DOWNLOAD_URL } from './config.mjs';

export function getAdbPath() {
  if (fs.existsSync(ADB_PATH)) return ADB_PATH;

  try {
    const whichCmd = process.platform === 'win32' ? 'where adb' : 'which adb';
    const sysAdb = execSync(whichCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0].trim();
    if (sysAdb && fs.existsSync(sysAdb)) return sysAdb;
  } catch {}

  const installHint = process.platform === 'win32'
    ? `Download Platform Tools from ${ADB_DOWNLOAD_URL} and place ${ADB_EXE} in the adb/ folder.`
    : `Install adb (e.g. 'sudo apt install adb' or 'sudo pacman -S android-tools') or place 'adb' binary in the adb/ folder.`;

  throw new Error(`ADB binary not found at ${ADB_PATH} or in system PATH. ${installHint}`);
}

export function hasAdbBinary() {
  try {
    getAdbPath();
    return true;
  } catch {
    return false;
  }
}

function serialPrefix(serial) {
  return serial ? `-s ${JSON.stringify(serial)} ` : '';
}

export function adb(cmd, options = {}) {
  const bin = getAdbPath();
  const timeout = options.timeout !== undefined ? options.timeout : 60000;
  const { serial, ...rest } = options;
  return execSync(`"${bin}" ${serialPrefix(serial)}${cmd}`, { encoding: 'utf8', timeout, ...rest }).trim();
}

export function adbAsync(cmd, options = {}) {
  let bin;
  try {
    bin = getAdbPath();
  } catch (err) {
    return Promise.reject(err);
  }
  const timeout = options.timeout !== undefined ? options.timeout : 0;
  const maxBuffer = options.maxBuffer || 50 * 1024 * 1024;
  const { serial, ...rest } = options;
  return new Promise((resolve, reject) => {
    exec(`"${bin}" ${serialPrefix(serial)}${cmd}`, { encoding: 'utf8', timeout, maxBuffer, ...rest }, (err, stdout) => {
      if (err) reject(err); else resolve((stdout || '').trim());
    });
  });
}

export function adbPush(localPath, remotePath, options = {}) {
  let bin;
  try {
    bin = getAdbPath();
  } catch (err) {
    return Promise.reject(err);
  }
  const timeout = options.timeout !== undefined ? options.timeout : 0;
  const maxBuffer = options.maxBuffer || 50 * 1024 * 1024;
  const { serial, ...rest } = options;
  const args = [...(serial ? ['-s', serial] : []), 'push', localPath, remotePath];
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout, maxBuffer, ...rest }, (err, stdout) => {
      if (err) reject(err); else resolve((stdout || '').trim());
    });
  });
}

// Parses `adb devices -l` output into connected devices. Only devices in the
// "device" state (authorized and ready) are usable; unauthorized/offline ones
// are reported so the UI can explain why they can't be selected.
export function listAdbDevices() {
  let out;
  try {
    out = adb('devices -l');
  } catch {
    return [];
  }
  const lines = out.split('\n').slice(1); // drop "List of devices attached" header
  const devices = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const modelMatch = rest.join(' ').match(/model:(\S+)/);
    const model = modelMatch ? modelMatch[1].replace(/_/g, ' ') : null;
    devices.push({ serial, state, model });
  }
  return devices;
}

export function checkAdb(serial) {
  const devices = listAdbDevices();
  if (serial) return devices.some(d => d.serial === serial && d.state === 'device');
  return devices.some(d => d.state === 'device');
}

export function safeName(name) {
  return name.replace(/[ /\\?%*:|"<>]/g, '_');
}
