const twilio = require('twilio');

// IMPORTANTE: O usuário deve configurar estas variáveis de ambiente
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

// Cache com TTL de 60s para evitar chamadas repetidas à API paga do Twilio
const CACHE_TTL_MS = 60 * 1000;
let iceCache = null;
let iceCacheExpiresAt = 0;

// STUN gratuito (disponível para todos os planos)
const STUN_ONLY = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
];

/**
 * Retorna ICE servers para o cliente.
 * @param {boolean} isPro - Se true, inclui TURN servers do Twilio (pago).
 *                          Se false, retorna apenas STUN gratuito.
 */
async function getIceServers(isPro = false) {
    // Plano FREE ou dev sem Twilio: apenas STUN gratuito
    if (!isPro || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        if (!isPro) console.log('[ICE] Plano FREE — fornecendo apenas STUN (sem TURN Twilio).');
        else console.warn('[ICE] Twilio credentials NOT found. Using default STUN servers ONLY.');
        return STUN_ONLY;
    }

    // Retornar cache se ainda válido
    if (iceCache && Date.now() < iceCacheExpiresAt) {
        console.log('[ICE] Returning cached TURN+STUN ICE servers (PRO).');
        return iceCache;
    }

    try {
        console.log('[ICE] Fetching dynamic TURN credentials from Twilio (PRO)...');
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const token = await client.tokens.create();

        console.log(`[ICE] Successfully generated ${token.iceServers.length} ICE candidates from Twilio.`);
        const servers = [...STUN_ONLY, ...token.iceServers];

        iceCache = servers;
        iceCacheExpiresAt = Date.now() + CACHE_TTL_MS;

        return servers;
    } catch (err) {
        console.error('[ICE] Error fetching Twilio ICE servers:', err);
        // Se temos cache expirado, melhor usá-lo do que retornar só STUN
        if (iceCache) {
            console.warn('[ICE] Using stale cache as fallback.');
            return iceCache;
        }
        return STUN_ONLY;
    }
}

module.exports = { getIceServers };
