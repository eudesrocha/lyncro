const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const setupSignaling = require('./signaling');
const roomManager = require('./rooms');
const billingRouter = require('./billing');
const { verifySupabaseToken, getUserPlan } = require('./auth');

const app = express();
const server = http.createServer(app);

// Converte o nome digitado pelo usuário num slug URL-safe
// "Masterclass Tech 2024!" → "Masterclass-Tech-2024"
function slugifyRoomName(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
        .trim()
        .replace(/\s+/g, '-')          // espaços → hífen
        .replace(/[^\w\-]/g, '')       // remove chars especiais (mantém letras, dígitos, _ e -)
        .replace(/-{2,}/g, '-')        // múltiplos hífens → um
        .replace(/^-+|-+$/g, '')       // remove hífens nas pontas
        .slice(0, 80);                 // limite de comprimento
}

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

app.get('/api/rooms', async (req, res) => {
    // Em produção (Supabase configurado), exigir autenticação para listar salas.
    // Isso evita enumeração de IDs de sala por terceiros.
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
        const auth = req.headers.authorization || '';
        const token = auth.replace(/^Bearer\s+/i, '');
        const user = await verifySupabaseToken(token);
        if (!user) return res.status(401).json({ error: 'Autenticação necessária.' });
    }
    const rooms = Array.from(roomManager.rooms.keys()).map(id => roomManager.getRoom(id));
    res.json(rooms);
});

app.get('/api/rooms/:id', (req, res) => {
    const room = roomManager.getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
    res.json(room);
});

app.post('/api/rooms', async (req, res) => {
    // Se Supabase estiver configurado, exigir autenticação e plano
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
        const auth = req.headers.authorization || '';
        const token = auth.replace(/^Bearer\s+/i, '');
        const supabaseUser = await verifySupabaseToken(token);

        if (!supabaseUser) {
            return res.status(401).json({ error: 'Autenticação necessária para criar uma sala.' });
        }

        // Verificar plano do usuário
        const plan = await getUserPlan(supabaseUser.id);
        if (plan !== 'pro') {
            // Contar quantas salas o usuário FREE já tem ativas (limite: 1 simultânea)
            const userRooms = Array.from(roomManager.rooms.values())
                .filter(r => r.hostUserId === supabaseUser.id);
            if (userRooms.length >= 1) {
                return res.status(403).json({
                    error: 'Plano FREE permite apenas 1 sala ativa por vez. Assine o plano PRO para criar mais.',
                    upgrade: true
                });
            }
        }

        // Armazenar userId no metadata da sala para rastreamento
        const { password } = req.body;
        const name = slugifyRoomName(req.body.name);
        if (!name) return res.status(400).json({ error: 'Nome da sala inválido.' });
        const roomId = roomManager.createRoom(name, password, supabaseUser.id);
        console.log(`[ROOM CREATED] "${name}" por userId=${supabaseUser.id} (plano=${plan})`);
        return res.json({ roomId, plan });
    }

    // Dev mode sem Supabase: criar sala sem restrição (com aviso)
    console.warn('[ROOM CREATED] Dev mode — sem verificação de auth/plano.');
    const { password } = req.body;
    const name = slugifyRoomName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Nome da sala inválido.' });
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
