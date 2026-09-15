import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = process.env.PORT || 8080;
export const CDP_URL = 'http://127.0.0.1:9222';

export const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || path.join(os.tmpdir(), 'Chrome-GPhotos-CDP');
export const CHROME_GUI_PROFILE_DIR = process.env.CHROME_GUI_PROFILE_DIR || path.join(os.tmpdir(), 'Chrome-GPhotos-GUI');
export const CHROME_PATHS = [
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/var/lib/flatpak/exports/bin/com.google.Chrome',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')] : []),
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

export const WORK_DIR = process.env.WORK_DIR || path.dirname(path.dirname(__dirname));
export const MANIFEST_FILE = path.join(WORK_DIR, 'manifest.json');
export const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(WORK_DIR, 'downloads');

export const ADB_DIR = path.join(WORK_DIR, 'adb');
export const ADB_EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';
export const ADB_PATH = path.join(ADB_DIR, ADB_EXE);
export const ADB_DOWNLOAD_URL = 'https://developer.android.com/tools/releases/platform-tools';
