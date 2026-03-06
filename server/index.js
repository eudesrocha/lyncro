const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const setupSignaling = require('./signaling');
const roomManager = require('./rooms');

const app = express();
const server = http.createServer(app);

// Configuração para Nuvem (Heroku, Railway, etc.)
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API Endpoints
app.get('/api/rooms', (req, res) => {
    const rooms = Array.from(roomManager.rooms.keys()).map(id => roomManager.getRoom(id));
    res.json(rooms);
});

app.post('/api/rooms', (req, res) => {
    const { name } = req.body;
    const roomId = roomManager.createRoom(name);
    res.json({ roomId });
});

// Setup WebSocket Signaling
setupSignaling(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let localIp = 'localhost';

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIp = iface.address;
                break;
            }
        }
    }
    console.log(`\n🚀 Lyncro Server ativo!`);
    console.log(`Acesso local: http://localhost:${PORT}`);
    console.log(`Acesso na rede: http://${localIp}:${PORT}\n`);
});
