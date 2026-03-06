const urlParams = new URLSearchParams(window.location.search);
const roomName = urlParams.get('room') || 'default';
const userName = urlParams.get('name') || 'Convidado';
const companionOf = urlParams.get('companionOf') || null;

let localStream;
let rtcClient;
let ws;
let myId;
let isMicOn = companionOf ? false : true; // Companion começa sempre mudo
let isVideoOn = true;
let audioContext;
let analyser;

const preVideo = document.getElementById('pre-localVideo');
const mainVideo = document.getElementById('localVideo');
const tallyIndicator = document.getElementById('tally-indicator');
const onAirMsg = document.getElementById('on-air-msg');
const joinBtn = document.getElementById('join-btn');
const precallScreen = document.getElementById('precall-screen');
const callScreen = document.getElementById('call-screen');
const audioBar = document.getElementById('audio-bar');

const savedUserName = localStorage.getItem('lyncro_user_name');
const finalUserName = savedUserName || userName;
document.getElementById('display-name').textContent = finalUserName;

// 1. Início do Fluxo de Pré-chamada
async function startPreCall() {
    try {
        const qualitySelect = document.getElementById('video-quality');
        const savedQuality = localStorage.getItem('lyncro_video_quality');
        if (savedQuality && qualitySelect) qualitySelect.value = savedQuality;

        const heightQoS = qualitySelect ? parseInt(qualitySelect.value) : 720;
        const widthQoS = Math.round(heightQoS * (16 / 9));

        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: widthQoS }, height: { ideal: heightQoS }, facingMode: companionOf ? "environment" : "user" },
            audio: true
        });

        if (!isMicOn && localStream.getAudioTracks().length > 0) {
            localStream.getAudioTracks()[0].enabled = false;
        }

        preVideo.srcObject = localStream;
        setupAudioMonitor(localStream);
    } catch (err) {
        console.error('Precall error (Mídia bloqueada?):', err);
        // Não mostramos alert aqui para não bloquear a UI
        // O erro de contexto inseguro (HTTP) no iPhone é capturado aqui
    }
}

const qualitySelectEl = document.getElementById('video-quality');
if (qualitySelectEl) {
    qualitySelectEl.addEventListener('change', () => {
        const val = qualitySelectEl.value;
        localStorage.setItem('lyncro_video_quality', val);
        const label = val === '720' ? '720p HD' : val === '480' ? '480p SD' : '360p LQ';
        const display = document.getElementById('quality-display-name');
        if (display) display.innerText = label;

        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
        }
        startPreCall();
    });
}

window.selectQuality = (val, label) => {
    const el = document.getElementById('video-quality');
    if (el) {
        el.value = val;
        el.dispatchEvent(new Event('change'));
    }
    const menu = document.getElementById('quality-select-menu');
    if (menu) menu.style.display = 'none';
};

// Dropdowns Customizados (Toggle)
function setupCustomDropdowns() {
    const list = [
        { trigger: 'cam-select-trigger', menu: 'cam-select-menu' },
        { trigger: 'mic-select-trigger', menu: 'mic-select-menu' },
        { trigger: 'quality-select-trigger', menu: 'quality-select-menu' }
    ];

    list.forEach(item => {
        const trigger = document.getElementById(item.trigger);
        const menu = document.getElementById(item.menu);
        if (trigger && menu) {
            trigger.onclick = (e) => {
                e.stopPropagation();
                // Close others
                list.forEach(other => {
                    if (other.menu !== item.menu) {
                        const m = document.getElementById(other.menu);
                        if (m) m.style.display = 'none';
                    }
                });
                const isHidden = menu.style.display === 'none' || menu.style.display === '';
                menu.style.display = isHidden ? 'block' : 'none';
            };
        }
    });

    document.addEventListener('click', () => {
        list.forEach(item => {
            const m = document.getElementById(item.menu);
            if (m) m.style.display = 'none';
        });
    });
}

