const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startDrag: (fileName) => ipcRenderer.send('ondragstart', fileName),
  saveTempFile: (fileName, fileData) => ipcRenderer.invoke('save-temp-file', fileName, fileData),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_, status) => cb(status)),
  installUpdate: () => ipcRenderer.send('install-update')
});
