/**
 * Configurações Globais do Lyncro
 *
 * SIGNALING_URL é resolvido automaticamente:
 *   1. Busca /api/config do servidor (definido via env var SIGNALING_URL)
 *   2. Se não configurado, usa auto-detect baseado na origem da página (ideal para Render/Railway)
 *   3. Para deploy cross-domain, defina SIGNALING_URL no servidor (ex: wss://seu-lyncro.onrender.com)
 */
window.LYNCRO_CONFIG = {
    SIGNALING_URL: null, // Preenchido abaixo via /api/config
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Promise que resolve quando a config estiver pronta.
// setupWebSocket() em host.js, guest.js e cleanfeed.js aguarda esta promise
// para evitar race condition ao ler SIGNALING_URL.
window.LYNCRO_CONFIG_READY = (async () => {
    try {
        const res = await fetch('/api/config');
        if (res.ok) {
            const data = await res.json();
            if (data.signalingUrl) {
                window.LYNCRO_CONFIG.SIGNALING_URL = data.signalingUrl;
            }
        }
    } catch (e) {
        // Silencioso — auto-detect será usado por host.js/guest.js
    }
})();
