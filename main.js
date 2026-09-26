const { app, BrowserWindow, ipcMain, shell, nativeImage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const clipboardSync = require('./clipboard-sync');

const PROTOCOL = 'filetransfer';

// Received files land in <temp>/FileTransferApp/<batch>/... so they can be
// dragged out, saved, or put on the clipboard. Old batches are swept on launch.
const RECEIVED_DIR_NAME = 'FileTransferApp';
const RECEIVED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let mainWindow;
let pendingDeepLink = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const link = extractDeepLink(argv);
  if (link) sendDeepLinkToRenderer(link);
});

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function extractDeepLink(argv) {
  if (!argv) return null;
  const arg = argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL}://`));
  if (!arg) return null;
  const match = arg.match(new RegExp(`^${PROTOCOL}://(?:connect/)?([A-Z0-9]+)/?`, 'i'));
  return match ? match[1].toUpperCase() : null;
}

function sendDeepLinkToRenderer(code) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingDeepLink = code;
    return;
  }
  mainWindow.webContents.send('deep-link', code);
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function receivedRoot() {
  return path.join(app.getPath('temp'), RECEIVED_DIR_NAME);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 820,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');

  clipboardSync.configure({
    window: mainWindow,
    ignoreRoot: receivedRoot(),
    onFiles: (paths) => sendToRenderer('clipboard-files', paths)
  });

  mainWindow.webContents.once('did-finish-load', () => {
    const fromArgs = extractDeepLink(process.argv);
    const link = fromArgs || pendingDeepLink;
    if (link) {
      mainWindow.webContents.send('deep-link', link);
      pendingDeepLink = null;
    }
  });

  mainWindow.on('closed', () => {
    clipboardSync.setEnabled(false);
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  const code = extractDeepLink([url]);
  if (code) sendDeepLinkToRenderer(code);
});

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  if (process.env.PORTABLE_EXECUTABLE_FILE) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (status) => sendToRenderer('update-status', status);

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => send({ state: 'none' }));
  autoUpdater.on('error', (err) => send({ state: 'error', message: err?.message || String(err) }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }));

  ipcMain.on('install-update', () => autoUpdater.quitAndInstall());

  autoUpdater.checkForUpdates().catch((e) => console.error('Update check failed:', e));
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((e) => console.error('Update check failed:', e));
  }, 60 * 60 * 1000);
}

function cleanupOldReceived() {
  const root = receivedRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return;
  }
  const cutoff = Date.now() - RECEIVED_MAX_AGE_MS;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const p = path.join(root, ent.name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      console.error('[cleanup] failed to remove', p, err);
    }
  }
}

app.whenReady().then(() => {
  cleanupOldReceived();
  createWindow();
  setupAutoUpdater();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev' };
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { ok: false, reason: 'portable' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', message: err?.message || String(err) };
  }
});

// ---------------------------------------------------------------------------
// Drag-out of received files
// ---------------------------------------------------------------------------

// 16x16 transparent PNG — guaranteed-valid fallback so startDrag never gets an empty icon.
const FALLBACK_ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVR42mNkYGD4z0AEYBxVSF+FABRwAQGmAjkrAAAAAElFTkSuQmCC',
  'base64'
);

let dragIconCache = null;
function getDragIcon() {
  if (dragIconCache) return dragIconCache;
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'icon.png'));
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) {
      // Windows silently drops the drag if the icon is larger than 32px.
      dragIconCache = img.resize({ width: 32, height: 32 });
      return dragIconCache;
    }
    console.error('[drag] icon loaded but image is empty');
  } catch (err) {
    console.error('[drag] failed to read icon.png:', err);
  }
  dragIconCache = nativeImage.createFromBuffer(FALLBACK_ICON_PNG);
  return dragIconCache;
}

ipcMain.on('ondragstart', (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) {
    event.sender.send('drag-error', 'No file path');
    return;
  }
  if (!fs.existsSync(filePath)) {
    event.sender.send('drag-error', `File missing: ${filePath}`);
    return;
  }
  try {
    event.sender.startDrag({
      file: filePath,
      icon: getDragIcon()
    });
  } catch (err) {
    console.error('[drag] startDrag threw:', err);
    event.sender.send('drag-error', err?.message || String(err));
  }
});

// ---------------------------------------------------------------------------
// Save received item to a location the user picks
// ---------------------------------------------------------------------------

