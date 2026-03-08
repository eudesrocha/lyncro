// Lógica de Controle NDI via Electron IPC
async function handleNDIToggle(participantId, name) {
    const checkbox = document.getElementById(`ndi-switch-${participantId}`);
    if (!checkbox) return;
    const isEnabled = checkbox.checked;

    try {
        if (window.lyncroAPI && window.lyncroAPI.sendNDIControl) {
            const result = await window.lyncroAPI.sendNDIControl({
                participantId: participantId,
                streamName: `Lyncro - ${name}`,
                isActive: isEnabled,
                roomName: roomName
            });

            if (result.status === 'active') {
                showToast(`Fonte NDI "${name}" ativa no OBS`, "success");
            } else {
                showToast(`Fonte NDI "${name}" desativada`, "info");
            }

            // Sincronizar com o onAir do servidor de sinalização
            toggleOnAir(participantId, isEnabled);
        } else {
            showToast(`NDI ${isEnabled ? 'Ativado' : 'Desativado'} (Preview)`, "info");
            toggleOnAir(participantId, isEnabled);
        }
    } catch (error) {
        console.error("Erro ao ativar NDI:", error);
        showToast("Erro ao comunicar com driver NDI", "error");
        checkbox.checked = !isEnabled;
    }
}

// ── Presets de Qualidade de Vídeo ────────────────────────────────────────────
const VIDEO_QUALITY_PRESETS = {
    '1080_30': { label: '1080p 30fps', width: 1920, height: 1080, frameRate: 30 },
    '720': { label: '720p HD', width: 1280, height: 720, frameRate: 30 },
    '480': { label: '480p SD', width: 854, height: 480, frameRate: 30 },
    '360': { label: '360p LQ', width: 640, height: 360, frameRate: 30 },
};

function buildVideoConstraints(qualityKey, extras = {}) {
    const p = VIDEO_QUALITY_PRESETS[qualityKey] || VIDEO_QUALITY_PRESETS['720'];
    return {
        width: { ideal: p.width },
        height: { ideal: p.height },
        // Sem framerate fixo. O celular usará o padrão que aguentar (30, 24 ou 60).
        ...extras
    };
}

function getHostQuality() {
    return localStorage.getItem('lyncro_host_quality') || '720';
}

const urlParams = new URLSearchParams(window.location.search);
const roomName = urlParams.get('room') || 'default';
const userName = urlParams.get('name') || 'Host';

let localStream;
let returnAudioStream = null; // Áudio de Loopback do Mix-Minus
let rtcClient;
let ws;
let myId;
let wsReconnectDelay = 2000;      // Backoff exponencial (inicia em 2s, max 30s)
let wsIntentionalClose = false;   // Evita reconexão ao fechar propositalmente
let processedStream = null; // Stream pós-IA (se ativo)
let currentVbMode = 'none';
let currentVbImage = null;
let currentParticipants = [];
let isMonitorMuted = false;
let soundEnabled = true;
let prevWaitingIds = new Set(); // rastreia quais convidados já estavam na fila
let isHostMicMuted = false;
let isHostCamMuted = false;
let isScreenSharing = false;
let screenStream = null;
const vuAnalyzers = new Map(); // participantId -> { analyzer, dataArray, animationId }

const videoGrid = document.getElementById('video-grid');
const roomIdDisplay = document.getElementById('room-id-display');
if (roomIdDisplay) roomIdDisplay.innerHTML = `<span class="text-win-accent">SALA</span> <span class="text-gray-300">${roomName}</span>`;

// Preencher invite link imediatamente caso o input exista
const inviteInput = document.getElementById('invite-link-input');
if (inviteInput) {
    const baseUrl = window.location.origin;
    inviteInput.value = `${baseUrl}/guest.html?room=${encodeURIComponent(roomName)}`;
}

async function init() {
    // Restaurar preferência de som e aplicar estado visual do botão
    soundEnabled = localStorage.getItem('lyncro_sound_enabled') !== '0';
    setTimeout(applySoundButtonState, 0);

    // 1. Iniciar WebSocket imediatamente para ver a fila de espera
    setupWebSocket();

    // 2. Renderizar card local (vazio inicialmente)
    renderParticipantCard({ id: 'local', name: userName, role: 'host' }, true);

    // 3. Solicitar mídias em background
    try {
        const hostQuality = getHostQuality();
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: buildVideoConstraints(hostQuality),
                audio: true
            });
        } catch (constraintErr) {
            // Câmera não suporta a qualidade pedida — fallback automático para 720p
            console.warn(`[Media] Falha com ${hostQuality}, tentando 720p:`, constraintErr.message);
            if (hostQuality !== '720') {
                localStorage.setItem('lyncro_host_quality', '720');
                const sel = document.getElementById('host-quality-select');
                if (sel) sel.value = '720';
            }
            localStream = await navigator.mediaDevices.getUserMedia({
                video: buildVideoConstraints('720'),
                audio: true
            });
        }

        // Aplicar processamento de Fundo Virtual (se ativo)
        if (currentVbMode !== 'none') {
            try {
                processedStream = await window.vbManager.start(localStream, { mode: currentVbMode, imageUrl: currentVbImage });
            } catch (e) {
                console.error("Falha ao iniciar Virtual Background, usando stream limpo", e);
                processedStream = localStream;
            }
        } else {
            processedStream = localStream;
        }

        // Atualizar vídeo local
        const localVideoEl = document.querySelector('#video-card-local video');
        if (localVideoEl) localVideoEl.srcObject = processedStream;

        // Injetar stream no cliente RTC se ele já existir
        if (rtcClient) {
            rtcClient.setLocalStream(processedStream);

            // Adicionar trilhas aos peers já conectados (se houver)
            processedStream.getTracks().forEach(track => {
                rtcClient.replaceTrack(track);
            });
        }
    } catch (err) {
        console.error('Falha ao iniciar mídia local:', err);
        showToast('Aviso: Câmera/Mic do Host não iniciados (Timeout/Negado)', 'info');
    }

    await enumerateDevices();
}

