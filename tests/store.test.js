// tests/store.test.js — Testes unitários para server/store.js
// Usa node:test nativo (Node 18+). Execute: node --test tests/store.test.js

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Substitui o STORE_PATH por um arquivo temporário para não poluir o projeto
const tmpPath = path.join(os.tmpdir(), `lyncro-test-store-${Date.now()}.json`);

// Patch antes de require para que store.js use o caminho temporário
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'path' && parent?.filename?.includes('store.js')) {
        const pathModule = originalLoad.call(this, request, parent, isMain);
        return {
            ...pathModule,
            join: (...args) => {
                const result = pathModule.join(...args);
                if (result.endsWith('rooms-store.json')) return tmpPath;
                return result;
            }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

// Agora importamos o store (usará o path temporário)
let store;
describe('store.js', () => {
    beforeEach(() => {
        // Limpar arquivo temporário e reiniciar o módulo
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        // Limpar cache do require para reiniciar o estado interno do store
        delete require.cache[require.resolve('../server/store')];
        store = require('../server/store');
    });

    afterEach(() => {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    });

    test('setRoom persiste sala e getRoom retorna os dados', () => {
        store.setRoom('sala-1', { password: 'abc123', hostUserId: 'user-xyz' });
        const room = store.getRoom('sala-1');
        assert.equal(room.password, 'abc123');
        assert.equal(room.hostUserId, 'user-xyz');
        assert.ok(room.createdAt, 'createdAt deve estar definido');
    });

    test('getRoom retorna null para sala inexistente', () => {
        const room = store.getRoom('nao-existe');
        assert.equal(room, null);
    });

    test('deleteRoom remove a sala', () => {
        store.setRoom('sala-2', { password: null, hostUserId: null });
        store.deleteRoom('sala-2');
        assert.equal(store.getRoom('sala-2'), null);
    });

    test('setRoom preserva createdAt em atualizações', () => {
        store.setRoom('sala-3', { password: 'pass1', hostUserId: null });
        const first = store.getRoom('sala-3');
        store.setRoom('sala-3', { password: 'pass2', hostUserId: 'uid-1' });
        const second = store.getRoom('sala-3');
        assert.equal(second.createdAt, first.createdAt, 'createdAt não deve mudar em updates');
        assert.equal(second.password, 'pass2');
    });

    test('setRoom persiste em disco (arquivo JSON)', () => {
        store.setRoom('sala-disk', { password: 'disktest', hostUserId: 'u1' });
        const raw = fs.readFileSync(tmpPath, 'utf8');
        const parsed = JSON.parse(raw);
        assert.ok(parsed['sala-disk'], 'sala deve estar no arquivo JSON');
        assert.equal(parsed['sala-disk'].password, 'disktest');
    });

    test('deleteRoom em sala inexistente não lança erro', () => {
        assert.doesNotThrow(() => store.deleteRoom('fantasma'));
    });
});
