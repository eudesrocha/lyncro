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
let showLabels = true;
let speakerHighlightActive = false;

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

    // CNN Vertical: width-based, portrait 9:16
    if (currentLayout === 'cnn-vertical') {
        const c = count || 1;
        let cols, rows;
        if (c <= 5)      { cols = c; rows = 1; }
        else if (c <= 6) { cols = 3; rows = 2; }
        else if (c <= 8) { cols = 4; rows = 2; }
        else if (c <= 9) { cols = 3; rows = 3; }
        else             { cols = 5; rows = Math.ceil(c / 5); }

        const gapPx = 2;
        const maxH = `calc((100vh - ${(rows - 1) * gapPx}px) / ${rows})`;
        const cells = document.querySelectorAll('.grid-cell');
        cells.forEach(cell => {
            const totalGap = (cols - 1) * gapPx;
            const w = `calc((100% - ${totalGap}px) / ${cols})`;
            cell.style.flex = `0 0 ${w}`;
            cell.style.maxWidth = w;
            cell.style.maxHeight = maxH;
            cell.style.height = '';
            cell.style.width = '';
        });
        return;
    }

    // Dynamic Cards: preenche a tela, sem 16:9. ceil(sqrt(n)) cols × ceil(n/cols) rows
    if (currentLayout === 'dynamic-cards') {
        const c = count || 1;
        const cols = Math.ceil(Math.sqrt(c));
        const rows = Math.ceil(c / cols);
        const gapPx = 12;
        const padPx = 12;
        const availW = container.clientWidth  - padPx * 2 - gapPx * (cols - 1);
        const availH = container.clientHeight - padPx * 2 - gapPx * (rows - 1);
        const cardW = Math.floor(availW / cols);
        const cardH = Math.floor(availH / rows);
        document.querySelectorAll('.grid-cell').forEach(cell => {
            cell.style.flex      = `0 0 ${cardW}px`;
            cell.style.width     = `${cardW}px`;
            cell.style.maxWidth  = `${cardW}px`;
            cell.style.height    = `${cardH}px`;
            cell.style.maxHeight = `${cardH}px`;
        });
        return;
    }

    // Portrait Cards: height-first — todas as linhas cabem na tela, espaço lateral é livre
    if (currentLayout === 'portrait-cards') {
        const c = count || 1;
        let cols, rows;
        if (c <= 5)      { cols = c; rows = 1; }
        else if (c <= 6) { cols = 3; rows = 2; }
        else if (c <= 8) { cols = 4; rows = 2; }
        else if (c <= 9) { cols = 3; rows = 3; }
        else             { cols = 5; rows = Math.ceil(c / 5); }

        const gapPx = 16;
        const paddingPx = 16;
        const availH = container.clientHeight - paddingPx * 2 - (rows - 1) * gapPx;
        const cellH = Math.round(availH / rows);
        const cellW = Math.round(cellH * 9 / 16);

        const cells = document.querySelectorAll('.grid-cell');
        cells.forEach(cell => {
            cell.style.flex = `0 0 ${cellW}px`;
            cell.style.width = `${cellW}px`;
            cell.style.maxWidth = `${cellW}px`;
            cell.style.height = `${cellH}px`;
            cell.style.maxHeight = `${cellH}px`;
        });
        return;
    }

    // Speaker Highlight: destaque à esquerda + miniaturas à direita
    if (currentLayout === 'speaker-highlight') {
        updateSpeakerHighlightLayout();
        return;
    }

    // CNN Split e demais layouts especiais: CSS cuida do visual, limpar inline styles
    if (currentLayout !== 'auto-grid') {
        const cells = document.querySelectorAll('.grid-cell');
        cells.forEach(cell => {
            cell.style.flex = '';
            cell.style.maxWidth = '';
            cell.style.height = '';
            cell.style.width = '';
            cell.style.maxHeight = '';
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

// ── Speaker Highlight helpers ─────────────────────────────────────────

function updateSpeakerHighlightLayout() {
    const container = document.getElementById('grid-container');
    const padPx = 8;
    const gapMain = 8;
    const gapThumb = 8;

    // Garantir sidebar
    let sidebar = document.getElementById('speaker-sidebar');
    if (!sidebar) {
        sidebar = document.createElement('div');
        sidebar.id = 'speaker-sidebar';
        container.appendChild(sidebar);
    }

    // Coletar todas as células (container direto + sidebar)
    const allCells = [
        ...Array.from(container.querySelectorAll(':scope > .grid-cell')),
        ...Array.from(sidebar.querySelectorAll('.grid-cell'))
    ];
    if (allCells.length === 0) return;

    // Reset e reclassificar
    allCells.forEach(c => c.classList.remove('featured-cell'));
    const featured = allCells[0];
    featured.classList.add('featured-cell');

    // Garantir que featured está no container (antes do sidebar)
    if (featured.parentElement !== container) container.insertBefore(featured, sidebar);
    // Resto vai para o sidebar
    for (let i = 1; i < allCells.length; i++) {
        if (allCells[i].parentElement !== sidebar) sidebar.appendChild(allCells[i]);
    }

    const thumbCount = allCells.length - 1;
    const containerW = container.clientWidth  - padPx * 2;
    const containerH = container.clientHeight - padPx * 2;

    if (thumbCount === 0) {
        sidebar.style.display = 'none';
        featured.style.flex = '1 1 auto';
        featured.style.width = `${containerW}px`;
        featured.style.height = `${containerH}px`;
        featured.style.maxWidth = '';
        featured.style.maxHeight = '';
        return;
    }
    sidebar.style.display = 'flex';

    // Colunas de miniaturas: 1 col para ≤4, 2 cols para ≤8, 3 cols para mais
    let thumbCols;
    if (thumbCount <= 4)      thumbCols = 1;
    else if (thumbCount <= 8) thumbCols = 2;
    else                      thumbCols = 3;

    // Aspect ratio do destaque muda conforme o número de colunas cresce
    //   1 col  → wide   (16:9)
    //   2 cols → square (1:1)
    //   3 cols → portrait (9:16)
    let featuredAR;
    if (thumbCols === 1)      featuredAR = 16 / 9;
    else if (thumbCols === 2) featuredAR = 1;
    else                      featuredAR = 9 / 16;

    const featuredH = containerH;
    const featuredW = Math.round(featuredH * featuredAR);

    // Sidebar ocupa o restante da largura
    const sidebarW = Math.max(80, containerW - featuredW - gapMain);
    const thumbW   = Math.max(60, Math.floor((sidebarW - gapThumb * (thumbCols - 1)) / thumbCols));
    const thumbRows = Math.ceil(thumbCount / thumbCols);
    const thumbH   = Math.max(50, Math.floor((containerH - gapThumb * (thumbRows - 1)) / thumbRows));

    // Aplicar ao destaque
    featured.style.flex      = `0 0 ${featuredW}px`;
    featured.style.width     = `${featuredW}px`;
    featured.style.maxWidth  = `${featuredW}px`;
    featured.style.height    = `${featuredH}px`;
    featured.style.maxHeight = `${featuredH}px`;

    // Aplicar ao sidebar
    sidebar.style.width       = `${sidebarW}px`;
    sidebar.style.flexBasis   = `${sidebarW}px`;
    sidebar.style.flexShrink  = '0';
    sidebar.style.gap         = `${gapThumb}px`;
    sidebar.style.flexWrap    = 'wrap';
    sidebar.style.alignContent = 'flex-start';

    sidebar.querySelectorAll('.grid-cell').forEach(cell => {
        cell.style.flex      = `0 0 ${thumbW}px`;
        cell.style.width     = `${thumbW}px`;
        cell.style.maxWidth  = `${thumbW}px`;
        cell.style.height    = `${thumbH}px`;
        cell.style.maxHeight = `${thumbH}px`;
    });
}

function teardownSpeakerHighlight() {
    const container = document.getElementById('grid-container');
    const sidebar   = document.getElementById('speaker-sidebar');
    if (sidebar) {
        Array.from(sidebar.querySelectorAll('.grid-cell'))
            .forEach(cell => container.insertBefore(cell, sidebar));
        sidebar.remove();
    }
    container.querySelectorAll('.featured-cell').forEach(c => {
        c.classList.remove('featured-cell');
        ['flex', 'width', 'height', 'maxWidth', 'maxHeight'].forEach(p => c.style[p] = '');
    });
    speakerHighlightActive = false;
}

function applyLayout(layoutId) {
    const container = document.getElementById('grid-container');
    if (!container) return;

    // Desmontar speaker-highlight ao sair dele
    if (currentLayout === 'speaker-highlight' && layoutId !== 'speaker-highlight') {
        teardownSpeakerHighlight();
    }

    // Remover classes antigas
    container.classList.remove('layout-auto-grid', 'layout-cnn-split', 'layout-cnn-vertical', 'layout-portrait-cards', 'layout-speaker-highlight', 'layout-dynamic-cards');

    // Adicionar nova
    container.classList.add(`layout-${layoutId}`);
    currentLayout = layoutId;
    if (layoutId === 'speaker-highlight') speakerHighlightActive = true;

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
        if (!showLabels) badge.style.display = 'none';

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
            case 'waiting-room':
                if (data.action === 'start') {
                    showWaitingRoom(data.seconds, data.bgType, data.bgData);
                } else {
                    hideWaitingRoom();
                }
                break;
            case 'video-adjust': {
                const cell = document.getElementById(`grid-cell-${data.targetId}`);
                if (cell) {
                    const video = cell.querySelector('video');
                    if (video) {
                        let filterStr = `brightness(${data.brightness}) contrast(${data.contrast}) saturate(${data.saturate})`;
                        if (data.style === 'grayscale') filterStr += ' grayscale(1)';
                        else if (data.style === 'sepia') filterStr += ' sepia(1)';
                        else if (data.style === 'invert') filterStr += ' invert(1)';
                        video.style.filter = filterStr;
                    }
                }
                break;
            }
            case 'graphic-overlay':
                handleGraphicOverlay(data);
                break;
            case 'labels-toggle':
                showLabels = data.showLabels;
                document.querySelectorAll('.name-badge').forEach(el => {
                    el.style.display = showLabels ? '' : 'none';
                });
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

// ── Waiting Room Countdown ────────────────────────────────────────────────────
let countdownInterval = null;
let countdownSeconds  = 0;

function updateCountdownDisplay(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    const el = document.getElementById('countdown-timer');
    if (el) el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function showWaitingRoom(totalSeconds, bgType, bgData) {
    const overlay   = document.getElementById('waiting-overlay');
    const bg        = document.getElementById('waiting-bg');
    const container = document.getElementById('grid-container');
    if (!overlay || !bg) return;

    // Set background
    bg.className = '';
    bg.style.backgroundImage  = '';
    bg.style.backgroundSize   = '';
    bg.style.backgroundPosition = '';
    if (bgType === 'image' && bgData) {
        bg.style.backgroundImage    = `url(${bgData})`;
        bg.style.backgroundSize     = 'cover';
        bg.style.backgroundPosition = 'center';
    } else {
        bg.classList.add(`waiting-bg-${bgType || 'cosmic'}`);
    }

    // Blur grid behind overlay
    if (container) container.classList.add('wr-active');

    // Fade in
    overlay.style.display = 'flex';
    overlay.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
        overlay.style.opacity = '1';
    }));

    // Start countdown
    countdownSeconds = totalSeconds;
    updateCountdownDisplay(countdownSeconds);
    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        countdownSeconds--;
        if (countdownSeconds <= 0) {
            clearInterval(countdownInterval);
            updateCountdownDisplay(0);
            hideWaitingRoom();
        } else {
            updateCountdownDisplay(countdownSeconds);
        }
    }, 1000);
}