function isInsideReceivedRoot(p) {
  const rel = path.relative(receivedRoot(), p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

ipcMain.handle('save-received', async (event, srcPath, suggestedName, isDir) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (typeof srcPath !== 'string' || !isInsideReceivedRoot(srcPath) || !fs.existsSync(srcPath)) {
    return { ok: false, error: 'file is no longer available' };
  }
  const name = path.basename(String(suggestedName || path.basename(srcPath)));
  try {
    if (isDir) {
      const r = await dialog.showOpenDialog(win, {
        title: `Choose where to save "${name}"`,
        buttonLabel: 'Save here',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory']
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      const dest = path.join(r.filePaths[0], name);
      await fs.promises.cp(srcPath, dest, { recursive: true });
      return { ok: true, path: dest };
    }
    const r = await dialog.showSaveDialog(win, {
      title: 'Save file',
      defaultPath: path.join(app.getPath('downloads'), name)
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    await fs.promises.copyFile(srcPath, r.filePath);
    return { ok: true, path: r.filePath };
  } catch (err) {
    console.error('[save] failed:', err);
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---------------------------------------------------------------------------
// Sending: the renderer only has paths (from drops, the file picker, pastes or
// the clipboard watcher). Main expands folders and streams file bytes in chunks.
// ---------------------------------------------------------------------------

const MAX_EXPAND_FILES = 5000;
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

async function expandPaths(inputs) {
  const items = []; // { abs, rel, size } — rel uses '/' and starts with the top-level name
  let total = 0;
  let truncated = false;
  const seen = new Set();

  async function walk(dir, relBase) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (items.length >= MAX_EXPAND_FILES) { truncated = true; return; }
      if (SKIP_NAMES.has(ent.name) || ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      const rel = `${relBase}/${ent.name}`;
      if (ent.isDirectory()) {
        await walk(abs, rel);
      } else if (ent.isFile()) {
        let st;
        try { st = await fs.promises.stat(abs); } catch (_) { continue; }
        items.push({ abs, rel, size: st.size });
        total += st.size;
      }
    }
  }

  for (const raw of Array.isArray(inputs) ? inputs : []) {
    if (typeof raw !== 'string' || !raw) continue;
    const abs = path.resolve(raw);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let st;
    try { st = await fs.promises.stat(abs); } catch (_) { continue; }
    if (items.length >= MAX_EXPAND_FILES) { truncated = true; break; }
    const base = path.basename(abs) || 'root';
    if (st.isDirectory()) {
      await walk(abs, base);
    } else if (st.isFile()) {
      items.push({ abs, rel: base, size: st.size });
      total += st.size;
    }
  }
  return { items, total, count: items.length, truncated };
}

ipcMain.handle('expand-paths', (_event, inputs) => expandPaths(inputs));

const readHandles = new Map(); // handle id -> FileHandle
let readSeq = 0;

ipcMain.handle('read-open', async (_event, abs) => {
  if (typeof abs !== 'string' || !abs) throw new Error('bad path');
  const fh = await fs.promises.open(abs, 'r');
  const id = ++readSeq;
  readHandles.set(id, fh);
  return id;
});

ipcMain.handle('read-chunk', async (_event, id, offset, length) => {
  const fh = readHandles.get(id);
  if (!fh) throw new Error('unknown read handle');
  const len = Math.max(0, Math.min(Number(length) || 0, 8 * 1024 * 1024));
  const buf = Buffer.allocUnsafe(len);
  const { bytesRead } = await fh.read(buf, 0, len, Number(offset) || 0);
  // Copy short reads so the renderer never sees trailing garbage from the buffer.
  return bytesRead === len ? buf : Buffer.from(buf.subarray(0, bytesRead));
});

ipcMain.handle('read-close', async (_event, id) => {
  const fh = readHandles.get(id);
  readHandles.delete(id);
  if (fh) await fh.close().catch(() => {});
  return true;
});

// ---------------------------------------------------------------------------
// Receiving: chunks stream straight to disk under the received root.
// ---------------------------------------------------------------------------

const INVALID_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/g;

function safeSegment(seg) {
  const s = String(seg).replace(INVALID_NAME_CHARS, '_').replace(/[. ]+$/, '');
  return s && s !== '.' && s !== '..' ? s : null;
}

function safeId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  return s ? s.slice(0, 64) : null;
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('bad chunk');
}

const recvStreams = new Map(); // key -> { fh, path }

ipcMain.handle('recv-start', async (_event, key, meta) => {
  if (typeof key !== 'string' || !key || recvStreams.has(key)) throw new Error('bad stream key');
  meta = meta || {};
  const batchDir = path.join(receivedRoot(), safeId(meta.batch) || safeId(key) || `b${Date.now()}`);
  const parts = String(meta.rel || '').split(/[\\/]+/).map(safeSegment).filter(Boolean);
  if (!parts.length) parts.push(safeSegment(path.basename(String(meta.name || ''))) || 'file');
  let full = path.join(batchDir, ...parts);
  if (!full.startsWith(batchDir + path.sep)) throw new Error('bad path');
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  if (parts.length === 1) {
    full = uniquePath(full); // two files with the same name in one batch
    parts[0] = path.basename(full);
  }
  const fh = await fs.promises.open(full, 'w');
  recvStreams.set(key, { fh, path: full });
  return {
    path: full,
    topPath: path.join(batchDir, parts[0]),
    topName: parts[0],
    isDir: parts.length > 1
  };
});

ipcMain.handle('recv-chunk', async (_event, key, data) => {
  const s = recvStreams.get(key);
  if (!s) throw new Error('unknown stream');
  let buf = toBuffer(data);
  while (buf.length) {
    const { bytesWritten } = await s.fh.write(buf);
    buf = buf.subarray(bytesWritten);
  }
  return true;
});

ipcMain.handle('recv-end', async (_event, key) => {
  const s = recvStreams.get(key);
  if (!s) throw new Error('unknown stream');
  recvStreams.delete(key);
  await s.fh.close();
  return s.path;
});

ipcMain.handle('recv-abort', async (_event, key) => {
  const s = recvStreams.get(key);
  if (!s) return false;
  recvStreams.delete(key);
  await s.fh.close().catch(() => {});
  await fs.promises.unlink(s.path).catch(() => {});
  return true;
});

// ---------------------------------------------------------------------------
// Clipboard sync
// ---------------------------------------------------------------------------

ipcMain.on('clipboard-sync-set', (_event, on) => {
  clipboardSync.setEnabled(!!on);
});

// Every DOM paste event that carried files ends up here. Returns true when it
// answered one of our own synthetic pastes (so the renderer ignores it).
ipcMain.handle('clipboard-paste-report', (_event, paths) => clipboardSync.handlePasteReport(paths));

ipcMain.handle('clipboard-write', (_event, paths) => clipboardSync.writeFiles(paths));

ipcMain.handle('clipboard-read-now', () => clipboardSync.readNow());
