# GPhoto-Storage-Saver (Google Photos Quota Reclaim)

A web-based GUI application designed to reclaim Google Photos storage quota using an authenticated Chrome browser session and a Google Pixel phone (which provides free unlimited backup).

---

## Features

- **Scan & Prepare**: Connects to Google Photos via Chrome DevTools Protocol (CDP) to scan quota-consuming media (original quality or storage-saver items consuming drive space) and preserves album memberships.
- **Batch Download**: Downloads target media directly from Google Photos into the local `downloads/` directory.
- **Reupload via Pixel**: Automatically transfers downloaded media via ADB to your connected Google Pixel device to back them up quota-free.
- **Quota Verification**: Verifies that reuploaded photos no longer consume Google account storage quota.
- **Album & Metadata Restoration**: Restores album organization and re-archives previously archived items.
- **Multi-Account Support**: Switch between multiple logged-in Google accounts directly from the UI.
- **Dark / Light & Multi-Theme UI**: Includes custom color themes (AMOLED, Charcoal, Slate, Grey) and localization support (`en`, `ru`, `zh_TW`, `zh_CN`, `ja_JP`).

---

## Architecture & How It Works

1. **Local Node.js Server**: Serves a single-page interface and manages ADB operations.
2. **Chrome CDP (DevTools Protocol)**: Connects to your active Chrome browser session on port 9222. RPC calls to Google Photos are executed within the authenticated browser context so session cookies remain safely inside your browser.
3. **Android Debug Bridge (ADB)**: Pushes photos to `/sdcard/DCIM/Camera/` on your connected Google Pixel phone, triggering the Google Photos app to back them up under the Pixel's unlimited storage perk.

---

## Prerequisites

- **Node.js** (v18 or higher recommended)
- **Google Chrome** with remote debugging enabled (`--remote-debugging-port=9222`)
- **Google Pixel Phone** (Pixel 1 through Pixel 5) with USB debugging enabled
- **ADB**: Bundled in `adb/` for Windows, or installed via system package manager for Linux/macOS (`sudo apt install adb`)

---

## Quick Start

### 1. Launch Google Chrome with Remote Debugging

Close existing Chrome instances and start Chrome with remote debugging enabled:

**Linux / macOS:**
```bash
google-chrome --remote-debugging-port=9222
```

**Windows:**
```cmd
chrome.exe --remote-debugging-port=9222
```

Log in to [Google Photos](https://photos.google.com) in this Chrome window.

### 2. Connect Your Google Pixel

1. Enable **Developer Options** and turn on **USB Debugging** on your Pixel.
2. Connect your phone via USB and allow USB debugging when prompted.

### 3. Install Dependencies & Start the Server

**Linux / macOS:**
```bash
chmod +x start.sh
./start.sh
```
*Or manually:*
```bash
cd source
npm install
node server.mjs
```

**Windows:**
Double-click `Google Photos Quota Reclaim.bat` or run:
```cmd
cd source
npm install
node server.mjs
```

### 4. Open the Web Interface

Open your browser and navigate to:
```
http://localhost:8080
```

---

## Documentation

Detailed documentation is available in the [`source/docs/`](source/docs/) directory:
- [Architecture & Design](source/docs/architecture.md)
- [API Reference](source/docs/api-reference.md)
- [CDP & RPC Layer](source/docs/cdp-rpc.md)
- [Operations Guide](source/docs/operations.md)
- [Frontend Structure](source/docs/frontend.md)
- [Function Reference](source/docs/function-reference.md)

---

## Disclaimer

This tool performs destructive operations (moving items to trash and re-uploading). Ensure you have reliable offline backups of your media before running destructive steps.