// Lógica de Seleção de Dispositivos (Câmera, Microfone e Retorno)
async function enumerateDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter(device => device.kind === 'videoinput');
        const audioInputs = devices.filter(device => device.kind === 'audioinput');

        const returnSelect = document.getElementById('return-audio-select');

        // Preencher Dropdown de Vídeo (novo formato)
        const camList = document.getElementById('cam-dropdown-list-local');
        if (camList) {
            camList.innerHTML = '';
            videoInputs.forEach(device => {
                const btn = document.createElement('button');
                btn.className = 'w-full text-left px-2 py-1.5 text-[10px] text-gray-300 hover:bg-win-accent/20 hover:text-white rounded transition-all truncate';
                btn.textContent = device.label || `Câmera ${camList.children.length + 1}`;
                btn.onclick = () => { updateHostDevice('video', device.deviceId); closeAllCardDropdowns(); };
                camList.appendChild(btn);
            });
            if (videoInputs.length === 0) camList.innerHTML = '<span class="px-2 py-1 text-[9px] text-gray-500">Nenhuma câmera</span>';
        }

        // Preencher Dropdown de Áudio (novo formato)
        const micList = document.getElementById('mic-dropdown-list-local');
        if (micList) {
            micList.innerHTML = '';
            audioInputs.forEach(device => {
                const btn = document.createElement('button');
                btn.className = 'w-full text-left px-2 py-1.5 text-[10px] text-gray-300 hover:bg-win-accent/20 hover:text-white rounded transition-all truncate';
                btn.textContent = device.label || `Mic ${micList.children.length + 1}`;
                btn.onclick = () => { updateHostDevice('audio', device.deviceId); closeAllCardDropdowns(); };
                micList.appendChild(btn);
            });
            if (audioInputs.length === 0) micList.innerHTML = '<span class="px-2 py-1 text-[9px] text-gray-500">Nenhum mic</span>';
        }

        // Preencher Retorno de Áudio (Mix-Minus)
        if (returnSelect) {
            returnSelect.innerHTML = '<option value="">Retorno</option>';
            audioInputs.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Mix ${returnSelect.length}`;
                returnSelect.appendChild(option);
            });

            returnSelect.addEventListener('change', async (e) => {
                const deviceId = e.target.value;
                if (!deviceId) {
                    if (returnAudioStream) {
                        returnAudioStream.getTracks().forEach(t => t.stop());
                        returnAudioStream = null;
                        if (rtcClient) rtcClient.removeReturnAudioTrack();
                    }
                    return;
                }
                try {
                    if (returnAudioStream) returnAudioStream.getTracks().forEach(t => t.stop());
                    returnAudioStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            deviceId: { exact: deviceId },
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true
                        }
                    });
                    injectReturnAudioToPeers();
                } catch (err) {
                    console.error("Erro ao capturar retorno de áudio:", err);
                    showToast("Falha ao capturar retorno.", "error");
                }
            });
        }
    } catch (error) {
        console.error('Erro ao enumerar dispositivos:', error);
    }
}

async function updateHostDevice(kind, deviceId) {
    if (!deviceId) return;

    try {
        const constraints = {
            video: kind === 'video' ? { deviceId: { exact: deviceId } } : false,
            audio: kind === 'audio' ? {
                deviceId: { exact: deviceId },
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } : false
        };

        // Se estivermos trocando apenas um, precisamos garantir que o outro não seja solicitado novamente ou que mantenhamos o atual
        // No entanto, replaceTrack do ebot simplifica isso. Vamos pegar apenas a track necessária.
        const newStream = await navigator.mediaDevices.getUserMedia(constraints);
        const newTrack = kind === 'video' ? newStream.getVideoTracks()[0] : newStream.getAudioTracks()[0];

        if (localStream) {
            const oldTracks = kind === 'video' ? localStream.getVideoTracks() : localStream.getAudioTracks();
            oldTracks.forEach(t => {
                t.stop();
                localStream.removeTrack(t);
            });
            localStream.addTrack(newTrack);
        } else {
            localStream = newStream;
        }

        // Atualizar vídeo local
        const localVideoEl = document.querySelector('#video-card-local video');
        if (localVideoEl && kind === 'video') {
            if (currentVbMode !== 'none') {
                try {
                    processedStream = await window.vbManager.start(localStream, { mode: currentVbMode, imageUrl: currentVbImage });
                    localVideoEl.srcObject = processedStream;
                } catch (e) {
                    console.error("Falha ao processar Fundo Virtual na troca de camera", e);
                    localVideoEl.srcObject = localStream;
                }
            } else {
                localVideoEl.srcObject = localStream;
            }
        }

        // Substituir track em todos os peers ativos
        if (rtcClient) {
            await rtcClient.replaceTrack(currentVbMode !== 'none' && kind === 'video' ? processedStream.getVideoTracks()[0] : newTrack);
        }

        showToast(`${kind === 'video' ? 'Câmera' : 'Microfone'} atualizada com sucesso!`, "success");
    } catch (err) {
        console.error(`Erro ao trocar ${kind}:`, err);
        showToast(`Erro ao trocar ${kind}. Verifique as permissões.`, "error");
    }
}

function injectReturnAudioToPeers() {
    if (!returnAudioStream || !rtcClient) return;
    const audioTrack = returnAudioStream.getAudioTracks()[0];
    if (audioTrack) {
        rtcClient.addReturnAudioTrack(audioTrack);
    }
}

async function setupWebSocket() {
    // Aguardar config estar pronta antes de ler SIGNALING_URL (evita race condition)
    if (window.LYNCRO_CONFIG_READY) await window.LYNCRO_CONFIG_READY;

    let wsUrl;
    if (window.LYNCRO_CONFIG && window.LYNCRO_CONFIG.SIGNALING_URL) {
        wsUrl = window.LYNCRO_CONFIG.SIGNALING_URL;
    } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        wsUrl = `${protocol}//${host}`;
    }

    ws = new WebSocket(wsUrl);
    const storedPassword = sessionStorage.getItem(`room_pwd_${roomName}`);

    ws.onopen = async () => {
        wsReconnectDelay = 2000; // Reset do backoff após conexão bem-sucedida
        rtcClient = new WebRTCClient(userName, handleRemoteTrack, handleIceCandidate, initiateConnection, null, handleDataMessage);
        rtcClient.setLocalStream(processedStream || localStream);

        // Obter sessão Supabase para ownership e autenticação
        // Usa getFreshSession() que faz refresh automático se o token
        // estiver prestes a expirar (<5min), evitando "Sessão expirada"
        let userId = null;
        let accessToken = null;
        try {
            const session = await window.LYNCRO_AUTH.getFreshSession();
            if (session && session.user) {
                userId = session.user.id;
                accessToken = session.access_token;
            }
        } catch (e) {
            console.warn('Sem sessão Supabase para ownership:', e);
        }

        const payload = {
            type: 'join',
            roomId: roomName,
            participant: {
                name: userName,
                role: 'host',
                userId: userId,
                token: accessToken  // JWT para validação no servidor
            }
        };

        if (storedPassword) payload.password = storedPassword;
        ws.send(JSON.stringify(payload));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case 'init-network':
                myId = data.yourId;
                if (rtcClient) {
                    rtcClient.updateConfig(data.iceServers);
                    // Wifi ressuscitou: matar lixo P2P do estado velho
                    Array.from(rtcClient.peers.keys()).forEach(id => rtcClient.removePeer(id));
                }
                break;
            case 'participant-update':
                updateUI(data.participants);
                if (typeof broadcastPrompterState === 'function') {
                    broadcastPrompterState(); // Garante o sync imediato para quem acabou de entrar ou foi aprovado
                }
                break;
            case 'offer':
                const answer = await rtcClient.handleOffer(data.from, data.offer);
                ws.send(JSON.stringify({ type: 'answer', roomId: roomName, to: data.from, answer }));
                break;
            case 'answer':
                await rtcClient.handleAnswer(data.from, data.answer);
                break;
            case 'ice-candidate':
                await rtcClient.handleCandidate(data.from, data.candidate);
                break;
            case 'chat':
                appendChatMessage(data.name, data.text, data.timestamp);
                break;
            case 'chat-typing':
                handleTypingIndicator(data.name, data.isTyping);
                break;
            case 'prompter-finished':
                if (prompterState.isPlaying) {
                    prompterState.isPlaying = false;
                    isPrompterFinished = true;
                    if (typeof updatePrompterPlayButtonUI === 'function') {
                        updatePrompterPlayButtonUI();
                    }
                    showToast('O teleprompter chegou ao fim.', 'success');
                }
                break;
            case 'peer-reconnected':
                // Convidado reconectou: remover peer antigo para que participant-update re-inicie a conexão
                if (rtcClient) rtcClient.removePeer(data.participantId);
                break;
            case 'error':
                console.error('[Server Error]', data.message);
                if (data.message && data.message.includes('host negado')) {
                    // Tentar refresh de sessão antes de desistir
                    // (pode ser só token expirado, não logout real)
                    (async () => {
                        try {
                            const freshSession = await window.LYNCRO_AUTH.getFreshSession();
                            if (freshSession) {
                                console.log('[Auth] Token renovado após rejeição. Reconectando...');
                                showToast('Sessão renovada. Reconectando...', 'info');
                                // Reconectar com o novo token
                                setTimeout(setupWebSocket, 1000);
                                return;
                            }
                        } catch (e) {
                            console.warn('[Auth] Falha ao renovar sessão:', e);
                        }
                        // Se chegou aqui, sessão está realmente expirada
                        wsIntentionalClose = true;
                        alert('Sessão expirada. Faça login novamente.');
                        window.location.href = 'login.html';
                    })();
                } else {
                    showToast(data.message || 'Erro no servidor.', 'error');
                }
                break;
        }
    };

    ws.onerror = (err) => {
        console.error('[WS] Erro na conexão do Host:', err);
    };

    ws.onclose = () => {
        if (wsIntentionalClose) return;
        const delay = wsReconnectDelay;
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
        console.warn(`[WS] Conexão perdida. Reconectando em ${delay / 1000}s...`);
        showToast(`Conexão perdida. Reconectando em ${delay / 1000}s...`, 'info');
        setTimeout(setupWebSocket, delay);
    };
}

function updateUI(participants) {
    currentParticipants = participants;
    const videoGrid = document.getElementById('video-grid');
    const waitingList = document.getElementById('waiting-list');
    const emptyQueueMsg = document.getElementById('empty-queue-msg');
    const queueCountBadge = document.getElementById('queue-count');

    const currentParticipantIds = participants.filter(p => p.status === 'accepted' || p.role === 'host').map(p => p.id);
    let queueCount = 0;

    if (waitingList) waitingList.innerHTML = '';

    participants.forEach(p => {
        if (p.role === 'observer' || (p.name && p.name.startsWith('OBS-'))) return;
        if (p.id === myId) return; // Não renderizar a si mesmo como remoto (evita card fantasma)
        if (p.role === 'host' && p.id !== myId) return; // Não renderizar instâncias antigas de hosts (fantasma)

        if (p.status === 'waiting') {
            queueCount++;
            if (!prevWaitingIds.has(p.id)) playGuestJoinSound();
            renderWaitingParticipant(p);
            return;
        }

        if (!document.getElementById(`video-card-${p.id}`)) {
            renderParticipantCard(p);
        } else {
            updateParticipantStatus(p);
        }

        if (!rtcClient.peers.has(p.id) && p.role !== 'observer' && myId && myId < p.id) {
            initiateConnection(p.id);
        }
    });

    const queueSection = document.getElementById('queue-section');
    if (queueSection) {
        if (queueCount > 0) {
            queueSection.classList.remove('section-collapsed');
            queueSection.classList.add('queue-alert-active');
            if (queueCountBadge) {
                queueCountBadge.textContent = queueCount;
                queueCountBadge.classList.remove('hidden');
                queueCountBadge.classList.add('badge-pulse');
            }
        } else {
            queueSection.classList.add('section-collapsed');
            queueSection.classList.remove('queue-alert-active');
            if (queueCountBadge) {
                queueCountBadge.classList.add('hidden');
                queueCountBadge.classList.remove('badge-pulse');
            }
        }
    }

    const cards = document.querySelectorAll('[id^="video-card-"]');
    cards.forEach(card => {
        const id = card.id.replace('video-card-', '');
        if (id !== 'local' && !currentParticipantIds.includes(id)) {
            card.remove();
            rtcClient.removePeer(id);
        }
    });

    // Atualizar opções do Teleprompter
    const targetSelect = document.getElementById('prompter-target');
    if (targetSelect) {
        const currentSelected = targetSelect.value;
        let optionsHtml = '<option value="all">Todos os Convidados</option>';
        participants.forEach(p => {
            if (p.role !== 'host' && p.role !== 'observer' && p.status === 'accepted' && p.id !== myId) {
                optionsHtml += `<option value="${p.id}">${p.name}</option>`;
            }
        });
        targetSelect.innerHTML = optionsHtml;
        if (Array.from(targetSelect.options).some(opt => opt.value === currentSelected)) {
            targetSelect.value = currentSelected;
        } else {
            targetSelect.value = 'all';
            prompterState.targetId = 'all';
        }
    }

    // Atualizar snapshot da fila para detectar novos na próxima chamada
    prevWaitingIds = new Set(participants.filter(p => p.status === 'waiting').map(p => p.id));
}

