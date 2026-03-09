const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyncroAPI', {
    getLocalIp: () => ipcRenderer.invoke('get-local-ip')
});
