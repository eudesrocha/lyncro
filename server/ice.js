const twilio = require('twilio');

// IMPORTANTE: O usuário deve configurar estas variáveis de ambiente
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

async function getIceServers() {
    // Fallback padrão com STUN do Google (Sempre útil)
    const defaultIce = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ];

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        console.warn('⚠️  [ICE] Twilio credentials NOT found. Using default STUN servers ONLY.');
        return defaultIce;
    }

    try {
        console.log('🌐 [ICE] Fetching dynamic TURN credentials from Twilio...');
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const token = await client.tokens.create();

        console.log(`✅ [ICE] Successfully generated ${token.iceServers.length} ICE candidates from Twilio.`);
        // Retorna a lista completa (STUN + TURN dinâmico)
        return [
            ...defaultIce,
            ...token.iceServers
        ];
    } catch (err) {
        console.error('Error fetching Twilio ICE servers:', err);
        return defaultIce;
    }
}

module.exports = { getIceServers };