function renderWaitingParticipant(participant) {
    const waitingList = document.getElementById('waiting-list');
    if (!waitingList) return;

    const card = document.createElement('div');
    card.id = `queue-card-${participant.id}`;
    card.className = "bg-black/20 border border-white/10 rounded-xl p-2.5 flex items-center justify-between group hover:bg-white/10 transition-all";

    card.innerHTML = `
        <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded bg-win-accent/20 border border-win-accent/20 flex items-center justify-center text-win-accent font-black text-xs uppercase shadow-lg">
                ${participant.name.charAt(0)}
            </div>
            <div class="flex flex-col">
                <span class="text-xs font-bold text-gray-200 truncate max-w-[110px]" title="${participant.name}">${participant.name}</span>
                <span class="text-[9px] text-gray-600 uppercase font-bold tracking-tighter">Na Fila</span>
            </div>
        </div>
        <div class="flex gap-1.5 grayscale group-hover:grayscale-0 transition-all">
            <button onclick="handleAdmission('${participant.id}', 'accepted')" class="w-8 h-8 rounded-win bg-green-500/10 text-green-500 border border-green-500/20 hover:bg-green-500 hover:text-white transition-all flex items-center justify-center" title="Aprovar">
                <i class="ph ph-check font-bold"></i>
            </button>
            <button onclick="handleAdmission('${participant.id}', 'rejected')" class="w-8 h-8 rounded-win bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500 hover:text-white transition-all flex items-center justify-center" title="Recusar">
                <i class="ph ph-x font-bold"></i>
            </button>
        </div>
    `;
    waitingList.appendChild(card);
}

window.handleAdmission = (participantId, status) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'room-admission',
            roomId: roomName.trim(),
            targetId: participantId,
            status: status
        }));
    }
};

