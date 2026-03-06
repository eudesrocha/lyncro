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
let currentParticipants = [];

const videoGrid = document.getElementById('video-grid');
const roomIdDisplay = document.getElementById('room-id-display');
if (roomIdDisplay) roomIdDisplay.textContent = `Sala: ${roomName}`;

async function init() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

        // Adicionar o Host no Grid
        renderParticipantCard({ id: 'local', name: `${userName} (Host)`, role: 'host' }, true);
        const localVideoEl = document.querySelector('#video-card-local video');
        if (localVideoEl) localVideoEl.srcObject = localStream;
    } catch (err) {
        console.error('Falha ao iniciar mídia local:', err);
        showToast('Aviso: Câmera/Mic do Host não iniciados (Timeout)', 'info');
        renderParticipantCard({ id: 'local', name: `${userName} (Host)`, role: 'host' }, true);
    }

    setupWebSocket();
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
                        audio: { deviceId: { exact: deviceId } }
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
            audio: kind === 'audio' ? { deviceId: { exact: deviceId } } : false
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
            localVideoEl.srcObject = localStream;
        }

        // Substituir track em todos os peers ativos
        if (rtcClient) {
            await rtcClient.replaceTrack(newTrack);
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
        rtcClient.setLocalStream(localStream);

        const payload = {
            type: 'join',
            roomId: roomName,
            participant: {
                name: 'Host (Você)',
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
        if (p.role === 'host' && p.name === userName) return;

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
            if (queueCountBadge) {
                queueCountBadge.textContent = queueCount;
                queueCountBadge.classList.remove('hidden');
            }
        } else {
            queueSection.classList.add('section-collapsed');
            if (queueCountBadge) {
                queueCountBadge.classList.add('hidden');
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
              <button onclick="copyCleanFeed('${participant.id}')" title="Copiar Link Clean Feed" class="text-[9px] font-bold uppercase text-win-accent hover:text-white transition-all flex items-center gap-1">
                <i class="ph ph-copy"></i> Feed
              </button>
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
}

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
    if (p) { p.audioMuted = !p.audioMuted; updateParticipantStatus(p); }
    ws.send(JSON.stringify({ type: 'media-control', roomId: roomName, targetId: pId, mediaType: 'audio', action: 'toggle' }));
};

window.remoteMuteVideo = (pId) => {
    const p = currentParticipants.find(part => part.id === pId);
    if (p) { p.videoMuted = !p.videoMuted; updateParticipantStatus(p); }
    ws.send(JSON.stringify({ type: 'media-control', roomId: roomName, targetId: pId, mediaType: 'video', action: 'toggle' }));
};

window.copyCleanFeed = (pId) => {
    const url = `${window.location.origin}/cleanfeed.html?room=${roomName}&participant=${pId}`;
    navigator.clipboard.writeText(url).then(() => { alert('URL do Clean Feed copiada para o OBS!'); });
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
