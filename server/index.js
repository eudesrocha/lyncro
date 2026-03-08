const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const setupSignaling = require('./signaling');
const roomManager = require('./rooms');
const billingRouter = require('./billing');

const app = express();
const server = http.createServer(app);

// Configuração para Nuvem (Heroku, Railway, etc.)
app.set('trust proxy', 1);

// CORS: em produção, restringir ao domínio configurado via ALLOWED_ORIGIN.
// Em desenvolvimento (localhost), aceita qualquer origem.
const allowedOrigin = process.env.ALLOWED_ORIGIN || null;
app.use(cors({
    origin: (origin, callback) => {
        // Requisições sem origin (ex: mobile apps, curl) sempre passam
        if (!origin) return callback(null, true);
        // Em dev (sem ALLOWED_ORIGIN), aceita tudo
        if (!allowedOrigin) return callback(null, true);
        // Em produção, valida contra o domínio configurado
        if (origin === allowedOrigin) return callback(null, true);
        callback(new Error(`CORS bloqueado: origem não permitida (${origin})`));
    },
    credentials: true
}));
// Billing router MUST come before express.json() so the webhook gets the raw body
app.use(billingRouter);

app.use(express.json());

// Anti-cache para arquivos estáticos (resolve cache agressivo em mobile Safari/Chrome)
app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// API Endpoints

// Injeta configuração no front-end (SIGNALING_URL pode ser definido via env var)
app.get('/api/config', (_req, res) => {
    const signalingUrl = process.env.SIGNALING_URL || null;
    res.json({ signalingUrl });
});

app.get('/api/rooms', (req, res) => {
    const rooms = Array.from(roomManager.rooms.keys()).map(id => roomManager.getRoom(id));
    res.json(rooms);
});

app.get('/api/rooms/:id', (req, res) => {
    const room = roomManager.getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
    res.json(room);
});

app.post('/api/rooms', (req, res) => {
    const { name, password } = req.body;
    const roomId = roomManager.createRoom(name, password);
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
