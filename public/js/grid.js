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

function init() {
    setupWebSocket();
}

// ── Lógica de Re-Cálculo de Grade (Matemática Flex/Grid) ─────────────
function calculateGrid() {
    const container = document.getElementById('grid-container');
    const loading = document.getElementById('loading');

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

    // Usaremos CSS Grid dinâmico em vez de flex complexo
    let cols = 1;
    let rows = 1;

    if (count === 1) { cols = 1; rows = 1; }
    else if (count === 2) { cols = 2; rows = 1; }
    else if (count === 3 || count === 4) { cols = 2; rows = 2; }
    else if (count === 5 || count === 6) { cols = 3; rows = 2; }
    else if (count >= 7 && count <= 9) { cols = 3; rows = 3; }
    else if (count >= 10) { cols = 4; rows = 3; }

    container.style.display = 'grid';
    container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
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
                // Atualizar cache de nomes
                data.participants.forEach(p => {
                    participantsData.set(p.id, p);
                    updateCellInfo(p.id);
                });

                // Ligar para todo mundo que não for observer
                data.participants.forEach(p => {
                    if (p.role !== 'observer' && p.status !== 'disconnected') {
                        if (!rtcClient.peers.has(p.id)) {
                            console.log(`[Grid] Solicitando vídeo de: ${p.id} (${p.name})`);
                            initiateConnection(p.id);
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
