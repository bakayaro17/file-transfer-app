const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function createWindow () {
  const mainWindow = new BrowserWindow({
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

app.whenReady().then(() => {
  createWindow();

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
    icon: path.join(__dirname, 'icon.png') // Provide a default icon or a specific one
  });
});

ipcMain.handle('save-temp-file', async (event, fileName, fileData) => {
  const tempDir = os.tmpdir();
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(fileData));
  return filePath;
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    return data;
  } catch (err) {
    console.error('Error reading file:', err);
    return null;
  }
});
