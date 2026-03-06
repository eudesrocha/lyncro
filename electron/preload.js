const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyncroAPI', {
    sendNDIControl: (data) => ipcRenderer.invoke('toggle-ndi', data),
    getLocalIp: () => ipcRenderer.invoke('get-local-ip')
});
