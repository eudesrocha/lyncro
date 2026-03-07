// tests/rooms.test.js — Testes unitários para server/rooms.js
// Execute: node --test tests/rooms.test.js

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Mock do persistentStore para isolar rooms.js do disco
const mockStore = {
    data: {},
    getRoom(id) { return this.data[id] || null; },
    setRoom(id, meta) { this.data[id] = { ...meta, createdAt: Date.now() }; },
    deleteRoom(id) { delete this.data[id]; },
    reset() { this.data = {}; }
};

// Substituir require('./store') por mockStore
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === './store' && parent?.filename?.includes('rooms.js')) {
        return mockStore;
    }
    return originalLoad.call(this, request, parent, isMain);
};

let roomManager;
describe('rooms.js — RoomManager', () => {
    beforeEach(() => {
        mockStore.reset();
        delete require.cache[require.resolve('../server/rooms')];
        roomManager = require('../server/rooms');
    });

    test('createRoom cria sala e retorna o roomId', () => {
        const id = roomManager.createRoom('minha-sala');
        assert.equal(id, 'minha-sala');
        assert.ok(roomManager.rooms.has('minha-sala'));
    });

    test('createRoom não duplica sala existente', () => {
        roomManager.createRoom('sala-x', 'pass1');
        roomManager.createRoom('sala-x', 'pass2'); // não deve sobrescrever
        const room = roomManager.rooms.get('sala-x');
        assert.equal(room.password, 'pass1');
    });

    test('joinRoom adiciona host e retorna participante', () => {
        const p = roomManager.joinRoom('sala-host', {
            name: 'Produtor',
            role: 'host',
            userId: 'uid-host-1'
        });
        assert.ok(p.id, 'participante deve ter id');
        assert.equal(p.role, 'host');
        assert.equal(p.status, 'accepted');
        const room = roomManager.rooms.get('sala-host');
        assert.equal(room.host, p.id);
        assert.equal(room.hostUserId, 'uid-host-1');
    });

    test('joinRoom adiciona guest com status waiting', () => {
        roomManager.joinRoom('sala-g', { name: 'Host', role: 'host', userId: 'h1' });
        const guest = roomManager.joinRoom('sala-g', { name: 'Convidado', role: 'guest' });
        assert.equal(guest.status, 'waiting');
        assert.equal(guest.role, 'guest');
    });

    test('joinRoom rejeita host de outro userId', () => {
        roomManager.joinRoom('sala-owned', { name: 'Dono', role: 'host', userId: 'uid-dono' });
        const result = roomManager.joinRoom('sala-owned', { name: 'Intruso', role: 'host', userId: 'uid-intruso' });
        assert.ok(result.rejected, 'deve rejeitar host diferente');
        assert.ok(result.reason.includes('outro usuário'));
    });

    test('joinRoom permite mesmo userId reconectar como host', () => {
        roomManager.joinRoom('sala-re', { name: 'Host', role: 'host', userId: 'uid-re' });
        const result = roomManager.joinRoom('sala-re', { name: 'Host', role: 'host', userId: 'uid-re' });
        assert.ok(!result.rejected, 'mesmo usuário deve poder reconectar');
    });

    test('leaveRoom remove participante', () => {
        const host = roomManager.joinRoom('sala-leave', { name: 'Host', role: 'host', userId: 'u1' });
        const guest = roomManager.joinRoom('sala-leave', { name: 'Guest', role: 'guest' });
        roomManager.leaveRoom('sala-leave', guest.id);
        const participants = roomManager.getParticipants('sala-leave');
        assert.ok(!participants.find(p => p.id === guest.id));
    });

    test('leaveRoom remove sala da memória quando vazia', () => {
        const host = roomManager.joinRoom('sala-empty', { name: 'Host', role: 'host', userId: 'u1' });
        roomManager.leaveRoom('sala-empty', host.id);
        assert.ok(!roomManager.rooms.has('sala-empty'));
    });

    test('updateParticipant atualiza campos do participante', () => {
        const host = roomManager.joinRoom('sala-update', { name: 'Host', role: 'host', userId: 'u1' });
        const guest = roomManager.joinRoom('sala-update', { name: 'Guest', role: 'guest' });
        roomManager.updateParticipant('sala-update', guest.id, { status: 'accepted', tallyState: 'program' });
        const participants = roomManager.getParticipants('sala-update');
        const updated = participants.find(p => p.id === guest.id);
        assert.equal(updated.status, 'accepted');
        assert.equal(updated.tallyState, 'program');
    });

    test('getRoom exclui ws e userId da resposta pública', () => {
        const fakeWs = { send: () => {}, readyState: 1 };
        roomManager.joinRoom('sala-pub', { name: 'Host', role: 'host', userId: 'u1', ws: fakeWs });
        const room = roomManager.getRoom('sala-pub');
        const host = room.participants[0];
        assert.ok(!('ws' in host), 'ws não deve aparecer na resposta pública');
        assert.ok(!('userId' in host), 'userId não deve aparecer na resposta pública');
    });

    test('getParticipants retorna lista vazia para sala inexistente', () => {
        const parts = roomManager.getParticipants('nao-existe');
        assert.deepEqual(parts, []);
    });
});
