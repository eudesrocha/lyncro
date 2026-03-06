const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
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

// Gerenciamento de NDI e Janelas Offscreen
let grandiose;
try {
    grandiose = require('grandiose');
    console.log('NGI: Biblioteca grandiose carregada com sucesso.');
} catch (e) {
    console.warn('NDI: Biblioteca grandiose não encontrada. Usando mock para desenvolvimento.');
}

let ndiSources = {}; // Fontes NDI ativas: { participantId: { sender, offScreenWin } }

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

function createOffscreenWindow(participantId, streamName, roomName) {
    const offScreenWin = new BrowserWindow({
        show: false,
        webPreferences: {
            offscreen: true,
            transparent: true,
            contextIsolation: true
        }
    });

    // Ajustar para resolução padrão (720p)
    offScreenWin.setSize(1280, 720);

    const APP_URL = process.env.LYNCRO_URL || 'http://localhost:3000';
    const url = `${APP_URL}/cleanfeed.html?room=${roomName}&participant=${participantId}`;
    offScreenWin.loadURL(url);

    offScreenWin.webContents.on('paint', (event, dirty, image) => {
        if (ndiSources[participantId] && ndiSources[participantId].sender) {
            // Enviar frame para o NDI via grandiose
            // O buffer do Electron é BGRA32, compatível com NDI_VIDEO_TYPE_BGRX
            ndiSources[participantId].sender.send({
                video: {
                    data: image.getBitmap(),
                    width: 1280,
                    height: 720,
                    pixelFormat: 4 // NDI_PIXEL_FORMAT_TYPE_BGRX
                }
            });
        }
    });

    return offScreenWin;
}

// Escuta o comando vindo da interface (Dashboard)
ipcMain.handle('toggle-ndi', async (event, { participantId, streamName, isActive, roomName }) => {
    try {
        if (isActive) {
            if (!ndiSources[participantId]) {
                console.log(`Ativando NDI Real para: ${streamName} (Sala: ${roomName})`);

                let sender = null;
                if (grandiose) {
                    sender = await grandiose.send({
                        name: streamName,
                        groups: '',
                        clockVideo: true,
                        clockAudio: false
                    });
                } else {
                    console.log(`[MOCK NDI] Sender criado: ${streamName}`);
                    sender = { send: () => { } }; // Mock
                }

                const offScreenWin = createOffscreenWindow(participantId, streamName, roomName);
                ndiSources[participantId] = { sender, offScreenWin };
            }
            return { status: 'active' };
        } else {
            if (ndiSources[participantId]) {
                console.log(`Desativando NDI: ${participantId}`);
                if (ndiSources[participantId].offScreenWin) {
                    ndiSources[participantId].offScreenWin.close();
                }
                // No grandiose real, o sender é fechado quando o processo termina ou via garbage collection
                // Algumas versões podem requerer cleanup manual se disponível
                delete ndiSources[participantId];
            }
            return { status: 'inactive' };
        }
    } catch (err) {
        console.error("Erro no toggle-ndi:", err);
        return { status: 'error', message: err.message };
    }
});

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
