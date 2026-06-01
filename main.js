const { app, BrowserWindow, ipcMain, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PROTOCOL = 'filetransfer';

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

  mainWindow.webContents.once('did-finish-load', () => {
    const fromArgs = extractDeepLink(process.argv);
    const link = fromArgs || pendingDeepLink;
    if (link) {
      mainWindow.webContents.send('deep-link', link);
      pendingDeepLink = null;
    }
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

  const send = (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', status);
    }
  };

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

app.whenReady().then(() => {
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
    event.sender.send('drag-error', `Temp file missing: ${filePath}`);
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

ipcMain.handle('save-temp-file', async (event, fileName, fileData) => {
  const tempDir = os.tmpdir();
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(fileData));
  return filePath;
});
