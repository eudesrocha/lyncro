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

const urlParams = new URLSearchParams(window.location.search);
const roomName = urlParams.get('room') || 'default';
const userName = urlParams.get('name') || 'Host';

let localStream;
let returnAudioStream = null; // Áudio de Loopback do Mix-Minus
let rtcClient;
let ws;
let myId;
let processedStream = null; // Stream pós-IA (se ativo)
let currentVbMode = 'none';
let currentVbImage = null;
let currentParticipants = [];
let isMonitorMuted = false;
const vuAnalyzers = new Map(); // participantId -> { analyzer, dataArray, animationId }

const videoGrid = document.getElementById('video-grid');
const roomIdDisplay = document.getElementById('room-id-display');
if (roomIdDisplay) roomIdDisplay.textContent = `Sala: ${roomName}`;

async function init() {
    // 1. Iniciar WebSocket imediatamente para ver a fila de espera
    setupWebSocket();

    // 2. Renderizar card local (vazio inicialmente)
    renderParticipantCard({ id: 'local', name: userName, role: 'host' }, true);

    // 3. Solicitar mídias em background
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

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

        const videoSelect = document.getElementById('local-video-device-select');
        const audioSelect = document.getElementById('local-audio-device-select');
        const returnSelect = document.getElementById('return-audio-select');

        // Preencher Vídeo
        if (videoSelect) {
            videoSelect.innerHTML = '<option value="">Câmera</option>';
            videoInputs.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Câmera ${videoSelect.length}`;
                videoSelect.appendChild(option);
            });
            videoSelect.onchange = (e) => updateHostDevice('video', e.target.value);
        }

        // Preencher Áudio
        if (audioSelect) {
            audioSelect.innerHTML = '<option value="">Mic</option>';
            audioInputs.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Mic ${audioSelect.length}`;
                audioSelect.appendChild(option);
            });
            audioSelect.onchange = (e) => updateHostDevice('audio', e.target.value);
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

