const urlParams = new URLSearchParams(window.location.search);
const roomName = urlParams.get('room') || 'default';
const isHostMode = urlParams.get('host') === 'true'; // Mostra ferramentas?

if (isHostMode) {
    document.getElementById('host-toolbar').style.display = 'flex';
}

let rtcClient;
let ws;
let myId;
let participantsData = new Map(); // id -> { name, role }
let activeStreams = new Map(); // id -> stream
let videoElements = new Map(); // id -> videoEl
let currentLayout = 'auto-grid';

function init() {
    setupWebSocket();
}

// ── Lógica de Re-Cálculo de Grade (Matemática Flex/Grid) ─────────────
function calculateGrid() {
    const loading = document.getElementById('loading');
    const container = document.getElementById('grid-container');

    const count = activeStreams.size;
    if (count > 0) {
        if (loading) loading.style.opacity = '0';
        setTimeout(() => { if (loading) loading.style.display = 'none'; }, 500);
    } else {
        if (loading) {
            loading.style.display = 'flex';
            setTimeout(() => { loading.style.opacity = '1'; }, 50);
        }
    }

    // CNN Vertical: JS calcula colunas e altura com base na contagem
    if (currentLayout === 'cnn-vertical') {
        const c = count || 1;
        let cols, rows;
        if (c <= 5)      { cols = c; rows = 1; }
        else if (c <= 6) { cols = 3; rows = 2; }
        else if (c <= 8) { cols = 4; rows = 2; }
        else if (c <= 9) { cols = 3; rows = 3; }
        else             { cols = 5; rows = Math.ceil(c / 5); }

        const h = `calc(${100 / rows}vh - ${rows > 1 ? 1 : 0}px)`;
        const cells = document.querySelectorAll('.grid-cell');
        cells.forEach(cell => {
            const basis = `calc(${100 / cols}% - ${cols > 1 ? 1 : 0}px)`;
            cell.style.flex = `0 1 ${basis}`;
            cell.style.maxWidth = basis;
            cell.style.height = h;
        });
        return;
    }

    // Demais layouts especiais: CSS cuida do visual, limpar inline styles
    if (currentLayout !== 'auto-grid') {
        const cells = document.querySelectorAll('.grid-cell');
        cells.forEach(cell => {
            cell.style.flex = '';
            cell.style.maxWidth = '';
            cell.style.height = '';
        });
        return;
    }

    // Usamos regras flexíveis baseadas na contagem de pessoas
    let basis = '100%';
    if (count === 1) basis = '100%';
    else if (count >= 2 && count <= 4) basis = 'calc(50% - 8px)'; // (gap de 16px dividido)
    else if (count >= 5 && count <= 9) basis = 'calc(33.333% - 11px)';
    else if (count >= 10) basis = 'calc(25% - 12px)';

    const cells = document.querySelectorAll('.grid-cell');
    cells.forEach(cell => {
        cell.style.flex = `0 1 ${basis}`;
        cell.style.maxWidth = basis;
        cell.style.height = '';
    });
}

function applyLayout(layoutId) {
    const container = document.getElementById('grid-container');
    if (!container) return;

    // Remover classes antigas
    container.classList.remove('layout-auto-grid', 'layout-cnn-split', 'layout-cnn-vertical', 'layout-speaker-highlight');

    // Adicionar nova
    container.classList.add(`layout-${layoutId}`);
    currentLayout = layoutId;

    console.log(`[Grid] Layout aplicado: ${layoutId}`);
    calculateGrid();
}

function updateCellInfo(id) {
    const cell = document.getElementById(`grid-cell-${id}`);
    if (!cell) return;
    const badge = cell.querySelector('.name-badge-text');
    const roleIcon = cell.querySelector('.role-icon');

    const pData = participantsData.get(id);
    if (pData && badge) {
        badge.textContent = pData.name || 'Convidado';
        if (roleIcon) {
            roleIcon.className = pData.role === 'host' ? 'ph-fill ph-star text-yellow-500 role-icon' : 'ph ph-user text-gray-400 role-icon';
        }
    }
}