function renderParticipantCard(participant, isLocal = false) {
    const card = document.createElement('div');
    card.id = `video-card-${participant.id}`;
    card.className = "glass-panel border-white/10 rounded-2xl shadow-2xl flex flex-col h-full transition-all hover:border-win-accent/50 hover:shadow-[0_0_30px_rgba(0,120,212,0.15)]";

    card.innerHTML = `
      <div class="aspect-video bg-black relative group rounded-t-win overflow-hidden">
        <video class="w-full h-full object-cover" autoplay playsinline ${isLocal ? 'muted' : ''}></video>
        
        <div class="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm opacity-60 ${isLocal ? 'hidden' : ''}" id="waiting-${participant.id}">
          <span class="text-[10px] uppercase font-bold tracking-widest text-gray-400">Aguardando...</span>
        </div>

        <!-- VU Meter Vertical Minimalista -->
        <div class="absolute left-2 top-2 bottom-2 w-1 bg-white/5 rounded-full overflow-hidden flex flex-col justify-end z-20 border border-white/5">
            <div id="vu-bar-${participant.id}" class="w-full bg-[#0078d4] h-0 transition-all duration-75 rounded-full shadow-[0_0_8px_rgba(0,120,212,0.5)]"></div>
        </div>

        <div id="mute-overlay-${participant.id}" class="absolute inset-0 media-muted-overlay ${participant.audioMuted || participant.videoMuted ? '' : 'hidden'}">
          ${participant.videoMuted ? `
              <i class="ph ph-video-camera-slash text-4xl text-red-600/80 drop-shadow-xl animate-pulse"></i>
          ` : ''}
          ${participant.audioMuted && !participant.videoMuted ? `
              <div class="bg-black/40 p-3 rounded-full border border-red-500/30">
                <i class="ph ph-microphone-slash text-3xl text-red-500 drop-shadow-lg"></i>
              </div>
          ` : ''}
        </div>
        
        <div class="absolute top-2.5 right-2.5 flex items-center gap-2 bg-black/60 backdrop-blur-md px-2 py-1 rounded border border-win-border min-w-[70px] justify-center">
          <div id="tally-dot-${participant.id}" class="w-1.5 h-1.5 rounded-full ${participant.tallyState === 'program' ? 'bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.5)]' : participant.tallyState === 'preview' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-gray-600'}"></div>
          <span id="tally-text-${participant.id}" class="text-[9px] font-black tracking-widest uppercase text-white/90">${participant.tallyState === 'program' ? 'No Ar' : participant.tallyState === 'preview' ? 'Preview' : 'Ready'}</span>
        </div>

        <div class="absolute bottom-2.5 left-2.5 bg-black/60 backdrop-blur-md px-2 py-0.5 rounded text-[10px] font-bold border border-win-border text-white/70">
          ${participant.name} ${isLocal ? '(Host)' : ''}
        </div>

        ${isLocal ? '' : `
        <button onclick="kickParticipant('${participant.id}', '${(participant.name || '').replace(/'/g, "\\'")}')"
          class="absolute top-2.5 left-2.5 w-6 h-6 rounded bg-red-600/20 border border-red-500/30 text-red-400 hover:bg-red-600 hover:text-white transition-all flex items-center justify-center opacity-0 group-hover:opacity-100 z-20"
          title="Banir Convidado">
          <i class="ph ph-x-circle text-sm"></i>
        </button>
        <button onclick="event.stopPropagation(); copyCleanFeed('${participant.id}')"
          class="absolute bottom-2.5 right-2.5 w-7 h-7 rounded bg-black/60 backdrop-blur-sm border border-white/10 text-gray-500 hover:bg-win-accent hover:text-white hover:border-win-accent transition-all flex items-center justify-center opacity-0 group-hover:opacity-100 z-20"
          title="Copiar link OBS (Clean Feed para Câmera)">
          <i class="ph ph-broadcast text-xs"></i>
        </button>
        `}
      </div>

      <!-- Barra de Controles Compacta (4 botões) -->
      <div class="p-2 flex items-center justify-between bg-white/5 border-t border-win-border gap-1">
        <!-- Botão 1: Microfone + Dropdown -->
        <div class="relative flex items-center">
          <button id="btn-audio-${participant.id}" class="${participant.audioMuted ? 'text-red-500 bg-red-600/10 border-red-500/20' : 'text-gray-400 border-win-border hover:text-white hover:bg-white/5'} p-1.5 border rounded-l-win transition-all" onclick="remoteMute('${participant.id}')">
            <i class="ph ${participant.audioMuted ? 'ph-microphone-slash' : 'ph-microphone'} text-sm"></i>
          </button>
          ${isLocal ? `
          <button onclick="toggleCardDropdown('mic-dropdown-${participant.id}', this)" class="p-1.5 border border-l-0 border-win-border rounded-r-win text-gray-500 hover:text-white hover:bg-white/5 transition-all">
            <i class="ph ph-caret-down text-[10px]"></i>
          </button>
          ` : ''}
        </div>

        <!-- Botão 2: Câmera + Dropdown -->
        <div class="relative flex items-center">
          <button id="btn-video-${participant.id}" class="${participant.videoMuted ? 'text-red-500 bg-red-600/10 border-red-500/20' : 'text-gray-400 border-win-border hover:text-win-accent hover:bg-win-accent/5'} p-1.5 border rounded-l-win transition-all" onclick="remoteMuteVideo('${participant.id}')">
            <i class="ph ${participant.videoMuted ? 'ph-video-camera-slash' : 'ph-video-camera'} text-sm"></i>
          </button>
          ${isLocal ? `
          <button onclick="toggleCardDropdown('cam-dropdown-${participant.id}', this)" class="p-1.5 border border-l-0 border-win-border rounded-r-win text-gray-500 hover:text-white hover:bg-white/5 transition-all">
            <i class="ph ph-caret-down text-[10px]"></i>
          </button>
          ` : ''}
        </div>

        <!-- Botão 3: Lower Third -->
        <button onclick="toggleCardPanel('lt-panel-${participant.id}')" class="p-1.5 border border-win-border rounded-win text-gray-400 hover:text-win-accent hover:bg-win-accent/5 transition-all" title="Lower Third">
          <i class="ph ph-text-aa text-sm"></i>
        </button>

        <!-- Botão 4: VB (Host) / Tally (Guest) -->
        ${isLocal ? `
        <button onclick="toggleCardPanel('vb-panel-${participant.id}')" class="p-1.5 border border-win-border rounded-win text-gray-400 hover:text-purple-400 hover:bg-purple-500/5 transition-all" title="Fundo Virtual">
          <i class="ph ph-sparkle text-sm"></i>
        </button>
        ` : `
        <div class="flex items-center gap-0.5">
          <button id="btn-prv-${participant.id}" onclick="handleTallyChange('${participant.id}', 'preview', '${participant.name}')" 
            class="text-[8px] font-black px-1.5 py-1 rounded-l-win transition-all border ${participant.tallyState === 'preview' ? 'bg-green-600/20 text-green-500 border-green-500/40' : 'bg-win-surface/20 border-win-border hover:bg-white/5 text-gray-500'}">PRV</button>
          <button id="btn-pgm-${participant.id}" onclick="handleTallyChange('${participant.id}', 'program', '${participant.name}')" 
            class="text-[8px] font-black px-1.5 py-1 transition-all border border-l-0 ${participant.tallyState === 'program' ? 'bg-red-600/20 text-red-500 border-red-500/40' : 'bg-win-surface/20 border-win-border hover:bg-white/5 text-gray-500'}">PGM</button>
          <button id="btn-off-${participant.id}" onclick="handleTallyChange('${participant.id}', 'off', '${participant.name}')" 
            class="text-[8px] font-black px-1.5 py-1 rounded-r-win transition-all border border-l-0 ${participant.tallyState === 'off' ? 'bg-gray-600/40 text-white border-white/20' : 'bg-win-surface/20 border-win-border hover:bg-white/5 text-gray-500'}">OFF</button>
        </div>
        `}
      </div>

      <!-- Painel Colapsável: Lower Third -->
      <div id="lt-panel-${participant.id}" class="hidden px-3 pb-3 bg-white/5 border-t border-win-border/10">
        <div class="flex flex-col gap-2 pt-3">
          <div class="flex justify-between items-center mb-1">
            <span class="text-[9px] font-bold text-gray-500 uppercase tracking-widest leading-none opacity-50">Lower Third</span>
            <div class="flex items-center gap-2">
              ${isLocal ? '' : `
              <button onclick="copyCleanFeed('${participant.id}')" title="Copiar Link Clean Feed" class="text-[9px] font-bold uppercase text-win-accent hover:text-white transition-all flex items-center gap-1">
                <i class="ph ph-copy"></i> Feed
              </button>
              ${participant.isScreenSharing ? `
              <button onclick="copyCleanFeed('${participant.id}', 'screen')" title="Clean Feed Tela" class="text-[9px] font-bold uppercase text-blue-400 hover:text-white transition-all flex items-center gap-1">
                <i class="ph ph-monitor"></i> Tela
              </button>
              ` : ''}
              `}
              <button id="btn-ov-toggle-${participant.id}" onclick="toggleOverlay('${participant.id}')"
                class="text-[9px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-win transition-all ${participant.overlayActive ? 'bg-win-accent text-white shadow-lg shadow-win-accent/20 border border-win-accent' : 'bg-win-surface/30 text-gray-500 hover:text-white border border-win-border'}">
                Disparar
              </button>
              <button id="btn-hide-ov-${participant.id}" onclick="hideOverlay('${participant.id}')" title="Ocultar Lower Third"
                class="text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-win transition-all bg-red-600/20 text-red-400 hover:bg-red-600 hover:text-white border border-red-500/30"
                style="display:${participant.overlayActive ? 'inline-flex' : 'none'}; align-items:center; justify-content:center;">
                ×
              </button>
            </div>
          </div>
          <div class="flex flex-col gap-1.5">
            <input type="text" id="ov-name-${participant.id}" placeholder="Nome" value="${participant.overlayName || participant.name || ''}"
              class="w-full bg-black/30 border border-win-border/30 rounded px-2.5 py-2 text-[11px] outline-none focus:border-win-accent transition-all placeholder:text-gray-700 text-gray-300">
            <input type="text" id="ov-title-${participant.id}" placeholder="Tagline / Título" value="${participant.overlayTitle || ''}"
              class="w-full bg-black/30 border border-win-border/30 rounded px-2.5 py-2 text-[11px] outline-none focus:border-win-accent transition-all placeholder:text-gray-700 text-gray-300">
          </div>
        </div>
      </div>

      ${isLocal ? `
      <!-- Painel Colapsável: Fundo Virtual (Host Only) -->
      <div id="vb-panel-${participant.id}" class="hidden px-3 pb-3 bg-white/5 border-t border-win-border/10">
        <div class="flex flex-col gap-2 pt-3">
          <span class="text-[9px] font-bold text-gray-500 uppercase tracking-widest leading-none opacity-50 flex items-center gap-1"><i class="ph ph-sparkle text-purple-400"></i> Fundo Virtual</span>
          <div class="flex overflow-x-auto gap-2 pb-2 pl-1 pr-4 max-w-full hide-scroll-bar snap-x snap-mandatory">
                        <!-- Controls -->
                        <button onclick="setVirtualBackground('none', null, this.id)" id="vb-btn-none"
                            class="flex-none snap-start flex flex-col items-center justify-center w-[5.5rem] h-16 rounded-xl bg-win-accent/10 border border-win-accent transition-all hover:bg-white/5 cursor-pointer">
                            <i class="ph ph-prohibit text-xl text-gray-300 mb-1"></i>
                            <span class="text-[8px] font-bold uppercase tracking-widest text-gray-300">Real</span>
                        </button>
                        <button onclick="setVirtualBackground('blur', null, this.id)" id="vb-btn-blur"
                            class="flex-none snap-start flex flex-col items-center justify-center w-[5.5rem] h-16 rounded-xl bg-black/40 border border-win-border/40 transition-all hover:bg-white/5 cursor-pointer">
                            <i class="ph ph-drop text-xl text-blue-400 mb-1"></i>
                            <span class="text-[8px] font-bold uppercase tracking-widest text-blue-400">Blur</span>
                        </button>

                        <!-- Static Images (5) -->
                        <button onclick="setVirtualBackground('image', 'img/bg-living-room.png', this.id)"
                            id="vb-btn-living"
                            class="flex-none snap-start flex flex-col items-center justify-center p-0 rounded-xl border border-transparent overflow-hidden transition-all hover:border-win-accent cursor-pointer group relative w-[5.5rem] h-16">
                            <img src="img/bg-living-room.png" alt="Living" class="w-full h-full object-cover">
                            <div class="absolute inset-0 bg-black/40 group-hover:bg-transparent transition-all"></div>
                        </button>
                        <button onclick="setVirtualBackground('image', 'img/bg-office-premium.png', this.id)"
                            id="vb-btn-office-premium"
                            class="flex-none snap-start flex flex-col items-center justify-center p-0 rounded-xl border border-transparent overflow-hidden transition-all hover:border-win-accent cursor-pointer group relative w-[5.5rem] h-16">
                            <img src="img/bg-office-premium.png" alt="Office" class="w-full h-full object-cover">
                            <div class="absolute inset-0 bg-black/40 group-hover:bg-transparent transition-all"></div>
                        </button>
                        <button onclick="setVirtualBackground('image', 'img/bg-studio-pro.png', this.id)"
                            id="vb-btn-studio-pro"
                            class="flex-none snap-start flex flex-col items-center justify-center p-0 rounded-xl border border-transparent overflow-hidden transition-all hover:border-win-accent cursor-pointer group relative w-[5.5rem] h-16">
                            <img src="img/bg-studio-pro.png" alt="Studio" class="w-full h-full object-cover">
                            <div class="absolute inset-0 bg-black/40 group-hover:bg-transparent transition-all"></div>
                        </button>
                        <button onclick="setVirtualBackground('image', 'img/bg-loft.png', this.id)" id="vb-btn-loft"
                            class="flex-none snap-start flex flex-col items-center justify-center p-0 rounded-xl border border-transparent overflow-hidden transition-all hover:border-win-accent cursor-pointer group relative w-[5.5rem] h-16">
                            <img src="img/bg-loft.png" alt="Loft" class="w-full h-full object-cover">
                            <div class="absolute inset-0 bg-black/40 group-hover:bg-transparent transition-all"></div>
                        </button>
                        <button onclick="setVirtualBackground('image', 'img/bg-abstract.png', this.id)"
                            id="vb-btn-abstract"
                            class="flex-none snap-start flex flex-col items-center justify-center p-0 rounded-xl border border-transparent overflow-hidden transition-all hover:border-win-accent cursor-pointer group relative w-[5.5rem] h-16">
                            <img src="img/bg-abstract.png" alt="Abstract" class="w-full h-full object-cover">
                            <div class="absolute inset-0 bg-black/40 group-hover:bg-transparent transition-all"></div>
                        </button>

                        <!-- Animated -->
                        <button onclick="setVirtualBackground('anim-window', null, this.id)"
                            id="vb-btn-anim-window"
                            class="flex-none snap-start flex flex-col items-center justify-center p-0 rounded-xl border border-transparent overflow-hidden transition-all hover:border-win-accent cursor-pointer group relative w-[5.5rem] h-16 bg-gradient-to-b from-sky-400 to-green-700">
                            <i class="ph ph-window text-white/60 text-lg absolute top-2"></i>
                            <div class="absolute top-1 right-1 bg-black/60 rounded px-1"><i
                                    class="ph ph-film-strip text-white text-[10px]"></i></div>
                            <span class="mt-4 text-[8px] font-bold text-white uppercase tracking-widest">Janela</span>
                        </button>
                        <button onclick="setVirtualBackground('anim-studio', null, this.id)" id="vb-btn-anim-studio"
                            class="flex-none snap-start flex flex-col items-center justify-center p-0 rounded-xl border border-transparent overflow-hidden transition-all hover:border-win-accent cursor-pointer group relative w-[5.5rem] h-16 bg-gradient-to-br from-blue-900 to-black relative">
                            <i class="ph ph-film-strip text-white/40 text-lg absolute top-3"></i>
                            <div class="absolute top-1 right-1 bg-black/60 rounded px-1"><i
                                    class="ph ph-film-strip text-white text-[10px]"></i></div>
                            <span class="mt-4 text-[9px] font-bold text-white uppercase tracking-widest">Premium</span>
                        </button>
                        <button onclick="setVirtualBackground('anim-particles', null, this.id)"
                            id="vb-btn-anim-particles"
                            class="flex-none snap-start flex flex-col items-center justify-center p-0 rounded-xl border border-transparent overflow-hidden transition-all hover:border-win-accent cursor-pointer group relative w-[5.5rem] h-16 bg-gradient-to-tr from-purple-900 to-[#1a0a1f] relative">
                            <i class="ph ph-sparkle text-white/40 text-lg absolute top-3"></i>
                            <div class="absolute top-1 right-1 bg-black/60 rounded px-1"><i
                                    class="ph ph-film-strip text-white text-[10px]"></i></div>
                            <span
                                class="mt-4 text-[9px] font-bold text-white uppercase tracking-widest">Partículas</span>
                        </button>
          </div>
        </div>
      </div>
      ` : ''}

    `;

    videoGrid.appendChild(card);

    if (!isLocal) {
        card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('border-win-accent', 'scale-[1.02]'); });
        card.addEventListener('dragleave', () => { card.classList.remove('border-win-accent', 'scale-[1.02]'); });
        card.addEventListener('drop', async (e) => {
            e.preventDefault();
            card.classList.remove('border-win-accent', 'scale-[1.02]');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                const file = files[0];
                try {
                    showToast(`Enviando ${file.name} para ${participant.name}...`, 'info');
                    await rtcClient.sendFile(participant.id, file, (progress) => {
                        let bar = card.querySelector('.file-progress-bar');
                        if (!bar) {
                            const barContainer = document.createElement('div');
                            barContainer.className = "absolute bottom-12 left-2 right-2 h-1 bg-black/50 rounded-full overflow-hidden z-20";
                            bar = document.createElement('div');
                            bar.className = "file-progress-bar h-full bg-win-accent transition-all duration-200";
                            bar.style.width = '0%';
                            barContainer.appendChild(bar);
                            card.appendChild(barContainer);
                        }
                        bar.style.width = `${progress}%`;
                    });
                    const barContainer = card.querySelector('.file-progress-bar')?.parentElement;
                    if (barContainer) barContainer.remove();
                    showToast(`Arquivo ${file.name} enviado!`, 'success');
                    appendChatMessage('Sistema P2P', `Você enviou ${file.name} para ${participant.name}`, Date.now());
                } catch (err) {
                    console.error('Erro no envio P2P:', err);
                    showToast(`Erro ao enviar arquivo para ${participant.name}`, 'error');
                }
            }
        });
    }
}

