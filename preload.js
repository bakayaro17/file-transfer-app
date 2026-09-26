const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  // Window / app
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onDeepLink: (cb) => ipcRenderer.on('deep-link', (_, code) => cb(code)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Updates
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_, status) => cb(status)),
  installUpdate: () => ipcRenderer.send('install-update'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  // Received items: drag out or save
  startDrag: (filePath) => ipcRenderer.send('ondragstart', filePath),
  onDragError: (cb) => ipcRenderer.on('drag-error', (_, msg) => cb(msg)),
  saveReceived: (srcPath, name, isDir) => ipcRenderer.invoke('save-received', srcPath, name, isDir),

  // Sending from paths (drop, picker, paste, clipboard sync)
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
  },
  expandPaths: (paths) => ipcRenderer.invoke('expand-paths', paths),
  readOpen: (absPath) => ipcRenderer.invoke('read-open', absPath),
  readChunk: (handle, offset, length) => ipcRenderer.invoke('read-chunk', handle, offset, length),
  readClose: (handle) => ipcRenderer.invoke('read-close', handle),

  // Receiving: stream to disk
  recvStart: (key, meta) => ipcRenderer.invoke('recv-start', key, meta),
  recvChunk: (key, data) => ipcRenderer.invoke('recv-chunk', key, data),
  recvEnd: (key) => ipcRenderer.invoke('recv-end', key),
  recvAbort: (key) => ipcRenderer.invoke('recv-abort', key),

  // Clipboard sync
  setClipboardSync: (on) => ipcRenderer.send('clipboard-sync-set', !!on),
  reportPasteFiles: (paths) => ipcRenderer.invoke('clipboard-paste-report', paths),
  writeClipboardFiles: (paths) => ipcRenderer.invoke('clipboard-write', paths),
  readClipboardFiles: () => ipcRenderer.invoke('clipboard-read-now'),
  onClipboardFiles: (cb) => ipcRenderer.on('clipboard-files', (_, paths) => cb(paths))
});
