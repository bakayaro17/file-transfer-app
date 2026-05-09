const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let mainWindow;

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  // Portable builds aren't supported by electron-updater
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

ipcMain.on('ondragstart', (event, filePath) => {
  event.sender.startDrag({
    file: filePath,
    icon: path.join(__dirname, 'icon.png')
  });
});

ipcMain.handle('save-temp-file', async (event, fileName, fileData) => {
  const tempDir = os.tmpdir();
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(fileData));
  return filePath;
});