function updateParticipantStatus(p) {
    const card = document.getElementById(`video-card-${p.id}`);
    if (!card) return;

    const dot = document.getElementById(`tally-dot-${p.id}`);
    const text = document.getElementById(`tally-text-${p.id}`);
    if (dot && text) {
        if (p.tallyState === 'program') {
            dot.className = "w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.5)]";
            text.textContent = "No Ar";
        } else if (p.tallyState === 'preview') {
            dot.className = "w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]";
            text.textContent = "Preview";
        } else {
            dot.className = "w-1.5 h-1.5 rounded-full bg-gray-600";
            text.textContent = "Ready";
        }
    }

    const overlay = document.getElementById(`mute-overlay-${p.id}`);
    if (overlay) {
        if (p.audioMuted || p.videoMuted) {
            overlay.classList.remove('hidden');
            overlay.innerHTML = `
                ${p.videoMuted ? `<i class="ph ph-video-camera-slash text-4xl text-red-600/80 drop-shadow-xl animate-pulse"></i>` : ''}
                ${p.audioMuted && !p.videoMuted ? `<div class="bg-black/40 p-3 rounded-full border border-red-500/30"><i class="ph ph-microphone-slash text-3xl text-red-500 drop-shadow-lg"></i></div>` : ''}
            `;
        } else {
            overlay.classList.add('hidden');
        }
    }

    const btnAudio = document.getElementById(`btn-audio-${p.id}`);
    if (btnAudio) {
        btnAudio.className = `${p.audioMuted ? 'text-red-500 bg-red-600/10 border-red-500/20' : 'text-gray-400 border-win-border hover:text-white hover:bg-white/5'} p-1.5 border rounded-win transition-all`;
        btnAudio.innerHTML = `<i class="ph ${p.audioMuted ? 'ph-microphone-slash' : 'ph-microphone'} text-sm"></i>`;
    }

    const btnVideo = document.getElementById(`btn-video-${p.id}`);
    if (btnVideo) {
        btnVideo.className = `${p.videoMuted ? 'text-red-500 bg-red-600/10 border-red-500/20' : 'text-gray-400 border-win-border hover:text-win-accent hover:bg-win-accent/5'} p-1.5 border rounded-win transition-all`;
        btnVideo.innerHTML = `<i class="ph ${p.videoMuted ? 'ph-video-camera-slash' : 'ph-video-camera'} text-sm"></i>`;
    }

    const btnPrv = document.getElementById(`btn-prv-${p.id}`);
    const btnPgm = document.getElementById(`btn-pgm-${p.id}`);
    const btnOff = document.getElementById(`btn-off-${p.id}`);
    if (btnPrv && btnPgm && btnOff) {
        btnPrv.className = `text-[9px] font-black px-2.5 py-1 rounded transition-all border ${p.tallyState === 'preview' ? 'bg-green-600/20 text-green-500 border-green-500/40 shadow-[0_0_10px_rgba(34,197,94,0.2)]' : 'bg-win-surface/20 border-win-border hover:bg-white/5 text-gray-500'}`;
        btnPgm.className = `text-[9px] font-black px-2.5 py-1 rounded transition-all border ${p.tallyState === 'program' ? 'bg-red-600/20 text-red-500 border-red-500/40 shadow-[0_0_10px_rgba(239,68,68,0.2)]' : 'bg-win-surface/20 border-win-border hover:bg-white/5 text-gray-500'}`;
        btnOff.className = `text-[9px] font-black px-2.5 py-1 rounded transition-all border ${p.tallyState === 'off' ? 'bg-gray-600/40 text-white border-white/20' : 'bg-win-surface/20 border-win-border hover:bg-white/5 text-gray-500'}`;
    }

    const btnOv = document.getElementById(`btn-ov-toggle-${p.id}`);
    if (btnOv) {
        btnOv.className = `text-[9px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-win transition-all ${p.overlayActive ? 'bg-win-accent text-white shadow-lg shadow-win-accent/20 border border-win-accent' : 'bg-win-surface/30 text-gray-500 hover:text-white border border-win-border'}`;
        btnOv.textContent = 'Disparar';
    }
    const btnHideOv = document.getElementById(`btn-hide-ov-${p.id}`);
    if (btnHideOv) {
        btnHideOv.style.display = p.overlayActive ? 'inline-flex' : 'none';
    }
}

async function initiateConnection(targetId) {
    const offer = await rtcClient.createOffer(targetId);
    ws.send(JSON.stringify({ type: 'offer', roomId: roomName, to: targetId, offer }));
}

// ── Notificação Sonora de Fila ────────────────────────────────────────────────
function playGuestJoinSound() {
    if (!soundEnabled) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();

        // Sino suave: duas notas harmônicas sobrepostas
        [[880, 0.18], [1320, 0.09]].forEach(([freq, gain], i) => {
            const osc = ctx.createOscillator();
            const env = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            env.gain.setValueAtTime(0, ctx.currentTime + i * 0.04);
            env.gain.linearRampToValueAtTime(gain, ctx.currentTime + i * 0.04 + 0.01);
            env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.04 + 0.55);
            osc.connect(env);
            env.connect(ctx.destination);
            osc.start(ctx.currentTime + i * 0.04);
            osc.stop(ctx.currentTime + i * 0.04 + 0.6);
        });

        setTimeout(() => ctx.close(), 1200);
    } catch (e) {
        console.warn('[Sound] Falha ao tocar notificação:', e);
    }
}

function applySoundButtonState() {
    const btn = document.getElementById('btn-sound-toggle');
    if (!btn) return;
    if (soundEnabled) {
        btn.title = 'Silenciar notificações';
        btn.querySelector('i').className = 'ph ph-bell text-lg';
        btn.classList.remove('text-gray-600');
        btn.classList.add('text-gray-400');
    } else {
        btn.title = 'Ativar notificações';
        btn.querySelector('i').className = 'ph ph-bell-slash text-lg';
        btn.classList.remove('text-gray-400');
        btn.classList.add('text-gray-600');
    }
}

function toggleSoundNotifications() {
    soundEnabled = !soundEnabled;
    localStorage.setItem('lyncro_sound_enabled', soundEnabled ? '1' : '0');
    applySoundButtonState();
}

function handleRemoteTrack(targetId, stream) {
    const card = document.getElementById(`video-card-${targetId}`);
    if (card) {
        const video = card.querySelector('video');
        video.srcObject = stream;
        video.onloadedmetadata = () => { video.play().catch(e => console.error('Video play failed:', e)); };
        const waiting = document.getElementById(`waiting-${targetId}`);
        if (waiting) waiting.classList.add('hidden');
    }

    // Iniciar VU Meter se houver áudio
    if (stream.getAudioTracks().length > 0) {
        startVUMeter(targetId, stream);
    }
}

function startVUMeter(participantId, stream) {
    try {
        if (!window.audioCtx) window.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // Limpar anterior se existir
        stopVUMeter(participantId);

        const source = window.audioCtx.createMediaStreamSource(stream);
        const analyzer = window.audioCtx.createAnalyser();
        analyzer.fftSize = 256;
        source.connect(analyzer);

        // Mix-Minus Local: O áudio remoto é conectado ao destino do Host (alto-falantes) 
        // mas podemos silenciar via ganho sem afetar o OBS (que recebe direto via rtc)
        const monitorGain = window.audioCtx.createGain();
        monitorGain.gain.value = isMonitorMuted ? 0 : 1;
        analyzer.connect(monitorGain);
        monitorGain.connect(window.audioCtx.destination);

        const bufferLength = analyzer.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const updateVU = () => {
            analyzer.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
                sum += dataArray[i];
            }
            const average = sum / bufferLength;
            const level = Math.min(100, (average / 128) * 100);

            const vuBar = document.getElementById(`vu-bar-${participantId}`);
            if (vuBar) {
                vuBar.style.height = `${level}%`;
                // Cores suaves: cinza para baixo, azul para ideal
                vuBar.style.backgroundColor = level > 10 ? '#0078d4' : '#4b5563';
                vuBar.style.opacity = level > 5 ? '1' : '0.3';
            }

            if (vuAnalyzers.has(participantId)) {
                vuAnalyzers.get(participantId).animationId = requestAnimationFrame(updateVU);
            }
        };

        vuAnalyzers.set(participantId, { analyzer, monitorGain, animationId: requestAnimationFrame(updateVU) });
    } catch (e) {
        console.error("Erro ao iniciar VU Meter:", e);
    }
}

function stopVUMeter(participantId) {
    if (vuAnalyzers.has(participantId)) {
        cancelAnimationFrame(vuAnalyzers.get(participantId).animationId);
        vuAnalyzers.delete(participantId);
    }
}

window.toggleMonitorMute = () => {
    isMonitorMuted = !isMonitorMuted;
    vuAnalyzers.forEach(data => {
        data.monitorGain.gain.setTargetAtTime(isMonitorMuted ? 0 : 1, window.audioCtx.currentTime, 0.05);
    });

    const btn = document.getElementById('btn-mute-monitor');
    if (btn) {
        btn.classList.toggle('bg-red-600/20', isMonitorMuted);
        btn.classList.toggle('text-red-500', isMonitorMuted);
        btn.innerHTML = `<i class="ph ${isMonitorMuted ? 'ph-speaker-slash' : 'ph-speaker-high'} text-xl"></i>`;
    }
    showToast(isMonitorMuted ? "Monitoramento silenciado" : "Monitoramento ativo", "info");
};

