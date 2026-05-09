const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startDrag: (fileName) => ipcRenderer.send('ondragstart', fileName),
  saveTempFile: (fileName, fileData) => ipcRenderer.invoke('save-temp-file', fileName, fileData),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath)
});