function createVideoCell(id, stream) {
    let cell = document.getElementById(`grid-cell-${id}`);
    if (!cell) {
        cell = document.createElement('div');
        cell.id = `grid-cell-${id}`;
        cell.className = 'grid-cell';

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = isHostMode; // Se for o dono espiando, muta o P2P da aba para não dar eco. OBS ouve normal.

        const badge = document.createElement('div');
        badge.className = 'name-badge';
        badge.innerHTML = `<i class="ph ph-user text-gray-400 role-icon"></i> <span class="name-badge-text">Conectando...</span>`;

        cell.appendChild(video);
        cell.appendChild(badge);

        document.getElementById('grid-container').appendChild(cell);
        videoElements.set(id, video);
    }

    const video = cell.querySelector('video');
    if (video.srcObject !== stream) {
        video.srcObject = stream;
        video.onloadedmetadata = () => video.play().catch(console.error);
    }

    updateCellInfo(id);
    calculateGrid();
}

function removeVideoCell(id) {
    const cell = document.getElementById(`grid-cell-${id}`);
    if (cell) {
        cell.style.transform = 'scale(0.8)';
        cell.style.opacity = '0';
        setTimeout(() => {
            cell.remove();
            activeStreams.delete(id);
            videoElements.delete(id);
            calculateGrid();
        }, 300); // tempo da animação
    } else {
        activeStreams.delete(id);
        videoElements.delete(id);
        calculateGrid();
    }
}

// ── Lógica Redes WebRTC & WebSocket ────────────────────────────────────

async function initiateConnection(targetId) {
    const offer = await rtcClient.createOffer(targetId);
    ws.send(JSON.stringify({ type: 'offer', roomId: roomName, to: targetId, offer }));
}

function handleRemoteTrack(targetId, stream) {
    console.log(`[Grid] Track recebida de ${targetId}. Has Audio: ${stream.getAudioTracks().length > 0}`);
    activeStreams.set(targetId, stream);
    createVideoCell(targetId, stream);
}

function handleIceCandidate(targetId, candidate) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ice-candidate', roomId: roomName, to: targetId, candidate }));
    }
}

async function setupWebSocket() {
    if (window.LYNCRO_CONFIG_READY) await window.LYNCRO_CONFIG_READY;

    let wsUrl = window.LYNCRO_CONFIG?.SIGNALING_URL || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log(`[Grid] Conectado. Sala: ${roomName}`);
        rtcClient = new WebRTCClient(`OBS-GRID-${Date.now().toString().slice(-4)}`, handleRemoteTrack, handleIceCandidate);

        ws.send(JSON.stringify({
            type: 'join',
            roomId: roomName,
            participant: { name: 'Master Grid', role: 'observer' }
        }));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        switch (data.type) {
            case 'init-network':
                myId = data.yourId;
                if (rtcClient) rtcClient.updateConfig(data.iceServers);
                break;
            case 'participant-update':
                if (data.layout) {
                    applyLayout(data.layout);
                }
                // Atualizar cache de nomes (IGNORAR waiting - só accepted)
                data.participants.forEach(p => {
                    if (p.role !== 'observer' && p.status === 'accepted') {
                        participantsData.set(p.id, p);
                        updateCellInfo(p.id);
                    }
                });

                // Ligar para todo mundo que não for observer E que esteja ACCEPTED
                data.participants.forEach(p => {
                    if (p.role !== 'observer') {
                        if (p.status === 'accepted') {
                            if (!rtcClient.peers.has(p.id)) {
                                console.log(`[Grid] Solicitando vídeo de: ${p.id} (${p.name})`);
                                initiateConnection(p.id);
                            }
                        } else if (rtcClient.peers.has(p.id)) {
                            // Se alguem perdeu status de aceite (foi kickado ou posto em espera de novo) e ele tava ativo na tela
                            console.log(`[Grid] Participante perdeu aprovação: ${p.id}. Removendo do Dashboard.`);
                            rtcClient.removePeer(p.id);
                            removeVideoCell(p.id);
                        }
                    }
                });
                break;
            case 'offer':
                if (rtcClient) {
                    const answer = await rtcClient.handleOffer(data.from, data.offer);
                    ws.send(JSON.stringify({ type: 'answer', roomId: roomName, to: data.from, answer }));
                }
                break;
            case 'answer':
                if (rtcClient && rtcClient.peers.has(data.from)) {
                    await rtcClient.handleAnswer(data.from, data.answer);
                }
                break;
            case 'ice-candidate':
                if (rtcClient && rtcClient.peers.has(data.from)) {
                    await rtcClient.handleCandidate(data.from, data.candidate);
                }
                break;
            case 'participant-left':
            case 'peer-reconnected':
                if (rtcClient) rtcClient.removePeer(data.participantId);
                removeVideoCell(data.participantId);
                break;
        }
    };
}

// Iniciar ao carregar a janela
window.addEventListener('DOMContentLoaded', init);
