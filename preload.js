const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bp', {
  load: () => ipcRenderer.invoke('entries:load'),
  save: (entries) => ipcRenderer.invoke('entries:save', entries),
  exportCsv: (entries) => ipcRenderer.invoke('entries:exportCsv', entries),
  importCsv: () => ipcRenderer.invoke('entries:importCsv'),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  loadPrefs: () => ipcRenderer.invoke('prefs:load'),
  savePrefs: (prefs) => ipcRenderer.invoke('prefs:save', prefs),
  openPrefsFile: () => ipcRenderer.invoke('prefs:openFile'),
  dataInfo: () => ipcRenderer.invoke('data:info'),
  chooseDataFolder: () => ipcRenderer.invoke('data:chooseFolder'),
  useDefaultDataFolder: () => ipcRenderer.invoke('data:useDefaultFolder'),
  confirmDelete: (message) => ipcRenderer.invoke('app:confirmDelete', message),
});