async function enumeratePreCallDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const camMenu = document.getElementById('cam-select-menu');
        const micMenu = document.getElementById('mic-select-menu');
        const camDisplay = document.getElementById('cam-display-name');
        const micDisplay = document.getElementById('mic-display-name');

        if (!camMenu || !micMenu) return;

        camMenu.innerHTML = '';
        micMenu.innerHTML = '';

        let currentCamId = localStream ? (localStream.getVideoTracks()[0]?.getSettings().deviceId || '') : '';
        let currentMicId = localStream ? (localStream.getAudioTracks()[0]?.getSettings().deviceId || '') : '';

        devices.forEach(device => {
            if (device.kind === 'videoinput') {
                const isSelected = device.deviceId === currentCamId;
                if (isSelected && camDisplay) camDisplay.innerText = device.label || 'Câmera';
                camMenu.innerHTML += `
                    <div class="custom-select-option ${isSelected ? 'text-win-accent font-bold' : ''}" 
                         onclick="switchDevice('${device.deviceId}', 'video')">
                        ${device.label || 'V-Cam ' + (camMenu.children.length + 1)}
                    </div>`;
            } else if (device.kind === 'audioinput') {
                const isSelected = device.deviceId === currentMicId;
                if (isSelected && micDisplay) micDisplay.innerText = device.label || 'Microfone';
                micMenu.innerHTML += `
                    <div class="custom-select-option ${isSelected ? 'text-win-accent font-bold' : ''}" 
                         onclick="switchDevice('${device.deviceId}', 'audio')">
                        ${device.label || 'A-Mic ' + (micMenu.children.length + 1)}
                    </div>`;
            }
        });
    } catch (e) {
        console.error('Erro ao enumerar dispositivos no pré-chamada:', e);
    }
}

function setupAudioMonitor(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    source.connect(analyser);
    analyser.fftSize = 256;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function updateMeter() {
        if (!precallScreen.classList.contains('hidden')) {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
            const average = sum / bufferLength;
            audioBar.style.width = Math.min(100, average * 2) + '%';
            requestAnimationFrame(updateMeter);
        }
    }
    updateMeter();
}

// 2. Lógica de Entrada
joinBtn.onclick = () => {
    console.log('Botão Entrar clicado');
    precallScreen.classList.add('hidden');
    // Em vez de exibir a chamada e o vídeo local direto, mostramos a tela de espera.
    // E só ligamos a conexão de Websocket por enquanto.
    const waitingScreen = document.getElementById('waiting-screen');
    if (waitingScreen) {
        waitingScreen.classList.remove('hidden');
        const waitTitle = document.querySelector('#waiting-screen h2');
        if (waitTitle) waitTitle.textContent = 'Iniciando Conexão...';
    }

    // O video main só recebe a srcObject depois que a promisse de aceitação ('admission-result') voltar
    if (audioContext) audioContext.close();
    setupWebSocket();
};

function handleRemoteTrack(targetId, stream) {
    console.log('Receiving remote track from:', targetId);
    // No Guest side, só esperamos áudio dele (o Mix-Minus/Program do Host)
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
        console.log('Receiving Return Audio (Mix-Minus) from Host');
        // Criar ou reusar elemento de áudio
        let returnAudio = document.getElementById('return-audio-element');
        if (!returnAudio) {
            returnAudio = document.createElement('audio');
            returnAudio.id = 'return-audio-element';
            returnAudio.autoplay = true;
            document.body.appendChild(returnAudio);
        }
        returnAudio.srcObject = stream;
        returnAudio.play().catch(e => console.error('Falha ao tocar áudio de retorno:', e));
    }
}

function handleDataMessage(targetId, data) {
    if (data.type === 'file-progress') {
        const progressEl = document.getElementById('file-progress-overlay');
        if (progressEl) {
            progressEl.classList.remove('hidden');
            progressEl.querySelector('.progress-fill').style.width = `${data.progress}%`;
            progressEl.querySelector('.progress-text').textContent = `Recebendo arquivo: ${data.progress.toFixed(0)}%`;
        }
    } else if (data.type === 'file') {
        const url = URL.createObjectURL(data.blob);
        appendChatMessage('Produção', `Arquivo enviado: <a href="${url}" download="${data.fileName}" class="text-win-accent underline font-bold">${data.fileName}</a>`, Date.now());

        const progressEl = document.getElementById('file-progress-overlay');
        if (progressEl) progressEl.classList.add('hidden');

        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    }
}

