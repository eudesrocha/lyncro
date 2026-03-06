/**
 * Configurações Globais do Lyncro
 * 
 * Para PRODUÇÃO: Altere a URL abaixo para o domínio do seu servidor na nuvem.
 * Exemplo: 'wss://seu-lyncro.up.railway.app'
 * 
 * Se deixado como null, o sistema tentará detectar automaticamente (ideal para local/wifi).
 */
window.LYNCRO_CONFIG = {
    SIGNALING_URL: 'wss://lyncro.live', // Domínio profissional adquirido pelo usuário
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};
