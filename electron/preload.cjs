const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (key, value) => ipcRenderer.invoke('save-settings', key, value),
    generateTheme: (lyricsText) => ipcRenderer.invoke('generate-theme', lyricsText),
    getNeteasePort: () => ipcRenderer.invoke('get-netease-port')
});