function handleDataMessage(targetId, data) {
    if (data.type === 'file-progress') {
        const card = document.getElementById(`video-card-${targetId}`);
        if (card) {
            let progress = card.querySelector('.file-progress-bar');
            if (!progress) {
                const barContainer = document.createElement('div');
                barContainer.className = "absolute bottom-12 left-2 right-2 h-1 bg-black/50 rounded-full overflow-hidden z-20";
                progress = document.createElement('div');
                progress.className = "file-progress-bar h-full bg-win-accent transition-all duration-200";
                progress.style.width = '0%';
                barContainer.appendChild(progress);
                card.appendChild(barContainer);
            }
            progress.style.width = `${data.progress}%`;
        }
    } else if (data.type === 'file') {
        const url = URL.createObjectURL(data.blob);
        appendChatMessage('Sistema P2P', `Arquivo recebido: <a href="${url}" download="${data.fileName}" class="text-win-accent underline font-bold">${data.fileName}</a>`, Date.now());
        const card = document.getElementById(`video-card-${targetId}`);
        if (card) { const bar = card.querySelector('.file-progress-bar')?.parentElement; if (bar) bar.remove(); }
        showToast(`Arquivo recebido de ${targetId}`, 'success');
    }
}

function handleIceCandidate(targetId, candidate) {
    ws.send(JSON.stringify({ type: 'ice-candidate', roomId: roomName, to: targetId, candidate }));
}

window.handleTallyChange = (pId, state, name) => {
    ws.send(JSON.stringify({ type: 'tally-change', roomId: roomName, participantId: pId, tallyState: state }));
    if (window.lyncroAPI) {
        if (state === 'program') window.lyncroAPI.sendNDIControl({ action: 'start', participantId: pId, name: name });
        else window.lyncroAPI.sendNDIControl({ action: 'stop', participantId: pId });
    }
};

function getLTStyle() {
    return localStorage.getItem('lyncro_lt_style') || 'classic';
}

window.toggleOverlay = (pId) => {
    const p = currentParticipants.find(part => part.id === pId) || (pId === 'local' ? { id: 'local', overlayActive: false } : null);
    if (!p) return;

    const nameInput = document.getElementById(`ov-name-${pId}`);
    const titleInput = document.getElementById(`ov-title-${pId}`);

    ws.send(JSON.stringify({
        type: 'overlay-control',
        roomId: roomName,
        targetId: pId,
        action: 'show',
        name: nameInput ? nameInput.value : p.name,
        title: titleInput ? titleInput.value : '',
        style: getLTStyle()
    }));

    // Atualização otimista
    p.overlayActive = true;
    p.overlayName = nameInput ? nameInput.value : p.name;
    p.overlayTitle = titleInput ? titleInput.value : '';
    updateParticipantStatus(p);
};

window.hideOverlay = (pId) => {
    const p = currentParticipants.find(part => part.id === pId);
    if (!p) return;

    ws.send(JSON.stringify({
        type: 'overlay-control',
        roomId: roomName,
        targetId: pId,
        action: 'hide',
        name: p.overlayName || '',
        title: p.overlayTitle || '',
        style: getLTStyle()
    }));

    p.overlayActive = false;
    updateParticipantStatus(p);
};

function updateLocalOverlay() {
    const overlay = document.getElementById('mute-overlay-local');
    if (!overlay) return;
    if (isHostCamMuted) {
        overlay.classList.remove('hidden');
        overlay.innerHTML = `<i class="ph ph-video-camera-slash text-4xl text-red-600/80 drop-shadow-xl animate-pulse"></i>`;
    } else if (isHostMicMuted) {
        overlay.classList.remove('hidden');
        overlay.innerHTML = `<div class="bg-black/40 p-3 rounded-full border border-red-500/30"><i class="ph ph-microphone-slash text-3xl text-red-500 drop-shadow-lg"></i></div>`;
    } else {
        overlay.classList.add('hidden');
        overlay.innerHTML = '';
    }
}

window.remoteMute = (pId) => {
    // === Host Self-Mute ===
    if (pId === 'local') {
        isHostMicMuted = !isHostMicMuted;
        if (localStream && localStream.getAudioTracks().length > 0) {
            localStream.getAudioTracks()[0].enabled = !isHostMicMuted;
        }
        // Atualizar visual do botão
        const btnAudio = document.getElementById('btn-audio-local');
        if (btnAudio) {
            btnAudio.className = `${isHostMicMuted ? 'text-red-500 bg-red-600/10 border-red-500/20' : 'text-gray-400 border-win-border hover:text-white hover:bg-white/5'} p-1.5 border rounded-l-win transition-all`;
            btnAudio.innerHTML = `<i class="ph ${isHostMicMuted ? 'ph-microphone-slash' : 'ph-microphone'} text-sm"></i>`;
        }
        // Atualizar overlay visual
        updateLocalOverlay();
        showToast(isHostMicMuted ? 'Microfone desligado' : 'Microfone ligado', 'info');
        return;
    }

    const p = currentParticipants.find(part => part.id === pId);
    if (p) {
        p.audioMuted = !p.audioMuted;
        updateParticipantStatus(p);
        ws.send(JSON.stringify({ type: 'media-control', roomId: roomName, targetId: pId, mediaType: 'audio', action: p.audioMuted ? 'mute' : 'unmute' }));
    }
};

window.remoteMuteVideo = (pId) => {
    // === Host Self-Camera Toggle ===
    if (pId === 'local') {
        isHostCamMuted = !isHostCamMuted;
        if (localStream && localStream.getVideoTracks().length > 0) {
            localStream.getVideoTracks()[0].enabled = !isHostCamMuted;
        }
        // Atualizar visual do botão
        const btnVideo = document.getElementById('btn-video-local');
        if (btnVideo) {
            btnVideo.className = `${isHostCamMuted ? 'text-red-500 bg-red-600/10 border-red-500/20' : 'text-gray-400 border-win-border hover:text-win-accent hover:bg-win-accent/5'} p-1.5 border rounded-l-win transition-all`;
            btnVideo.innerHTML = `<i class="ph ${isHostCamMuted ? 'ph-video-camera-slash' : 'ph-video-camera'} text-sm"></i>`;
        }
        // Atualizar overlay visual
        updateLocalOverlay();
        showToast(isHostCamMuted ? 'Câmera desligada' : 'Câmera ligada', 'info');
        return;
    }

    const p = currentParticipants.find(part => part.id === pId);
    if (p) {
        p.videoMuted = !p.videoMuted;
        updateParticipantStatus(p);
        ws.send(JSON.stringify({ type: 'media-control', roomId: roomName, targetId: pId, mediaType: 'video', action: p.videoMuted ? 'mute' : 'unmute' }));
    }
};

// === KICK / BAN ===
window.kickParticipant = (pId, pName) => {
    // Modal de confirmação customizado
    const existingModal = document.getElementById('kick-confirm-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'kick-confirm-modal';
    modal.className = 'fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6';
    modal.innerHTML = `
        <div class="bg-win-surface border border-win-border rounded-lg p-6 shadow-2xl max-w-sm w-full text-center">
            <div class="w-14 h-14 rounded-full bg-red-600/20 border border-red-500/30 flex items-center justify-center mx-auto mb-4">
                <i class="ph ph-user-minus text-2xl text-red-500"></i>
            </div>
            <h3 class="text-lg font-bold text-white mb-2">Banir Convidado?</h3>
            <p class="text-sm text-gray-400 mb-6">Tem certeza que deseja remover <strong class="text-white">${pName}</strong> da sala? Ele será desconectado imediatamente.</p>
            <div class="flex gap-3 justify-center">
                <button id="kick-cancel" class="px-5 py-2 bg-win-surface border border-win-border rounded text-sm font-bold text-gray-300 hover:bg-white/10 transition-all">
                    Cancelar
                </button>
                <button id="kick-confirm" class="px-5 py-2 bg-red-600 border border-red-500 rounded text-sm font-bold text-white hover:bg-red-700 transition-all shadow-lg shadow-red-900/30">
                    <i class="ph ph-user-minus mr-1"></i> Banir
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Fechar ao clicar fora
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });

    document.getElementById('kick-cancel').onclick = () => modal.remove();
    document.getElementById('kick-confirm').onclick = () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'kick',
                roomId: roomName,
                targetId: pId
            }));
        }
        modal.remove();
        showToast(`${pName} foi removido da sala.`, 'info');
    };
};

window.copyCleanFeed = (pId, type = 'camera') => {
    const url = `${window.location.origin}/cleanfeed.html?room=${roomName}&participant=${pId}&type=${type}`;
    navigator.clipboard.writeText(url).then(() => {
        showToast(`Link de ${type === 'screen' ? 'Tela' : 'Câmera'} copiado para o OBS!`, 'success');
    });
};

// === TOGGLE PAINÉIS ===
window.toggleCardPanel = (panelId) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    // Fechar outros painéis do mesmo card
    const card = panel.closest('[id^="video-card-"]');
    if (card) {
        card.querySelectorAll('[id^="lt-panel-"], [id^="vb-panel-"]').forEach(p => {
            if (p.id !== panelId) p.classList.add('hidden');
        });
    }
    panel.classList.toggle('hidden');
};

// toggleCardDropdown definido abaixo com lógica completa de enumeração de dispositivos

window.copyInviteLink = async () => {
    let baseUrl = window.location.origin;
    if ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.lyncroAPI && window.lyncroAPI.getLocalIp) {
        const ip = await window.lyncroAPI.getLocalIp();
        if (ip && ip !== 'localhost') baseUrl = `http://${ip}:3000`;
    }
    const url = `${baseUrl}/guest.html?room=${encodeURIComponent(roomName)}`;
    navigator.clipboard.writeText(url).then(() => { showToast('Link de convite copiado!', 'success'); });
};

