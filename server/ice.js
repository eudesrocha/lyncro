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
        console.warn('Twilio credentials not found. Using default STUN servers only.');
        return defaultIce;
    }

    try {
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const token = await client.tokens.create();

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
