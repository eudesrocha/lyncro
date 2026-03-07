// Persistência leve de metadados de sala em arquivo JSON.
// Armazena apenas: roomId, password, hostUserId, createdAt.
// Participantes são transientes (têm WebSocket) e nunca são persistidos.

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'rooms-store.json');
const ROOM_TTL_MS = 48 * 60 * 60 * 1000; // 48 horas

let store = {}; // { [roomId]: { password, hostUserId, createdAt } }

function load() {
    try {
        if (fs.existsSync(STORE_PATH)) {
            store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
            purgeExpired();
            console.log(`[Store] ${Object.keys(store).length} sala(s) carregada(s) do disco.`);
        }
    } catch (err) {
        console.error('[Store] Erro ao carregar store:', err.message);
        store = {};
    }
}

function save() {
    try {
        fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
    } catch (err) {
        console.error('[Store] Erro ao salvar store:', err.message);
    }
}

function purgeExpired() {
    const now = Date.now();
    let purged = 0;
    for (const [id, meta] of Object.entries(store)) {
        if (now - meta.createdAt > ROOM_TTL_MS) {
            delete store[id];
            purged++;
        }
    }
    if (purged > 0) {
        console.log(`[Store] ${purged} sala(s) expirada(s) removida(s).`);
        save();
    }
}

function setRoom(roomId, { password = null, hostUserId = null }) {
    store[roomId] = {
        password: password || null,
        hostUserId: hostUserId || null,
        createdAt: store[roomId]?.createdAt || Date.now()
    };
    save();
}

function getRoom(roomId) {
    return store[roomId] || null;
}

function deleteRoom(roomId) {
    if (store[roomId]) {
        delete store[roomId];
        save();
    }
}

// Carregar ao inicializar
load();

module.exports = { setRoom, getRoom, deleteRoom };