function handleIceCandidate(targetId, candidate) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ice-candidate', roomId: roomName, to: targetId, candidate }));
    }
}

function updateOverlay(action, name, title) {
    const overlay = document.getElementById('lower-third');
    const nameEl = document.getElementById('ov-display-name');
    const titleEl = document.getElementById('ov-display-title');

    if (!overlay || !nameEl || !titleEl) return;

    if (action === 'show') {
        nameEl.textContent = name;
        titleEl.textContent = title;
        overlay.classList.remove('overlay-animated-out');
        overlay.classList.add('overlay-animated-in');
        overlay.style.opacity = '1';
    } else {
        overlay.classList.remove('overlay-animated-in');
        overlay.classList.add('overlay-animated-out');
        // Oculta após a animação
        setTimeout(() => {
            if (overlay.classList.contains('overlay-animated-out')) {
                overlay.style.opacity = '0';
            }
        }, 400);
    }
}

function setupWebSocket() {
    let wsUrl;

    // Priorizar configuração global se disponível e preenchida
    if (window.LYNCRO_CONFIG && window.LYNCRO_CONFIG.SIGNALING_URL) {
        wsUrl = window.LYNCRO_CONFIG.SIGNALING_URL;
    } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        wsUrl = `${protocol}//${host}`;
    }

    console.log(`Conectando ao servidor Lyncro em: ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('Conectado ao servidor de sinalização');

        // Feedback visual na tela de espera
        const waitTitle = document.querySelector('#waiting-screen h2');
        if (waitTitle) waitTitle.innerHTML = 'Conectado! <br><span class="text-sm font-normal text-gray-400">Aguardando aprovação do produtor...</span>';

        rtcClient = new WebRTCClient(userName, handleRemoteTrack, handleIceCandidate, null, null, handleDataMessage);
        rtcClient.setLocalStream(localStream);

        const passwordEl = document.getElementById('room-password');
        const password = passwordEl ? passwordEl.value.trim() : null;

        const joinPayload = {
            type: 'join',
            roomId: roomName,
            participant: { name: userName, role: 'guest', companionOf: companionOf }
        };

        if (password) joinPayload.password = password;

        ws.send(JSON.stringify(joinPayload));
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
                const me = data.participants.find(p => p.name === userName);
                if (me) updateTally(me.tallyState);

                // Só inicia conexão passiva se eu já estiver 'accepted'
                if (me && me.status === 'accepted') {
                    data.participants.forEach(p => {
                        if (p.role === 'observer') return; // Ignorar observadores (OBS)

                        // Inicia conexão ativa se a pessoa tbm for accepted
                        if (p.status === 'accepted' && p.id !== myId && !rtcClient.peers.has(p.id) && myId && myId < p.id) {
                            console.log('Initiating connection to accepted participant:', p.id);
                            initiateConnection(p.id);
                        }
                    });
                }
                break;
            case 'admission-result':
                console.log('Resultado da admissão recebido:', data.status);
                const waitingScreen = document.getElementById('waiting-screen');
                const callScrn = document.getElementById('call-screen');

                if (data.status === 'accepted') {
                    if (waitingScreen) waitingScreen.classList.add('hidden');
                    if (callScrn) callScrn.classList.remove('hidden');

                    if (localStream) {
                        mainVideo.srcObject = localStream;
                    } else {
                        console.warn('Sem localStream para exibir no aceite.');
                        // Mostrar um aviso dentro do call screen se não tiver câmera
                        const videoContainer = mainVideo.parentElement;
                        if (videoContainer && !document.getElementById('no-cam-warning')) {
                            const warn = document.createElement('div');
                            warn.id = 'no-cam-warning';
                            warn.className = "absolute inset-0 flex flex-col items-center justify-center bg-black text-center p-6";
                            warn.innerHTML = `
                                <i class="ph ph-camera-slash text-4xl text-red-500 mb-2"></i>
                                <span class="text-sm font-bold">Câmera não permitida</span>
                                <span class="text-[10px] text-gray-400 mt-2">O iOS bloqueia a câmera via HTTP.<br>Use HTTPS ou Túnel para habilitar.</span>
                            `;
                            videoContainer.appendChild(warn);
                        }
                    }
                    console.log('Fui aceito! Renderizando Call Screen e liberando Ice Candidates.');
                } else if (data.status === 'rejected') {
                    alert('Sua entrada não foi aprovada pelo Produtor.');
                    window.location.reload();
                }
                break;
            case 'offer':
                console.log('Receiving offer from:', data.from);
                try {
                    const answer = await rtcClient.handleOffer(data.from, data.offer);
                    ws.send(JSON.stringify({ type: 'answer', roomId: roomName, to: data.from, answer }));
                } catch (e) {
                    console.error('Error handling offer:', e);
                }
                break;
            case 'answer':
                await rtcClient.handleAnswer(data.from, data.answer);
                break;
            case 'ice-candidate':
                await rtcClient.handleCandidate(data.from, data.candidate);
                break;
            case 'media-control':
                if (data.mediaType === 'audio') {
                    setMicEnabled(!isMicOn);
                } else if (data.mediaType === 'video') {
                    setVideoEnabled(!isVideoOn);
                }
                break;
            case 'overlay-control':
                console.log('Overlay control received:', data);
                updateOverlay(data.action, data.name, data.title);
                break;
            case 'chat':
                appendChatMessage(data.name, data.text, data.timestamp);
                const cp = document.getElementById('chat-panel');
                if (cp && cp.classList.contains('hidden') && data.name !== userName) {
                    const badge = document.getElementById('chat-badge');
                    if (badge) badge.classList.remove('hidden');
                    if (navigator.vibrate) navigator.vibrate(50);
                }
                break;
            case 'error':
                console.error('SERVER ERROR:', data.message);
                alert(data.message);
                // Se o erro for senha, voltamos para a tela de pré-chamada
                if (data.message.includes('Senha')) {
                    const waitingScreen = document.getElementById('waiting-screen');
                    const precallScreen = document.getElementById('precall-screen');
                    if (waitingScreen) waitingScreen.classList.add('hidden');
                    if (precallScreen) precallScreen.classList.remove('hidden');
                }
                break;
        }
    };

    ws.onerror = (err) => {
        console.error('Erro no WebSocket:', err);
        const waitTitle = document.querySelector('#waiting-screen h2');
        if (waitTitle) waitTitle.innerHTML = '<span class="text-red-500">Erro de Conexão</span> <br><span class="text-xs font-normal text-gray-400">O celular não conseguiu falar com o servidor. Verifique o Firewall do PC.</span>';
    };

    ws.onclose = () => {
        console.warn('Conexão perdida. Tentando reconectar em 3s...');
        const waitTitle = document.querySelector('#waiting-screen h2');
        if (waitTitle) waitTitle.innerHTML = '<span class="text-red-500">Conexão Perdida</span> <br><span class="text-sm font-normal text-gray-400">Tentando reconectar...</span>';
        setTimeout(setupWebSocket, 3000);
    };
}

function updateTally(tallyState) {
    const tallyIndicator = document.getElementById('tally-indicator');
    const onAirMsg = document.getElementById('on-air-msg');

    if (!tallyIndicator || !onAirMsg) return;

    tallyIndicator.className = "absolute inset-0 pointer-events-none z-50 transition-all duration-300";
    onAirMsg.className = "fixed top-8 left-1/2 -translate-x-1/2 text-white px-4 py-1.5 rounded-full text-xs font-bold z-[60] shadow-2xl uppercase tracking-widest hidden";

    if (tallyState === 'program') {
        tallyIndicator.classList.add('tally-program');
        onAirMsg.classList.remove('hidden');
        onAirMsg.classList.add('bg-red-600', 'animate-bounce');
        onAirMsg.textContent = "VOCÊ ESTÁ NO AR";
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    } else if (tallyState === 'preview') {
        tallyIndicator.classList.add('tally-preview');
        onAirMsg.classList.remove('hidden');
        onAirMsg.classList.add('bg-green-600');
        onAirMsg.textContent = "PREPARE-SE (PREVIEW)";
        if (navigator.vibrate) navigator.vibrate(50);
    }
}

async function initiateConnection(targetId) {
    const offer = await rtcClient.createOffer(targetId);
    ws.send(JSON.stringify({ type: 'offer', roomId: roomName, to: targetId, offer }));
}

function handleRemoteTrack() { /* O convidado mobile foca apenas no host/própria câmera geralmente */ }

function handleIceCandidate(targetId, candidate) {
    ws.send(JSON.stringify({ type: 'ice-candidate', roomId: roomName, to: targetId, candidate }));
}

// 3. Controles de Mídia
function broadcastMediaStatus() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'media-status-change',
            roomId: roomName,
            audioMuted: !isMicOn,
            videoMuted: !isVideoOn
        }));
    }
}

function setMicEnabled(enabled) {
    isMicOn = enabled;
    if (localStream && localStream.getAudioTracks().length > 0) {
        localStream.getAudioTracks()[0].enabled = isMicOn;
    }
    document.getElementById('toggleMic').classList.toggle('bg-red-600/20', !isMicOn);
    document.getElementById('toggleMic').classList.toggle('text-red-500', !isMicOn);
    document.getElementById('toggleMic').innerHTML = `<i class="ph ${isMicOn ? 'ph-microphone' : 'ph-microphone-slash'} text-2xl"></i>`;
    broadcastMediaStatus();
}

function setVideoEnabled(enabled) {
    isVideoOn = enabled;
    if (localStream && localStream.getVideoTracks().length > 0) {
        localStream.getVideoTracks()[0].enabled = isVideoOn;
    }
    const btn = document.getElementById('toggleVideo');
    btn.classList.toggle('bg-red-600/20', !isVideoOn);
    btn.classList.toggle('text-red-500', !isVideoOn);
    btn.innerHTML = `<i class="ph ${isVideoOn ? 'ph-video-camera' : 'ph-video-camera-slash'} text-2xl"></i>`;
    broadcastMediaStatus();
}

document.getElementById('toggleMic').onclick = () => setMicEnabled(!isMicOn);
document.getElementById('toggleVideo').onclick = () => setVideoEnabled(!isVideoOn);

document.getElementById('switchCamera').onclick = async () => {
    const tracks = localStream.getTracks();
    tracks.forEach(t => t.stop());

    // Alternar entre user e environment (frente/trás) no mobile
    const currentMode = localStream.getVideoTracks()[0].getSettings().facingMode;
    const newMode = currentMode === 'user' ? 'environment' : 'user';

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: newMode },
            audio: isMicOn
        });
        mainVideo.srcObject = localStream;
        rtcClient.setLocalStream(localStream);
        // Ao invés de renegociar (initiateConnection), melhor usar replaceTrack se possível:
        if (rtcClient) {
            await rtcClient.replaceTrack(localStream.getVideoTracks()[0]);
            await rtcClient.replaceTrack(localStream.getAudioTracks()[0]);
        }
    } catch (e) {
        console.error('Camera switch failed:', e);
    }
};

document.getElementById('leaveRoom').onclick = () => window.location.href = 'index.html';

// 3.5. Compartilhamento de Tela (Screen Share)
let isScreenSharing = false;
let camTrackBackup = null;

document.getElementById('shareScreen').onclick = async () => {
    const btn = document.getElementById('shareScreen');
    if (!isScreenSharing) {
        try {
            console.log('Iniciando compartilhamento de tela...');
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: "always" },
                audio: false
            });
            const screenVideoTrack = screenStream.getVideoTracks()[0];

            // Backup da track de vídeo atual
            camTrackBackup = localStream.getVideoTracks()[0];

            // Ouvir quando o usuário para o compartilhamento via barra do navegador
            screenVideoTrack.onended = () => {
                console.log('Compartilhamento de tela encerrado pelo navegador.');
                stopScreenShare();
            };

            // Trocar no motor WebRTC
            if (rtcClient) {
                await rtcClient.replaceTrack(screenVideoTrack);
            }

            // Atualizar Stream local e Preview
            localStream.removeTrack(camTrackBackup);
            localStream.addTrack(screenVideoTrack);

            // Não paramos a câmera completamente para permitir volta rápida se possível, 
            // mas desativamos para economizar energia/privacidade
            camTrackBackup.enabled = false;

            mainVideo.srcObject = localStream;
            mainVideo.style.objectFit = 'contain';
            mainVideo.classList.add('bg-black/90');

            btn.classList.replace('bg-win-surface/80', 'bg-win-accent');
            btn.classList.add('text-white');
            isScreenSharing = true;

            // Notificar sistema sobre mudança de estado (opcional)
            broadcastMediaStatus();
        } catch (e) {
            console.error('Erro ao compartilhar tela:', e);
        }
    } else {
        stopScreenShare();
    }
};

async function stopScreenShare() {
    if (!isScreenSharing) return;

    console.log('Voltando para a câmera...');
    try {
        const screenTrack = localStream.getVideoTracks()[0];

        // Se temos o backup e ele ainda está "vivo"
        if (camTrackBackup && camTrackBackup.readyState === 'live') {
            camTrackBackup.enabled = isVideoOn; // Respeita o botão de mute de vídeo

            localStream.removeTrack(screenTrack);
            localStream.addTrack(camTrackBackup);

            if (rtcClient) {
                await rtcClient.replaceTrack(camTrackBackup);
            }
        } else {
            // Se o backup morreu ou não existe, pegamos a câmera de novo
            const camStream = await navigator.mediaDevices.getUserMedia({
                video: { height: { ideal: 720 } },
                audio: false
            });
            const newCamTrack = camStream.getVideoTracks()[0];

            localStream.removeTrack(screenTrack);
            localStream.addTrack(newCamTrack);

            if (rtcClient) {
                await rtcClient.replaceTrack(newCamTrack);
            }
        }

        screenTrack.stop(); // Encerra a captura de tela

        mainVideo.srcObject = localStream;
        mainVideo.style.objectFit = 'cover';
        mainVideo.classList.remove('bg-black/90');

        const btn = document.getElementById('shareScreen');
        btn.classList.replace('bg-win-accent', 'bg-win-surface/80');
        btn.classList.remove('text-white');
        isScreenSharing = false;

        broadcastMediaStatus();
    } catch (e) {
        console.error('Erro ao retornar para a câmera:', e);
        isScreenSharing = false; // Reset de segurança
    }
}

// 4. Seleção Avançada de Dispositivos (Chevrons UI)
const micMenu = document.getElementById('mic-menu');
const camMenu = document.getElementById('cam-menu');

document.getElementById('btn-mic-menu').onclick = async (e) => {
    e.stopPropagation();
    camMenu.classList.add('hidden');
    micMenu.classList.toggle('hidden');
    if (!micMenu.classList.contains('hidden')) await loadDevices();
};

document.getElementById('btn-cam-menu').onclick = async (e) => {
    e.stopPropagation();
    micMenu.classList.add('hidden');
    camMenu.classList.toggle('hidden');
    if (!camMenu.classList.contains('hidden')) await loadDevices();
};

document.addEventListener('click', () => {
    micMenu.classList.add('hidden');
    camMenu.classList.add('hidden');
});

const mediaDropBtn = document.getElementById('mediaDrop');
const fileInput = document.getElementById('fileInput');

if (mediaDropBtn && fileInput) {
    mediaDropBtn.onclick = () => fileInput.click();
    fileInput.onchange = async (e) => {
        const file = e.target.result || e.target.files[0];
        if (!file) return;

        try {
            // Mostrar overlay de progresso
            const progressEl = document.getElementById('file-progress-overlay');
            if (progressEl) {
                progressEl.classList.remove('hidden');
                progressEl.querySelector('.progress-fill').style.width = '0%';
                progressEl.querySelector('.progress-text').textContent = `Enviando: ${file.name}`;
            }

            // Enviar para os peers conectados
            const peers = Array.from(rtcClient.peers.keys());
            if (peers.length === 0) {
                throw new Error('Ninguém conectado para receber o arquivo.');
            }

            for (const targetId of peers) {
                await rtcClient.sendFile(targetId, file, (progress) => {
                    if (progressEl) {
                        progressEl.querySelector('.progress-fill').style.width = `${progress}%`;
                        progressEl.querySelector('.progress-text').textContent = `Enviando: ${progress.toFixed(0)}%`;
                    }
                });
            }

            if (progressEl) progressEl.classList.add('hidden');
            appendChatMessage('Sistema P2P', `Arquivo enviado com sucesso: ${file.name}`, Date.now());
            fileInput.value = ''; // Reset
        } catch (err) {
            console.error('Falha no Media Drop:', err);
            alert(`Erro no P2P: ${err.message || 'Falha desconhecida'}`);
            const progressEl = document.getElementById('file-progress-overlay');
            if (progressEl) progressEl.classList.add('hidden');
            fileInput.value = '';
        }
    };
}

async function loadDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const micList = document.getElementById('mic-list');
        const camList = document.getElementById('cam-list');

        micList.innerHTML = '';
        camList.innerHTML = '';

        // Descobrir quais estão ativos agora para marcar
        let currentAudioId = '';
        let currentVideoId = '';
        if (localStream) {
            const audioTracks = localStream.getAudioTracks();
            if (audioTracks.length > 0) currentAudioId = audioTracks[0].getSettings().deviceId;
            const videoTracks = localStream.getVideoTracks();
            if (videoTracks.length > 0) currentVideoId = videoTracks[0].getSettings().deviceId;
        }

        devices.forEach(device => {
            if (device.kind === 'audioinput') {
                const isSelected = device.deviceId === currentAudioId;
                micList.innerHTML += `<button onclick="switchDevice('${device.deviceId}', 'audio')" class="text-left w-full px-2 py-1.5 hover:bg-win-accent rounded transition-colors truncate ${isSelected ? 'text-win-accent font-bold bg-white/5' : 'text-gray-300'}">${device.label || 'Microfone ' + (micList.children.length + 1)}</button>`;
            } else if (device.kind === 'videoinput') {
                const isSelected = device.deviceId === currentVideoId;
                camList.innerHTML += `<button onclick="switchDevice('${device.deviceId}', 'video')" class="text-left w-full px-2 py-1.5 hover:bg-win-accent rounded transition-colors truncate ${isSelected ? 'text-win-accent font-bold bg-white/5' : 'text-gray-300'}">${device.label || 'Câmera ' + (camList.children.length + 1)}</button>`;
            }
        });
    } catch (e) {
        console.error('Error listing devices:', e);
    }
}

window.switchDevice = async (deviceId, kind) => {
    micMenu.classList.add('hidden');
    camMenu.classList.add('hidden');

    try {
        const constraints = {
            audio: kind === 'audio' ? { deviceId: { exact: deviceId } } : false,
            video: kind === 'video' ? { deviceId: { exact: deviceId } } : false
        };

        const newStream = await navigator.mediaDevices.getUserMedia(constraints);
        const newTrack = kind === 'video' ? newStream.getVideoTracks()[0] : newStream.getAudioTracks()[0];

        // Atualiza a flag de Mute local para o novo track
        if (kind === 'audio') newTrack.enabled = isMicOn;
        if (kind === 'video') newTrack.enabled = isVideoOn;

        // Troca no motor RTCPeerConnection para quem está assistindo
        if (rtcClient) {
            await rtcClient.replaceTrack(newTrack);
        }

        // Troca no LocalStream mantendo a outra mídia intacta
        const oldTrack = kind === 'video' ? localStream.getVideoTracks()[0] : localStream.getAudioTracks()[0];
        if (oldTrack) {
            localStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        localStream.addTrack(newTrack);

        // Atualiza vídeo local (se for câmera)
        if (kind === 'video') {
            if (mainVideo) mainVideo.srcObject = localStream;
            if (preVideo) preVideo.srcObject = localStream;
        }

        // Atualizar lista de dispositivos para refletir a nova seleção no UI customizado
        await enumeratePreCallDevices();

        console.log(`Dispositivo de ${kind} trocado com sucesso para ${deviceId}`);
    } catch (e) {
        console.error(`Erro ao trocar dispositivo de ${kind}:`, e);
        alert('Erro ao trocar de câmera/microfone.');
    }
};

if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
    const accessMsg = document.getElementById('access-msg');
    if (accessMsg) {
        accessMsg.innerHTML = '<b class="text-red-500">⚠️ iPhone detectado via IP:</b> A câmera do iOS só funciona via HTTPS. <br>Use o modo Túnel ou HTTPS para habilitar a câmera.';
    }
}

// Inicialização
setupCustomDropdowns();
startPreCall().then(() => {
    enumeratePreCallDevices();

    // Scroll automático para mobile para focar nos campos/botão
    if (window.innerWidth < 768) {
        setTimeout(() => {
            const btn = document.getElementById('join-btn');
            if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }, 1000);
    }
});

// 5. Chat Privado (Convidado)
const chatPanel = document.getElementById('chat-panel');
const toggleChatBtn = document.getElementById('toggleChat');
const closeChatBtn = document.getElementById('closeChat');
const chatBadge = document.getElementById('chat-badge');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const sendChatBtn = document.getElementById('send-chat');

if (toggleChatBtn) {
    toggleChatBtn.onclick = () => {
        chatPanel.classList.toggle('hidden');
        if (chatBadge) chatBadge.classList.add('hidden');
    };
}
if (closeChatBtn) {
    closeChatBtn.onclick = () => chatPanel.classList.add('hidden');
}

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (text && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'chat',
            roomId: roomName,
            name: userName,
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
    const isMe = name === userName;
    msg.className = `flex flex-col max-w-[85%] ${isMe ? 'self-end items-end' : 'self-start items-start'}`;

    const timeStr = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    msg.innerHTML = `
        <span class="text-[10px] text-gray-400 mb-0.5 px-1">${name} • ${timeStr}</span>
        <div class="px-3 py-1.5 rounded-lg shadow-md ${isMe ? 'bg-win-accent text-white rounded-br-none' : 'bg-win-surface border border-win-border text-gray-200 rounded-bl-none'} text-sm">
            ${text}
        </div>
    `;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// --- Câmera Secundária (QR Code Companion) ---
const openMobileBtn = document.getElementById('openMobileCam');
const qrModal = document.getElementById('qr-modal');
const closeQrModal = document.getElementById('close-qr-modal');
const qrContainer = document.getElementById('qrcode-container');
let qrcodeInstance = null;

if (openMobileBtn && qrModal && closeQrModal && qrContainer) {
    openMobileBtn.addEventListener('click', () => {
        qrModal.classList.remove('hidden');
        if (!qrcodeInstance && myId) {
            // Gerar URL mágica
            const qrUrl = new URL(window.location.href);
            qrUrl.searchParams.set('companionOf', myId);
            // Evitar problemas de loop adicionando sufixo
            qrUrl.searchParams.set('name', userName + ' (Cam 2)');

            qrcodeInstance = new QRCode(qrContainer, {
                text: qrUrl.toString(),
                width: 200,
                height: 200,
                colorDark: "#000000",
                colorLight: "#ffffff",
                correctLevel: QRCode.CorrectLevel.H
            });
        } else if (!myId) {
            alert("Aguarde a conexão com o servidor ser estabelecida para gerar o QR Code.");
            qrModal.classList.add('hidden');
        }
    });

    closeQrModal.addEventListener('click', () => {
        qrModal.classList.add('hidden');
    });
}

// Se EU SOU o celular da Câmera Secundária, escondo coisas desnecessárias para poupar processamento
if (companionOf) {
    if (openMobileBtn) openMobileBtn.classList.add('hidden');
    const toggleChat = document.getElementById('toggleChat');
    const shareScreen = document.getElementById('shareScreen');
    if (toggleChat) toggleChat.classList.add('hidden');
    if (shareScreen) shareScreen.classList.add('hidden');

    // Altera mensagens pra modo Companion Cego
    document.querySelector('#precall-screen h1').textContent = "Câmera Secundária";
    document.querySelector('#precall-screen p').textContent = "O áudio local será mutado para evitar eco";
    document.getElementById('display-name').textContent = "Transmissão Companion Ativa";
    document.getElementById('display-name').classList.add('text-green-400');

    // Muta auto e remove option pra enviar
    isMicOn = false;
    const micGroup = document.getElementById('mic-group');
    if (micGroup) micGroup.classList.add('hidden');
}
