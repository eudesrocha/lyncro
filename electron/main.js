const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
        title: 'Lyncro Host Monitor',
        backgroundColor: '#1c1c1c'
    });

    // Carrega a tela de entrada (Lobby)
    const APP_URL = process.env.LYNCRO_URL || 'http://localhost:3000';
    win.loadURL(`${APP_URL}/index.html`);
}

ipcMain.handle('get-local-ip', () => getLocalIp());

// Inicialização
app.whenReady().then(() => {
    // URL principal do app (Nuvem ou Local)
    const APP_URL = process.env.LYNCRO_URL || 'http://localhost:3000';
    console.log(`Lyncro Studio iniciando em: ${APP_URL}`);

    // Iniciar o servidor integrado apenas se for localhost
    if (APP_URL.includes('localhost')) {
        try {
            require('../server/index.js');
        } catch (e) {
            if (e.code === 'EADDRINUSE') {
                console.log('Servidor já está rodando em outra instância.');
            }
        }
    }

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
