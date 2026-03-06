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
roomIdDisplay.textContent = `Sala: ${roomName}`;

async function init() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

        // Adicionar o Host no Grid
        renderParticipantCard({ id: 'local', name: `${userName} (Host)`, role: 'host' }, true);
        const localVideoEl = document.querySelector('#video-card-local video');
        if (localVideoEl) localVideoEl.srcObject = localStream;
    } catch (err) {
        console.error('Falha ao iniciar mídia local:', err);
        // Não bloqueia o app, apenas avisa
        showToast('Aviso: Câmera/Mic do Host não iniciados (Timeout)', 'info');
        // Renderiza card vazio para o host
        renderParticipantCard({ id: 'local', name: `${userName} (Host)`, role: 'host' }, true);
    }

    // SEMPRE conecta o socket, mesmo que a câmera local dê erro
    setupWebSocket();
    await enumerateAudioDevices();
}

// Lógica de Retorno de Áudio (Mix-Minus)
async function enumerateAudioDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        const returnSelect = document.getElementById('return-audio-select');

        if (returnSelect) {
            audioInputs.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Microfone ${returnSelect.length}`;
                returnSelect.appendChild(option);
            });

            returnSelect.addEventListener('change', async (e) => {
                const deviceId = e.target.value;
                if (!deviceId) {
                    if (returnAudioStream) {
                        returnAudioStream.getTracks().forEach(t => t.stop());
                        returnAudioStream = null;
                        console.log("Retorno de áudio desativado.");
                        if (rtcClient) rtcClient.removeReturnAudioTrack();
                    }
                    return;
                }

                try {
                    returnAudioStream = await navigator.mediaDevices.getUserMedia({
                        audio: { deviceId: { exact: deviceId } }
                    });
                    console.log(`Retorno de áudio ativado: ${deviceId}`, returnAudioStream.getAudioTracks()[0].label);
                    // TODO: Injetar track nos peers existentes
                    injectReturnAudioToPeers();
                } catch (err) {
                    console.error("Erro ao capturar retorno de áudio:", err);
                    alert("Falha ao capturar o dispositivo selecionado.");
                }
            });
        }
    } catch (error) {
        console.error('Erro ao enumerar dispositivos de audio:', error);
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

    // Priorizar configuração global se disponível e preenchida
    if (window.LYNCRO_CONFIG && window.LYNCRO_CONFIG.SIGNALING_URL) {
        wsUrl = window.LYNCRO_CONFIG.SIGNALING_URL;
    } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host; // Detecta automaticamente o domínio ou IP:Porta
        wsUrl = `${protocol}//${host}`;
    }

    console.log(`Conectando ao servidor Lyncro em: ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    const storedPassword = localStorage.getItem(`room_pwd_${roomName}`);

    ws.onopen = () => {
        rtcClient = new WebRTCClient(userName, handleRemoteTrack, handleIceCandidate, initiateConnection, null, handleDataMessage);
        rtcClient.setLocalStream(localStream);

        console.log('WS: Conectado. Enviando join como Host...');
        const payload = {
            type: 'join',
            roomId: roomName,
            participant: {
                name: 'Host (Você)',
                role: 'host'
            }
        };

        if (storedPassword) {
            payload.password = storedPassword;
        }

        ws.send(JSON.stringify(payload));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case 'init-network':
                myId = data.yourId;
                if (rtcClient) rtcClient.updateConfig(data.iceServers);
                console.log('My ID:', myId);
                break;
            case 'participant-update':
                console.log('Lista de participantes recebida:', data.participants);
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

    // Manter lista de quem deve estar no grid principal (Aceitos)
    const currentParticipantIds = participants.filter(p => p.status === 'accepted' || p.role === 'host').map(p => p.id);
    let queueCount = 0;

    // Limpar a fila de espera visual antes de repreencher
    if (waitingList) waitingList.innerHTML = '';

    participants.forEach(p => {
        if (p.role === 'observer' || (p.name && p.name.startsWith('OBS-'))) {
            return;
        }
        if (p.role === 'host' && p.name === userName) return;

        // Se está aguardando aprovação, renderiza na barra lateral
        if (p.status === 'waiting') {
            queueCount++;
            renderWaitingParticipant(p);
            return; // Interrompe para não tentar renderizar o vídeo
        }

        // Se chegou aqui, está 'accepted'. Renderiza no vídeo matrix.
        if (!document.getElementById(`video-card-${p.id}`)) {
            renderParticipantCard(p);
        } else {
            // Atualizar status (onAir, muted, etc) no componente existente
            updateParticipantStatus(p);
        }

        // Apenas estabelece conexão WebRTC P2P se a pessoa foi "accepted"
        if (!rtcClient.peers.has(p.id) && p.role !== 'observer' && myId && myId < p.id) {
            console.log('Initiating connection to accepted guest:', p.id);
            initiateConnection(p.id);
        }
    });

    // Atualizar Badge de Notificação
    if (queueCountBadge) {
        queueCountBadge.textContent = queueCount;
        if (queueCount > 0) {
            queueCountBadge.classList.remove('hidden');
            emptyQueueMsg.classList.add('hidden');
        } else {
            queueCountBadge.classList.add('hidden');
            emptyQueueMsg.classList.remove('hidden');
        }
    }

    // Remover do Video Grid principal quem saiu ou foi rebaixado
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
    card.className = "bg-win-surface border border-win-border rounded-win p-2 flex items-center justify-between";

    card.innerHTML = `
        <div class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-full bg-win-accent flex items-center justify-center text-white font-bold text-xs uppercase shadow-inner">
                ${participant.name.charAt(0)}
            </div>
            <div class="flex flex-col">
                <span class="text-sm font-semibold truncate max-w-[120px]" title="${participant.name}">${participant.name}</span>
                <span class="text-[9px] text-gray-500">Aguardando...</span>
            </div>
        </div>
        <div class="flex gap-1">
            <button onclick="handleAdmission('${participant.id}', 'accepted')" class="w-8 h-8 rounded bg-green-600/20 text-green-500 hover:bg-green-600 hover:text-white transition-all flex items-center justify-center" title="Aprovar Entrada">
                <i class="ph ph-check font-bold"></i>
            </button>
            <button onclick="handleAdmission('${participant.id}', 'rejected')" class="w-8 h-8 rounded bg-red-600/20 text-red-500 hover:bg-red-600 hover:text-white transition-all flex items-center justify-center" title="Recusar">
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
      <div class="aspect-video bg-black relative group">
        <video class="w-full h-full object-cover" autoplay playsinline ${isLocal ? 'muted' : ''}></video>
        
        <div class="absolute inset-0 flex items-center justify-center opacity-30 ${isLocal ? 'hidden' : ''}" id="waiting-${participant.id}">
          <span class="text-xs italic">Aguardando Convidado...</span>
        </div>

        <div id="mute-overlay-${participant.id}" class="absolute inset-0 media-muted-overlay ${participant.audioMuted || participant.videoMuted ? '' : 'hidden'}">
          ${participant.videoMuted ? `
            <div class="flex flex-col items-center animate-pulse">
              <i class="ph ph-video-camera-slash text-3xl text-red-500"></i>
              <span class="text-[10px] font-bold uppercase tracking-widest text-red-500 mt-2">Câmera Desligada</span>
            </div>
          ` : ''}
          ${participant.audioMuted ? `
            <div class="flex items-center gap-2 bg-red-600/20 px-3 py-1 rounded-full border border-red-500/30">
              <i class="ph ph-microphone-slash text-red-500"></i>
              <span class="text-[9px] font-bold uppercase text-red-500">Mudo</span>
            </div>
          ` : ''}
        </div>
        
        <div class="absolute top-3 right-3 flex items-center gap-2 bg-black/60 backdrop-blur-md px-2 py-1 rounded-sm border border-win-border">
          <div id="tally-dot-${participant.id}" class="w-2 h-2 rounded-full ${participant.tallyState === 'program' ? 'bg-red-500 animate-pulse' : participant.tallyState === 'preview' ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}"></div>
          <span id="tally-text-${participant.id}" class="text-[10px] font-bold tracking-widest uppercase">${participant.tallyState === 'program' ? 'No Ar' : participant.tallyState === 'preview' ? 'Preview' : 'Standby'}</span>
        </div>

        <div class="absolute bottom-3 left-3 bg-black/40 px-2 py-0.5 rounded text-xs">
          ${participant.name} ${isLocal ? '(Você)' : ''}
        </div>
      </div>

      <div class="p-3 flex justify-between items-center bg-win-surface/40">
        <div class="flex gap-3">
          <button id="btn-audio-${participant.id}" class="${participant.audioMuted ? 'text-red-500 bg-red-600/20' : 'hover:text-red-400'} p-1 rounded transition-colors" onclick="remoteMute('${participant.id}')">
             <i class="ph ${participant.audioMuted ? 'ph-microphone-slash' : 'ph-microphone'}"></i>
          </button>
          <button id="btn-video-${participant.id}" class="${participant.videoMuted ? 'text-red-500 bg-red-600/20' : 'hover:text-win-accent'} p-1 rounded transition-colors" onclick="remoteMuteVideo('${participant.id}')">
             <i class="ph ${participant.videoMuted ? 'ph-video-camera-slash' : 'ph-video-camera'}"></i>
          </button>
        </div>
        
        ${isLocal ? '' : `
        <div class="flex items-center gap-1">
          <button id="btn-prv-${participant.id}" onclick="handleTallyChange('${participant.id}', 'preview', '${participant.name}')" class="text-[10px] font-bold px-2 py-1 rounded transition-all ${participant.tallyState === 'preview' ? 'bg-green-600 text-white' : 'bg-win-surface hover:bg-white/10 text-gray-400'}">PRV</button>
          <button id="btn-pgm-${participant.id}" onclick="handleTallyChange('${participant.id}', 'program', '${participant.name}')" class="text-[10px] font-bold px-2 py-1 rounded transition-all ${participant.tallyState === 'program' ? 'bg-red-600 text-white' : 'bg-win-surface hover:bg-white/10 text-gray-400'}">PGM</button>
          <button id="btn-off-${participant.id}" onclick="handleTallyChange('${participant.id}', 'off', '${participant.name}')" class="text-[10px] font-bold px-2 py-1 rounded transition-all ${participant.tallyState === 'off' ? 'bg-gray-600 text-white' : 'bg-win-surface hover:bg-white/10 text-gray-400'}">OFF</button>
        </div>
        <button class="text-[9px] text-win-accent hover:underline ml-2" onclick="copyCleanFeed('${participant.id}')">Clean Feed</button>
        `}
      </div>
    `;

    videoGrid.appendChild(card);

    // Lógica de Drag & Drop para Media Drop
    if (!isLocal) {
        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            card.classList.add('border-win-accent', 'scale-[1.02]');
        });

        card.addEventListener('dragleave', () => {
            card.classList.remove('border-win-accent', 'scale-[1.02]');
        });

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

                    // Sucesso
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

    // Atualizar badge ON AIR / NDI
    const dot = document.getElementById(`tally-dot-${p.id}`);
    const text = document.getElementById(`tally-text-${p.id}`);
    if (dot && text) {
        if (p.tallyState === 'program') {
            dot.className = "w-2 h-2 rounded-full bg-red-500 animate-pulse";
            text.textContent = "No Ar";
        } else if (p.tallyState === 'preview') {
            dot.className = "w-2 h-2 rounded-full bg-green-500 animate-pulse";
            text.textContent = "Preview";
        } else {
            dot.className = "w-2 h-2 rounded-full bg-gray-500";
            text.textContent = "Standby";
        }
    }

    // Atualizar Overlays de Mídia
    const overlay = document.getElementById(`mute-overlay-${p.id}`);
    if (overlay) {
        if (p.audioMuted || p.videoMuted) {
            overlay.classList.remove('hidden');
            overlay.innerHTML = `
                ${p.videoMuted ? `
                    <div class="flex flex-col items-center animate-pulse">
                        <i class="ph ph-video-camera-slash text-3xl text-red-500"></i>
                        <span class="text-[10px] font-bold uppercase tracking-widest text-red-500 mt-2">Câmera Desligada</span>
                    </div>
                ` : ''}
                ${p.audioMuted ? `
                    <div class="flex items-center gap-2 bg-red-600/20 px-3 py-1 rounded-full border border-red-500/30">
                        <i class="ph ph-microphone-slash text-red-500"></i>
                        <span class="text-[9px] font-bold uppercase text-red-500">Mudo</span>
                    </div>
                ` : ''}
            `;
        } else {
            overlay.classList.add('hidden');
        }
    }

    // Atualizar Ícones de Audio/Video nos botões
    const btnAudio = document.getElementById(`btn-audio-${p.id}`);
    if (btnAudio) {
        btnAudio.className = `${p.audioMuted ? 'text-red-500 bg-red-600/20' : 'hover:text-red-400'} p-1 rounded transition-colors`;
        btnAudio.innerHTML = `<i class="ph ${p.audioMuted ? 'ph-microphone-slash' : 'ph-microphone'}"></i>`;
    }

    const btnVideo = document.getElementById(`btn-video-${p.id}`);
    if (btnVideo) {
        btnVideo.className = `${p.videoMuted ? 'text-red-500 bg-red-600/20' : 'hover:text-win-accent'} p-1 rounded transition-colors`;
        btnVideo.innerHTML = `<i class="ph ${p.videoMuted ? 'ph-video-camera-slash' : 'ph-video-camera'}"></i>`;
    }

    // Atualizar Botões de Controle Tally
    const btnPrv = document.getElementById(`btn-prv-${p.id}`);
    const btnPgm = document.getElementById(`btn-pgm-${p.id}`);
    const btnOff = document.getElementById(`btn-off-${p.id}`);

    if (btnPrv && btnPgm && btnOff) {
        btnPrv.className = `text-[10px] font-bold px-2 py-1 rounded transition-all ${p.tallyState === 'preview' ? 'bg-green-600 text-white' : 'bg-win-surface hover:bg-white/10 text-gray-400'}`;
        btnPgm.className = `text-[10px] font-bold px-2 py-1 rounded transition-all ${p.tallyState === 'program' ? 'bg-red-600 text-white' : 'bg-win-surface hover:bg-white/10 text-gray-400'}`;
        btnOff.className = `text-[10px] font-bold px-2 py-1 rounded transition-all ${p.tallyState === 'off' ? 'bg-gray-600 text-white' : 'bg-win-surface hover:bg-white/10 text-gray-400'}`;
    }
}

async function initiateConnection(targetId) {
    const offer = await rtcClient.createOffer(targetId);
    ws.send(JSON.stringify({ type: 'offer', roomId: roomName, to: targetId, offer }));
}

function handleRemoteTrack(targetId, stream) {
    console.log('Attaching remote stream for:', targetId);
    const card = document.getElementById(`video-card-${targetId}`);
    if (card) {
        const video = card.querySelector('video');
        video.srcObject = stream;
        video.onloadedmetadata = () => {
            video.play().catch(e => console.error('Video play failed:', e));
        };
        const waiting = document.getElementById(`waiting-${targetId}`);
        if (waiting) waiting.classList.add('hidden');
    }
}

function handleDataMessage(targetId, data) {
    if (data.type === 'file-progress') {
        // console.log(`Arquivo ${data.fileName}: ${data.progress.toFixed(1)}%`);
        // Opcional: Atualizar UI de progresso no card
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
        console.log('Arquivo recebido via P2P:', data.fileName);
        const url = URL.createObjectURL(data.blob);

        // Notificar no chat com link de download
        appendChatMessage('Sistema P2P', `Arquivo recebido: <a href="${url}" download="${data.fileName}" class="text-win-accent underline font-bold">${data.fileName}</a>`, Date.now());

        // Limpar barra de progresso
        const card = document.getElementById(`video-card-${targetId}`);
        if (card) {
            const bar = card.querySelector('.file-progress-bar')?.parentElement;
            if (bar) bar.remove();
        }

        showToast(`Arquivo recebido de ${targetId}`, 'success');
    }
}

function handleIceCandidate(targetId, candidate) {
    ws.send(JSON.stringify({ type: 'ice-candidate', roomId: roomName, to: targetId, candidate }));
}

// Host Controls
window.handleTallyChange = (pId, state, name) => {
    ws.send(JSON.stringify({
        type: 'tally-change',
        roomId: roomName,
        participantId: pId,
        tallyState: state
    }));

    // Integração NDI Mock/IPC - Apenas liga se for Programa
    if (window.lyncroAPI) {
        if (state === 'program') {
            window.lyncroAPI.sendNDIControl({ action: 'start', participantId: pId, name: name });
        } else {
            // Se for Preview ou Off, não vai pro ar no NDI
            window.lyncroAPI.sendNDIControl({ action: 'stop', participantId: pId });
        }
    }
};

window.remoteMute = (pId) => {
    // Busca o participante atual na lista
    const p = currentParticipants.find(part => part.id === pId);
    if (p) {
        // Atualização Otimista na UI
        p.audioMuted = !p.audioMuted;
        updateParticipantStatus(p);
    }

    ws.send(JSON.stringify({
        type: 'media-control',
        roomId: roomName,
        targetId: pId,
        mediaType: 'audio',
        action: 'toggle'
    }));
};

window.remoteMuteVideo = (pId) => {
    const p = currentParticipants.find(part => part.id === pId);
    if (p) {
        // Atualização Otimista na UI
        p.videoMuted = !p.videoMuted;
        updateParticipantStatus(p);
    }

    ws.send(JSON.stringify({
        type: 'media-control',
        roomId: roomName,
        targetId: pId,
        mediaType: 'video',
        action: 'toggle'
    }));
};

window.copyCleanFeed = (pId) => {
    const url = `${window.location.origin}/cleanfeed.html?room=${roomName}&participant=${pId}`;
    navigator.clipboard.writeText(url).then(() => {
        alert('URL do Clean Feed copiada para o OBS!');
    });
};

window.copyInviteLink = async () => {
    let baseUrl = window.location.origin;

    // Se estivermos em localhost no Electron, tentamos oferecer o IP da rede local como alternativa
    if ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') &&
        window.lyncroAPI && window.lyncroAPI.getLocalIp) {
        const ip = await window.lyncroAPI.getLocalIp();
        if (ip && ip !== 'localhost') {
            baseUrl = `http://${ip}:3000`;
            showToast('Dica: Link local gerado para dispositivos no mesmo Wi-Fi.', 'info');
        }
    }

    const url = `${baseUrl}/guest.html?room=${encodeURIComponent(roomName)}`;
    navigator.clipboard.writeText(url).then(() => {
        showToast('Link de convite copiado!', 'success');
    });
};

