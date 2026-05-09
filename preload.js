const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startDrag: (fileName) => ipcRenderer.send('ondragstart', fileName),
  saveTempFile: (fileName, fileData) => ipcRenderer.invoke('save-temp-file', fileName, fileData),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_, status) => cb(status)),
  installUpdate: () => ipcRenderer.send('install-update'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onDeepLink: (cb) => ipcRenderer.on('deep-link', (_, code) => cb(code)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates')
});