function setupWebSocket() {
    let wsUrl;
    if (window.LYNCRO_CONFIG && window.LYNCRO_CONFIG.SIGNALING_URL) {
        wsUrl = window.LYNCRO_CONFIG.SIGNALING_URL;
    } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        wsUrl = `${protocol}//${host}`;
    }

    ws = new WebSocket(wsUrl);
    const storedPassword = localStorage.getItem(`room_pwd_${roomName}`);

    ws.onopen = () => {
        rtcClient = new WebRTCClient(userName, handleRemoteTrack, handleIceCandidate, initiateConnection, null, handleDataMessage);
        rtcClient.setLocalStream(processedStream || localStream);

        const payload = {
            type: 'join',
            roomId: roomName,
            participant: {
                name: userName,
                role: 'host'
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
                if (rtcClient) rtcClient.updateConfig(data.iceServers);
                break;
            case 'participant-update':
                updateUI(data.participants);
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
        }
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
}

function renderWaitingParticipant(participant) {
    const waitingList = document.getElementById('waiting-list');
    if (!waitingList) return;

    const card = document.createElement('div');
    card.id = `queue-card-${participant.id}`;
    card.className = "bg-white/5 border border-win-border rounded-win p-2.5 flex items-center justify-between group hover:bg-white/10 transition-all";

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
    card.className = "bg-win-card border border-win-border rounded-win overflow-hidden shadow-xl flex flex-col";

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
      </div>

      <div class="p-3 flex justify-between items-center bg-white/5 border-t border-win-border">
        <div class="flex gap-2 items-center">
          <div class="flex items-center gap-1.5">
            <button id="btn-audio-${participant.id}" class="${participant.audioMuted ? 'text-red-500 bg-red-600/10 border-red-500/20' : 'text-gray-400 border-win-border hover:text-white hover:bg-white/5'} p-1.5 border rounded-win transition-all" onclick="remoteMute('${participant.id}')">
                <i class="ph ${participant.audioMuted ? 'ph-microphone-slash' : 'ph-microphone'} text-sm"></i>
            </button>
            ${isLocal ? `<select id="local-audio-device-select" class="device-select-compact"></select>` : ''}
          </div>

          <div class="flex items-center gap-1.5">
            <button id="btn-video-${participant.id}" class="${participant.videoMuted ? 'text-red-500 bg-red-600/10 border-red-500/20' : 'text-gray-400 border-win-border hover:text-win-accent hover:bg-win-accent/5'} p-1.5 border rounded-win transition-all" onclick="remoteMuteVideo('${participant.id}')">
                <i class="ph ${participant.videoMuted ? 'ph-video-camera-slash' : 'ph-video-camera'} text-sm"></i>
            </button>
            ${isLocal ? `<select id="local-video-device-select" class="device-select-compact"></select>` : ''}
          </div>
        </div>

        ${isLocal ? '' : `
        <div class="flex items-center gap-1">
          <button id="btn-prv-${participant.id}" onclick="handleTallyChange('${participant.id}', 'preview', '${participant.name}')" 
            class="text-[9px] font-black px-2.5 py-1 rounded transition-all border ${participant.tallyState === 'preview' ? 'bg-green-600/20 text-green-500 border-green-500/40 shadow-[0_0_10px_rgba(34,197,94,0.2)]' : 'bg-win-surface/20 border-win-border hover:bg-white/5 text-gray-500'}">PRV</button>
          <button id="btn-pgm-${participant.id}" onclick="handleTallyChange('${participant.id}', 'program', '${participant.name}')" 
            class="text-[9px] font-black px-2.5 py-1 rounded transition-all border ${participant.tallyState === 'program' ? 'bg-red-600/20 text-red-500 border-red-500/40 shadow-[0_0_10px_rgba(239,68,68,0.2)]' : 'bg-win-surface/20 border-win-border hover:bg-white/5 text-gray-500'}">PGM</button>
          <button id="btn-off-${participant.id}" onclick="handleTallyChange('${participant.id}', 'off', '${participant.name}')" 
            class="text-[9px] font-black px-2.5 py-1 rounded transition-all border ${participant.tallyState === 'off' ? 'bg-gray-600/40 text-white border-white/20' : 'bg-win-surface/20 border-win-border hover:bg-white/5 text-gray-500'}">OFF</button>
        </div>
        `}
      </div>

      <div id="overlay-controls-${participant.id}" class="px-3 pb-3 bg-white/5 border-t border-win-border/10">
        <div class="flex flex-col gap-2 pt-3">
          <div class="flex justify-between items-center mb-1">
            <span class="text-[9px] font-bold text-gray-500 uppercase tracking-widest leading-none opacity-50">Lower Third (Overlay)</span>
            <div class="flex items-center gap-2">
              ${isLocal ? '' : `
              <button onclick="copyCleanFeed('${participant.id}')" title="Copiar Link Clean Feed Câmera" class="text-[9px] font-bold uppercase text-win-accent hover:text-white transition-all flex items-center gap-1">
                <i class="ph ph-copy"></i> Feed
              </button>
              ${participant.isScreenSharing ? `
              <button onclick="copyCleanFeed('${participant.id}', 'screen')" title="Copiar Link Clean Feed Tela" class="text-[9px] font-bold uppercase text-blue-400 hover:text-white transition-all flex items-center gap-1">
                <i class="ph ph-monitor"></i> Tela
              </button>
              ` : ''}
              `}
              <button id="btn-ov-toggle-${participant.id}" onclick="toggleOverlay('${participant.id}')" 
                class="text-[9px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-win transition-all ${participant.overlayActive ? 'bg-win-accent text-white shadow-lg shadow-win-accent/20 border border-win-accent' : 'bg-win-surface/30 text-gray-500 hover:text-white border border-win-border'}">
                ${participant.overlayActive ? 'Ocultar' : 'Disparar'}
              </button>
            </div>
          </div>
          <div class="flex gap-1.5">
            <input type="text" id="ov-name-${participant.id}" placeholder="Nome" value="${participant.overlayName || participant.name || ''}"
              class="flex-1 bg-black/30 border border-win-border/30 rounded px-2.5 py-2 text-[11px] outline-none focus:border-win-accent transition-all placeholder:text-gray-700 text-gray-300">
            <input type="text" id="ov-title-${participant.id}" placeholder="Tagline / Título" value="${participant.overlayTitle || ''}"
              class="flex-1 bg-black/30 border border-win-border/30 rounded px-2.5 py-2 text-[11px] outline-none focus:border-win-accent transition-all placeholder:text-gray-700 text-gray-300">
          </div>
        </div>
      </div>

      ${isLocal ? `
      <!-- Virtual Background Selector (Host Only) -->
      <div class="px-3 pb-3 bg-white/5 border-t border-win-border/10">
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
                        <button onclick="setVirtualBackground('anim-window', 'img/bg-window-tree.png', this.id)"
                            id="vb-btn-anim-window"
                            class="flex-none snap-start flex flex-col items-center justify-center p-0 rounded-xl border border-transparent overflow-hidden transition-all hover:border-win-accent cursor-pointer group relative w-[5.5rem] h-16">
                            <img src="img/bg-window-tree.png" alt="Window" class="w-full h-full object-cover">
                            <div class="absolute inset-0 bg-black/40 group-hover:bg-transparent transition-all"></div>
                            <div class="absolute top-1 right-1 bg-black/60 rounded px-1"><i
                                    class="ph ph-film-strip text-white text-[10px]"></i></div>
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
        btnOv.textContent = p.overlayActive ? 'Ocultar' : 'Disparar';
    }
}

async function initiateConnection(targetId) {
    const offer = await rtcClient.createOffer(targetId);
    ws.send(JSON.stringify({ type: 'offer', roomId: roomName, to: targetId, offer }));
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

window.toggleOverlay = (pId) => {
    const p = currentParticipants.find(part => part.id === pId) || (pId === 'local' ? { id: 'local', overlayActive: false } : null);
    if (!p) return;

    const nameInput = document.getElementById(`ov-name-${pId}`);
    const titleInput = document.getElementById(`ov-title-${pId}`);
    const action = p.overlayActive ? 'hide' : 'show';

    ws.send(JSON.stringify({
        type: 'overlay-control',
        roomId: roomName,
        targetId: pId,
        action: action,
        name: nameInput ? nameInput.value : p.name,
        title: titleInput ? titleInput.value : ''
    }));

    // Atualização otimista
    p.overlayActive = (action === 'show');
    p.overlayName = nameInput ? nameInput.value : p.name;
    p.overlayTitle = titleInput ? titleInput.value : '';
    updateParticipantStatus(p);
};

window.remoteMute = (pId) => {
    const p = currentParticipants.find(part => part.id === pId);
    if (p) {
        p.audioMuted = !p.audioMuted;
        updateParticipantStatus(p);
        ws.send(JSON.stringify({ type: 'media-control', roomId: roomName, targetId: pId, mediaType: 'audio', action: p.audioMuted ? 'mute' : 'unmute' }));
    }
};

window.remoteMuteVideo = (pId) => {
    const p = currentParticipants.find(part => part.id === pId);
    if (p) {
        p.videoMuted = !p.videoMuted;
        updateParticipantStatus(p);
        ws.send(JSON.stringify({ type: 'media-control', roomId: roomName, targetId: pId, mediaType: 'video', action: p.videoMuted ? 'mute' : 'unmute' }));
    }
};

window.copyCleanFeed = (pId, type = 'camera') => {
    const url = `${window.location.origin}/cleanfeed.html?room=${roomName}&participant=${pId}&type=${type}`;
    navigator.clipboard.writeText(url).then(() => {
        showToast(`Link de ${type === 'screen' ? 'Tela' : 'Câmera'} copiado para o OBS!`, 'success');
    });
};

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

const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const sendChatBtn = document.getElementById('send-chat');

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (text && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat', roomId: roomName, name: 'Produção (Host)', text: text, timestamp: Date.now() }));
        chatInput.value = '';
    }
}

if (sendChatBtn) sendChatBtn.onclick = sendChatMessage;
if (chatInput) chatInput.onkeypress = (e) => { if (e.key === 'Enter') sendChatMessage(); };

// --- Typing Indicator ---
let typingTimeout = null;
const typingIndicatorEl = document.getElementById('typing-indicator');
const typingUsers = new Set();

if (chatInput) {
    chatInput.addEventListener('input', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'chat-typing', roomId: roomName, name: 'Produção (Host)', isTyping: true }));
        }
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'chat-typing', roomId: roomName, name: 'Produção (Host)', isTyping: false }));
            }
        }, 1500);
    });
}

function handleTypingIndicator(name, isTyping) {
    if (name === 'Produção (Host)') return; // Ignore own typing
    if (isTyping) {
        typingUsers.add(name);
    } else {
        typingUsers.delete(name);
    }
    if (typingIndicatorEl) {
        if (typingUsers.size > 0) {
            const names = Array.from(typingUsers).join(', ');
            typingIndicatorEl.textContent = `${names} está digitando...`;
            typingIndicatorEl.classList.remove('hidden');
        } else {
            typingIndicatorEl.classList.add('hidden');
        }
    }
}

function appendChatMessage(name, text, time) {
    if (!chatMessages) return;
    const msg = document.createElement('div');
    const isMe = name === 'Produção (Host)';
    msg.className = `flex flex-col max-w-[90%] ${isMe ? 'self-end items-end' : 'self-start items-start'}`;
    const timeStr = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    msg.innerHTML = `
        <span class="text-[9px] text-gray-500 mb-1 px-1 font-bold uppercase tracking-tighter">${name} • ${timeStr}</span>
        <div class="px-4 py-2 rounded-win shadow-lg ${isMe ? 'bg-win-accent text-white border-none' : 'bg-black/40 border border-win-border/60 text-gray-200'} text-sm leading-relaxed">
            ${text}
        </div>
    `;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

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