init();

function showToast(message, type = "info") {
    const toast = document.createElement('div');
    toast.className = `fixed bottom-6 right-6 px-4 py-2 rounded-win shadow-2xl border border-win-border text-xs z-50 transition-all font-semibold`;
    const colors = { success: 'bg-green-600/90 text-white', error: 'bg-red-600/90 text-white', info: 'bg-win-accent/90 text-white' };
    toast.classList.add(...colors[type].split(' '));
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 3000);
}

// Chat e Typing Indicator movidos para host-chat.js

// Funcao exposta pro HTML para selecionar Fundo (Host)
window.setVirtualBackground = async (mode, imageUrl = null, btnId = null) => {
    currentVbMode = mode;
    currentVbImage = imageUrl;

    let currentVbBtnId = btnId;
    if (!currentVbBtnId) {
        currentVbBtnId = `vb-btn-${mode === 'image' ? (imageUrl?.includes('office') ? 'office-premium' : imageUrl?.includes('studio') ? 'studio-pro' : imageUrl?.includes('loft') ? 'loft' : imageUrl?.includes('living') ? 'living' : 'abstract') : mode}`;
    }

    // Reset UI styling
    document.querySelectorAll('[id^="vb-btn-"]').forEach(el => {
        el.classList.remove('border-win-accent', 'bg-win-accent/10');
        el.classList.add('border-transparent');
    });

    // Highlight selected
    const activeEl = document.getElementById(currentVbBtnId);
    if (activeEl) {
        activeEl.classList.remove('border-transparent');
        activeEl.classList.add('border-win-accent', 'bg-win-accent/10');
    }

    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            // Re-apply process to current localStream and push to RTC
            if (mode !== 'none') {
                try {
                    processedStream = await window.vbManager.start(localStream, { mode, imageUrl });
                    const localVideoEl = document.querySelector('#video-card-local video');
                    if (localVideoEl) localVideoEl.srcObject = processedStream;
                    if (rtcClient) await rtcClient.replaceTrack(processedStream.getVideoTracks()[0]);
                } catch (e) { console.error(e); }
            } else {
                window.vbManager.stop();
                processedStream = localStream;
                const localVideoEl = document.querySelector('#video-card-local video');
                if (localVideoEl) localVideoEl.srcObject = localStream;
                if (rtcClient) await rtcClient.replaceTrack(videoTrack);
            }
        }
    }
};

const openMobileBtn = document.getElementById('openMobileCam');
const qrModal = document.getElementById('qr-modal');
const closeQrModal = document.getElementById('close-qr-modal');
const qrContainer = document.getElementById('qrcode-container');
let qrcodeInstance = null;

if (openMobileBtn && qrModal && closeQrModal && qrContainer) {
    openMobileBtn.onclick = () => {
        qrModal.classList.remove('hidden');
        if (!qrcodeInstance && myId) {
            const baseUrl = window.location.origin;
            const qrUrl = new URL(`${baseUrl}/guest.html`);
            qrUrl.searchParams.set('room', roomName);
            qrUrl.searchParams.set('companionOf', myId);
            qrUrl.searchParams.set('name', 'Lyncro Cam (Host)');
            qrcodeInstance = new QRCode(qrContainer, { text: qrUrl.toString(), width: 200, height: 200, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.H });
        } else if (!myId) {
            showToast("Aguarde a conexão com o servidor...", "error");
            qrModal.classList.add('hidden');
        }
    };
    closeQrModal.onclick = () => { qrModal.classList.add('hidden'); };
}

// ===== COMPARTILHAMENTO DE TELA ======
window.toggleScreenShare = async () => {
    if (isScreenSharing) {
        // Parar compartilhamento
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }
        isScreenSharing = false;

        // Reverter para câmera
        const activeStream = processedStream || localStream;
        if (activeStream && rtcClient) {
            const videoTrack = activeStream.getVideoTracks()[0];
            if (videoTrack) {
                rtcClient.replaceTrack(videoTrack);
            }
        }

        // Atualizar preview local
        const localVideoEl = document.querySelector('#video-card-local video');
        if (localVideoEl) {
            localVideoEl.srcObject = activeStream;
            localVideoEl.style.objectFit = 'cover';
        }

        const btn = document.getElementById('btn-share-screen');
        if (btn) {
            btn.classList.remove('bg-win-accent', 'text-white');
            btn.classList.add('text-gray-400');
            btn.innerHTML = `<i class="ph ph-screencast text-sm text-win-accent group-hover:text-white transition-colors"></i> Tela`;
        }

        // Reabilitar VB local (botão de Fundo Personalizado do Host)
        const vbToggle = document.getElementById('vb-toggle-local');
        if (vbToggle) vbToggle.disabled = false;

    } else {
        // Iniciar compartilhamento
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            isScreenSharing = true;

            const screenTrack = screenStream.getVideoTracks()[0];

            // Reverter automaticamente se usuário parar pelo navegador
            screenTrack.onended = () => {
                if (isScreenSharing) window.toggleScreenShare();
            };

            // Atualizar peers P2P
            if (rtcClient) {
                rtcClient.replaceTrack(screenTrack);
            }

            // Atualizar preview local (sem cortes com 'contain')
            const localVideoEl = document.querySelector('#video-card-local video');
            if (localVideoEl) {
                localVideoEl.srcObject = screenStream;
                localVideoEl.style.objectFit = 'contain';
            }

            const btn = document.getElementById('btn-share-screen');
            if (btn) {
                btn.classList.add('bg-win-accent', 'text-white');
                btn.classList.remove('text-gray-400');
                btn.innerHTML = `<i class="ph ph-screencast text-sm"></i> Parar Tela`;
            }

            // Pausar/Desabilitar VB enquanto tela estiver ativa
            const vbToggle = document.getElementById('vb-toggle-local');
            if (vbToggle) {
                vbToggle.disabled = true;
            }
            if (currentVbMode !== 'none') {
                showToast('Fundo Virtual oculto na tela compartilhada', 'info');
            }

        } catch (e) {
            console.error("Erro ao compartilhar tela:", e);
        }
    }
};

// ==========================================
// Seleção de Câmera/Microfone (Host)
// Dropdown flutuante fixado ao body (z-[9999]) para escapar de qualquer overflow pai
// ==========================================
function getFloatingDropdown() {
    let el = document.getElementById('floating-device-dropdown');
    if (!el) {
        el = document.createElement('div');
        el.id = 'floating-device-dropdown';
        el.className = 'fixed z-[9999] bg-win-surface border border-win-border rounded-win shadow-2xl min-w-[200px] max-h-48 overflow-y-auto';
        el.style.display = 'none';
        document.body.appendChild(el);

        // Fechar ao clicar fora
        document.addEventListener('click', (e) => {
            if (!el.contains(e.target) && !e.target.closest('[data-dropdown-trigger]')) {
                el.style.display = 'none';
                el.dataset.currentId = '';
            }
        }, true);
    }
    return el;
}

window.toggleCardDropdown = async (dropdownId, triggerBtn) => {
    const floating = getFloatingDropdown();

    // Fechar se o mesmo dropdown já está aberto
    if (floating.dataset.currentId === dropdownId && floating.style.display !== 'none') {
        floating.style.display = 'none';
        floating.dataset.currentId = '';
        return;
    }

    // Posicionar abaixo do botão trigger
    const rect = triggerBtn.getBoundingClientRect();
    floating.style.left = `${rect.left}px`;
    floating.style.top = `${rect.bottom + 4}px`;
    floating.style.display = 'block';
    floating.dataset.currentId = dropdownId;
    floating.innerHTML = '<div class="p-3 text-[10px] text-gray-500 text-center">Carregando...</div>';

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();

        let currentAudioId = '';
        let currentVideoId = '';
        if (localStream) {
            const at = localStream.getAudioTracks();
            if (at.length > 0) currentAudioId = at[0].getSettings().deviceId;
            const vt = localStream.getVideoTracks();
            if (vt.length > 0) currentVideoId = vt[0].getSettings().deviceId;
        }

        const isMic = dropdownId.startsWith('mic-');
        const kind = isMic ? 'audioinput' : 'videoinput';
        const filtered = devices.filter(d => d.kind === kind);

        if (filtered.length === 0) {
            floating.innerHTML = '<div class="p-3 text-[10px] text-gray-500 text-center">Nenhum dispositivo detectado</div>';
            return;
        }

        const list = document.createElement('div');
        list.className = 'flex flex-col p-1';
        filtered.forEach((device, idx) => {
            const isSelected = device.deviceId === (isMic ? currentAudioId : currentVideoId);
            const label = device.label || `${isMic ? 'Microfone' : 'Câmera'} ${idx + 1}`;
            const btn = document.createElement('button');
            btn.className = `text-left w-full px-3 py-2 hover:bg-win-accent hover:text-white rounded transition-colors truncate text-[11px] ${isSelected ? 'text-win-accent font-bold bg-white/5' : 'text-gray-300'}`;
            btn.textContent = label;
            btn.onclick = () => switchHostDevice(device.deviceId, isMic ? 'audio' : 'video');
            list.appendChild(btn);
        });
        floating.innerHTML = '';
        floating.appendChild(list);

        // Ajustar se sair da tela
        const fr = floating.getBoundingClientRect();
        if (fr.right > window.innerWidth) floating.style.left = `${window.innerWidth - fr.width - 8}px`;
        if (fr.bottom > window.innerHeight) floating.style.top = `${rect.top - fr.height - 4}px`;
    } catch (e) {
        floating.innerHTML = '<div class="p-3 text-[10px] text-gray-500 text-center">Erro ao listar dispositivos</div>';
    }
};

