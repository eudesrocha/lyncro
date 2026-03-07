// tests/auth.test.js — Testes unitários para server/auth.js
// Execute: node --test tests/auth.test.js

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Mock de fetch para simular respostas do Supabase
let mockFetchResponse = null;
global.fetch = async (url, options) => {
    if (mockFetchResponse === null) throw new Error('Network error simulado');
    return mockFetchResponse;
};

describe('auth.js — verifySupabaseToken', () => {
    let verifySupabaseToken;

    beforeEach(() => {
        // Limpar cache do require para reiniciar variáveis de módulo (env vars)
        delete require.cache[require.resolve('../server/auth')];
        process.env.SUPABASE_URL = 'https://fake.supabase.co';
        process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
        ({ verifySupabaseToken } = require('../server/auth'));
    });

    afterEach(() => {
        mockFetchResponse = null;
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_ANON_KEY;
    });

    test('retorna null para token vazio', async () => {
        const result = await verifySupabaseToken('');
        assert.equal(result, null);
    });

    test('retorna null para token undefined/null', async () => {
        assert.equal(await verifySupabaseToken(null), null);
        assert.equal(await verifySupabaseToken(undefined), null);
    });

    test('retorna null se SUPABASE_URL não configurado', async () => {
        delete require.cache[require.resolve('../server/auth')];
        delete process.env.SUPABASE_URL;
        const { verifySupabaseToken: verify } = require('../server/auth');
        const result = await verify('token-qualquer');
        assert.equal(result, null);
    });

    test('retorna null se SUPABASE_ANON_KEY não configurado', async () => {
        delete require.cache[require.resolve('../server/auth')];
        delete process.env.SUPABASE_ANON_KEY;
        const { verifySupabaseToken: verify } = require('../server/auth');
        const result = await verify('token-qualquer');
        assert.equal(result, null);
    });

    test('retorna dados do usuário em resposta 200 válida', async () => {
        const fakeUser = { id: 'uid-123', email: 'user@test.com' };
        mockFetchResponse = {
            ok: true,
            json: async () => fakeUser
        };
        const result = await verifySupabaseToken('valid-token');
        assert.deepEqual(result, fakeUser);
    });

    test('retorna null em resposta não-ok (401, 403)', async () => {
        mockFetchResponse = { ok: false };
        const result = await verifySupabaseToken('expired-token');
        assert.equal(result, null);
    });

    test('retorna null se fetch lançar exceção (rede offline)', async () => {
        mockFetchResponse = null; // trigger network error
        const result = await verifySupabaseToken('algum-token');
        assert.equal(result, null);
    });
});
