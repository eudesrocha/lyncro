const twilio = require('twilio');

// IMPORTANTE: O usuário deve configurar estas variáveis de ambiente
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

// Cache com TTL de 60s para evitar chamadas repetidas à API paga do Twilio
const CACHE_TTL_MS = 60 * 1000;
let iceCache = null;
let iceCacheExpiresAt = 0;

async function getIceServers() {
    // Fallback padrão com STUN do Google (Sempre útil)
    const defaultIce = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ];

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        console.warn('[ICE] Twilio credentials NOT found. Using default STUN servers ONLY.');
        return defaultIce;
    }

    // Retornar cache se ainda válido
    if (iceCache && Date.now() < iceCacheExpiresAt) {
        console.log('[ICE] Returning cached ICE servers.');
        return iceCache;
    }

    try {
        console.log('[ICE] Fetching dynamic TURN credentials from Twilio...');
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const token = await client.tokens.create();

        console.log(`[ICE] Successfully generated ${token.iceServers.length} ICE candidates from Twilio.`);
        const servers = [...defaultIce, ...token.iceServers];

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
        return defaultIce;
    }
}

module.exports = { getIceServers };