window.switchHostDevice = async (deviceId, kind) => {
    // Fechar floating dropdown
    const fd = document.getElementById('floating-device-dropdown');
    if (fd) { fd.style.display = 'none'; fd.dataset.currentId = ''; }

    try {
        const constraints = {
            audio: kind === 'audio' ? { deviceId: { exact: deviceId } } : false,
            video: kind === 'video' ? buildVideoConstraints(getHostQuality(), { deviceId: { exact: deviceId } }) : false
        };

        const newStream = await navigator.mediaDevices.getUserMedia(constraints);
        const newTrack = kind === 'video' ? newStream.getVideoTracks()[0] : newStream.getAudioTracks()[0];

        // Manter o estado atual de Mute (se a câmera/mic antigo estava desligado)
        let currentState = true;
        if (kind === 'audio') {
            const oldAudio = localStream.getAudioTracks()[0];
            if (oldAudio) currentState = oldAudio.enabled;
            newTrack.enabled = currentState;
        } else if (kind === 'video') {
            const oldVideo = localStream.getVideoTracks()[0];
            if (oldVideo) currentState = oldVideo.enabled;
            newTrack.enabled = currentState;
        }

        // Remover track original e plugar o novo no stream local
        const oldTrack = kind === 'video' ? localStream.getVideoTracks()[0] : localStream.getAudioTracks()[0];
        if (oldTrack) {
            localStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        localStream.addTrack(newTrack);

        // Atualizar todas as conexões RTCPeerConnection ativas na sala
        if (rtcClient) {
            await rtcClient.replaceTrack(newTrack);
        }

        // Atualiza a pré-visualização na interface do host
        if (kind === 'video') {
            const myCard = document.getElementById('video-card-' + myId);
            if (myCard) {
                const vid = myCard.querySelector('video');
                if (vid) vid.srcObject = localStream;
            }
        }

        console.log(`Dispositivo [${kind}] do Host alterado para: ${deviceId}`);
    } catch (e) {
        console.error(`Erro ao trocar de ${kind} no Host:`, e);
        alert('Mídia bloqueada ou ocupada. Tente novamente.');
    }
};

// ===== SETTINGS MODAL =====
function _settingsModalSetActive(styleKey) {
    document.querySelectorAll('.lt-preview-btn').forEach(btn => {
        const thumb = btn.querySelector('.lt-preview-thumb');
        const label = btn.querySelector('.lt-preview-name');
        const isActive = btn.dataset.lt === styleKey;
        if (thumb) thumb.classList.toggle('lt-selected', isActive);
        if (label) label.style.color = isActive ? '#60a5fa' : '';
        btn.classList.toggle('lt-active', isActive);
    });
}

window.openSettingsModal = () => {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    _settingsModalSetActive(getLTStyle());
};

window.closeSettingsModal = () => {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.style.display = 'none';
};

window.selectLTStyle = (style, btn) => {
    localStorage.setItem('lyncro_lt_style', style);
    _settingsModalSetActive(style);
    showToast(`Estilo "${style}" selecionado`, 'success');
};

// Close settings modal on backdrop click
document.addEventListener('click', (e) => {
    const modal = document.getElementById('settings-modal');
    if (modal && e.target === modal) modal.style.display = 'none';
});

window.changeHostQuality = async (qualityKey) => {
    localStorage.setItem('lyncro_host_quality', qualityKey);
    const preset = VIDEO_QUALITY_PRESETS[qualityKey];
    if (!preset) return;

    // Reaplica a track de vídeo atual com as novas constraints
    const currentVideoTrack = localStream && localStream.getVideoTracks()[0];
    const currentDeviceId = currentVideoTrack && currentVideoTrack.getSettings().deviceId;

    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: buildVideoConstraints(qualityKey, currentDeviceId ? { deviceId: { exact: currentDeviceId } } : {}),
            audio: false
        });
        const newTrack = newStream.getVideoTracks()[0];
        newTrack.enabled = !isHostCamMuted;

        if (currentVideoTrack) {
            localStream.removeTrack(currentVideoTrack);
            currentVideoTrack.stop();
        }
        localStream.addTrack(newTrack);

        if (rtcClient) await rtcClient.replaceTrack(newTrack);

        // Atualiza preview do card local
        const vid = document.querySelector('#video-card-local video');
        if (vid) vid.srcObject = localStream;

        showToast(`Qualidade alterada para ${preset.label}`, 'success');
    } catch (e) {
        console.error('[Quality] Falha ao alterar qualidade:', e);
        showToast(`Câmera não suporta ${preset.label}`, 'error');
        // Reverter seletor para o valor anterior
        const sel = document.getElementById('host-quality-select');
        if (sel) sel.value = getHostQuality();
        localStorage.setItem('lyncro_host_quality', getHostQuality());
    }
};

// ── Master Grid Dashboard ───────────────────────────────────────────────────
window.openMasterGrid = () => {
    const url = new URL(window.location.origin + '/grid.html');
    url.searchParams.set('room', roomName);
    url.searchParams.set('host', 'true'); // Modo host = mostra barra regencial
    window.open(url.toString(), '_blank', 'width=1280,height=720');
};

window.copyMasterGridLink = () => {
    const url = new URL(window.location.origin + '/grid.html');
    url.searchParams.set('room', roomName);
    // Link obs nu sem "?host=true"

    const input = document.createElement('input');
    input.value = url.toString();
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);

    showToast('🚀 Link do Grid Master copiado para o OBS!', 'success');

    // Anim Feedback
    const ico = document.getElementById('ico-copy-grid');
    const btn = document.getElementById('btn-copy-grid');
    if (ico && btn) {
        ico.className = 'ph ph-check text-sm text-white';
        const oldClasses = btn.className;
        btn.className = 'w-9 h-9 bg-green-600 text-white border border-green-500 rounded-lg flex items-center justify-center transition-all shrink-0 shadow-lg';
        setTimeout(() => {
            ico.className = 'ph ph-copy text-sm';
            btn.className = oldClasses;
        }, 3000);
    }
};

let prompterState = {
    targetId: 'all',
    text: '',
    isPlaying: false,
    speed: 4,
    size: 60,
    margin: 5,
    restartToken: 0
};

let isPrompterFinished = false;

window.togglePrompterUI = () => {
    const body = document.getElementById('prompter-body');
    const caret = document.getElementById('prompter-caret');
    if (body.classList.contains('hidden')) {
        body.classList.remove('hidden');
        caret.style.transform = 'rotate(-180deg)';
    } else {
        body.classList.add('hidden');
        caret.style.transform = 'rotate(0deg)';
    }
};

window.togglePrompterPlayback = () => {
    if (isPrompterFinished) {
        prompterState.restartToken = Date.now();
        isPrompterFinished = false;
        prompterState.isPlaying = true;
    } else {
        prompterState.isPlaying = !prompterState.isPlaying;
    }
    updatePrompterPlayButtonUI();
    broadcastPrompterState();
};

function updatePrompterPlayButtonUI() {
    const ico = document.getElementById('ico-prompter-play');
    const btn = document.getElementById('btn-prompter-play');
    if (!ico || !btn) return;

    if (prompterState.isPlaying) {
        ico.className = 'ph ph-pause text-lg';
        btn.classList.add('bg-win-accent', 'text-white');
        btn.classList.remove('bg-win-accent/20', 'text-win-accent', 'border-green-500/50', 'text-green-500', 'bg-green-500/20');
        btn.classList.add('border-win-accent/30');
    } else {
        if (isPrompterFinished) {
            ico.className = 'ph ph-arrow-counter-clockwise text-lg text-green-500';
            btn.classList.remove('bg-win-accent', 'text-white', 'border-win-accent/30', 'text-win-accent', 'bg-win-accent/20');
            btn.classList.add('bg-green-500/20', 'border-green-500/50');
            btn.title = "Reiniciar Letreiro";
        } else {
            ico.className = 'ph ph-play text-lg';
            btn.classList.remove('bg-win-accent', 'text-white', 'border-green-500/50', 'text-green-500', 'bg-green-500/20');
            btn.classList.add('bg-win-accent/20', 'text-win-accent', 'border-win-accent/30');
            btn.title = "Rolar Texto";
        }
    }
}

function broadcastPrompterState() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'prompter-sync',
            roomId: roomName,
            payload: prompterState
        }));
    }
}

// Hook inputs após o carregamento
document.addEventListener('DOMContentLoaded', () => {
    const pTarget = document.getElementById('prompter-target');
    const pText = document.getElementById('prompter-text');
    const pSpeed = document.getElementById('prompter-speed');
    const pSize = document.getElementById('prompter-size');
    const pMargin = document.getElementById('prompter-margin');

    if (pTarget) {
        pTarget.addEventListener('change', (e) => {
            prompterState.targetId = e.target.value;
            broadcastPrompterState();
        });
    }
    if (pText) {
        pText.addEventListener('input', (e) => {
            prompterState.text = e.target.value;
            isPrompterFinished = false;
            updatePrompterPlayButtonUI();
            broadcastPrompterState();
        });
    }
    if (pSpeed) {
        pSpeed.addEventListener('input', (e) => {
            prompterState.speed = parseInt(e.target.value);
            document.getElementById('lbl-prompter-speed').innerText = prompterState.speed + 'x';
            broadcastPrompterState();
        });
    }
    if (pSize) {
        pSize.addEventListener('input', (e) => {
            prompterState.size = parseInt(e.target.value);
            document.getElementById('lbl-prompter-size').innerText = prompterState.size + 'px';
            broadcastPrompterState();
        });
    }
    if (pMargin) {
        pMargin.addEventListener('input', (e) => {
            prompterState.margin = parseInt(e.target.value);
            document.getElementById('lbl-prompter-margin').innerText = prompterState.margin + '%';
            broadcastPrompterState();
        });
    }
});