init();

function showToast(message, type = "info") {
    const toast = document.createElement('div');
    toast.className = `fixed bottom-6 right-6 px-4 py-2 rounded-win shadow-2xl border border-win-border text-xs z-50 transition-all font-semibold`;

    const colors = {
        success: 'bg-green-600/90 text-white',
        error: 'bg-red-600/90 text-white',
        info: 'bg-win-accent/90 text-white'
    };

    toast.classList.add(...colors[type].split(' '));
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 3000);
}

// --- Chat de Produção (Host) ---
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const sendChatBtn = document.getElementById('send-chat');

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (text && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'chat',
            roomId: roomName,
            name: 'Produção (Host)',
            text: text,
            timestamp: Date.now()
        }));
        chatInput.value = '';
    }
}

if (sendChatBtn) sendChatBtn.onclick = sendChatMessage;
if (chatInput) chatInput.onkeypress = (e) => { if (e.key === 'Enter') sendChatMessage(); };

function appendChatMessage(name, text, time) {
    if (!chatMessages) return;
    const msg = document.createElement('div');
    const isMe = name === 'Produção (Host)';
    msg.className = `flex flex-col max-w-[85%] ${isMe ? 'self-end items-end' : 'self-start items-start'}`;

    const timeStr = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    msg.innerHTML = `
        <span class="text-[10px] text-gray-400 mb-0.5 px-1">${name} • ${timeStr}</span>
        <div class="px-3 py-1.5 rounded-lg shadow-md ${isMe ? 'bg-win-accent text-white rounded-br-none' : 'bg-win-surface border border-win-border text-gray-200 rounded-bl-none'}">
            ${text}
        </div>
    `;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// --- Lyncro Cam (QR Code Companion) para o Host ---
const openMobileBtn = document.getElementById('openMobileCam');
const qrModal = document.getElementById('qr-modal');
const closeQrModal = document.getElementById('close-qr-modal');
const qrContainer = document.getElementById('qrcode-container');
let qrcodeInstance = null;

if (openMobileBtn && qrModal && closeQrModal && qrContainer) {
    openMobileBtn.onclick = () => {
        qrModal.classList.remove('hidden');
        if (!qrcodeInstance && myId) {
            // Gerar URL de Convidado com o parâmetro companionOf apontando para o Host
            const baseUrl = window.location.origin;
            const qrUrl = new URL(`${baseUrl}/guest.html`);
            qrUrl.searchParams.set('room', roomName);
            qrUrl.searchParams.set('companionOf', myId);
            qrUrl.searchParams.set('name', 'Lyncro Cam (Host)');

            qrcodeInstance = new QRCode(qrContainer, {
                text: qrUrl.toString(),
                width: 200,
                height: 200,
                colorDark: "#000000",
                colorLight: "#ffffff",
                correctLevel: QRCode.CorrectLevel.H
            });
        } else if (!myId) {
            showToast("Aguarde a conexão com o servidor...", "error");
            qrModal.classList.add('hidden');
        }
    };

    closeQrModal.onclick = () => {
        qrModal.classList.add('hidden');
    };
}