function hideWaitingRoom() {
    clearInterval(countdownInterval);
    const overlay   = document.getElementById('waiting-overlay');
    const container = document.getElementById('grid-container');
    if (!overlay) return;

    // Fade out overlay + un-blur grid simultaneously
    overlay.style.opacity = '0';
    if (container) container.style.filter = 'blur(0)';

    setTimeout(() => {
        overlay.style.display = 'none';
        if (container) {
            container.classList.remove('wr-active');
            container.style.filter = '';
        }
    }, 1000);
}

// ── Graphic Overlays (Logo + QR Code) ────────────────────────────────────────
let _goQrInstance = null;

function _goSetPosition(el, x, y, scale, sizePx) {
    el.style.left  = x + '%';
    el.style.top   = y + '%';
    el.style.transform = `translate(-${x > 50 ? '100' : '0'}%, -${y > 50 ? '100' : '0'}%) scale(${scale})`;
    el.style.transformOrigin = `${x > 50 ? 'right' : 'left'} ${y > 50 ? 'bottom' : 'top'}`;
    if (sizePx) el.style.width = sizePx + 'px';
}

function _goShowEl(el) {
    el.style.display = 'block';
    requestAnimationFrame(() => { el.style.opacity = '1'; });
}

function _goHideEl(el) {
    el.style.opacity = '0';
    setTimeout(() => { el.style.display = 'none'; }, 420);
}

function handleGraphicOverlay(data) {
    const logo = document.getElementById('go-logo');
    const qr   = document.getElementById('go-qr');
    if (!logo || !qr) return;

    if (data.action === 'reset') {
        _goHideEl(logo);
        _goHideEl(qr);
        return;
    }

    if (data.action === 'logo') {
        if (!data.logoVisible) { _goHideEl(logo); return; }
        if (data.logoData) {
            logo.innerHTML = `<img src="${data.logoData}" alt="Logo">`;
        }
        const sizePx = Math.round(120 * (data.logoScale || 1));
        logo.style.width = sizePx + 'px';
        _goSetPosition(logo, data.logoX ?? 4, data.logoY ?? 4, 1, null);
        _goShowEl(logo);
    }

    if (data.action === 'qr') {
        if (!data.qrVisible) { _goHideEl(qr); return; }
        const sizePx = Math.round(120 * (data.qrScale || 1));
        qr.innerHTML = '';
        if (typeof QRCode !== 'undefined' && data.qrUrl) {
            new QRCode(qr, { text: data.qrUrl, width: sizePx, height: sizePx, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
        }
        _goSetPosition(qr, data.qrX ?? 96, data.qrY ?? 96, 1, null);
        _goShowEl(qr);
    }
}
