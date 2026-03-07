const urlParams = new URLSearchParams(window.location.search);
const roomName = urlParams.get('room') || 'default';
let targetParticipantId = urlParams.get('participant');

let rtcClient;
let ws;
let myId;
const remoteVideo = document.getElementById('remoteVideo');

function init() {
    if (!targetParticipantId) {
        console.error('[CleanFeed] ERRO: Nenhum ID de participante fornecido na URL.');
        return;
    }
    setupWebSocket();
}

async function setupWebSocket() {
    // Aguardar config estar pronta antes de ler SIGNALING_URL (evita race condition)
    if (window.LYNCRO_CONFIG_READY) await window.LYNCRO_CONFIG_READY;

    console.log('Clean Feed: Connecting to signal server...');
    let wsUrl;

    if (window.LYNCRO_CONFIG && window.LYNCRO_CONFIG.SIGNALING_URL) {
        wsUrl = window.LYNCRO_CONFIG.SIGNALING_URL;
    } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${window.location.host}`;
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log(`Clean Feed: Joined room ${roomName} waiting for ${targetParticipantId}`);
        // O Clean Feed atua como um participante "espectador" (role: observer)
        rtcClient = new WebRTCClient(`OBS-${targetParticipantId}`, handleRemoteTrack, handleIceCandidate);

        ws.send(JSON.stringify({
            type: 'join',
            roomId: roomName,
            participant: {
                name: `OBS-${targetParticipantId}`,
                role: 'observer'
            }
        }));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case 'init-network':
                myId = data.yourId;
                if (rtcClient) rtcClient.updateConfig(data.iceServers);
                console.log(`Minha ID definida: ${myId}. IceServers atualizados.`);
                break;
            case 'participant-update':
                // Tenta achar o alvo específico OU o primeiro convidado disponível se o alvo falhar
                let target = data.participants.find(p => p.id === targetParticipantId);

                if (!target && data.participants.length > 0) {
                    // Fallback: pega o primeiro que não seja o próprio OBS e não seja o host
                    target = data.participants.find(p => p.role === 'guest');
                    if (target) {
                        console.log(`Alvo original não encontrado. Atualizando alvo para fallback: ${target.id}`);
                        targetParticipantId = target.id;
                    }
                }

                if (target) {
                    if (!rtcClient.peers.has(target.id)) {
                        console.log(`Alvo encontrado na sala: ${target.id}. Iniciando conexão...`);
                        initiateConnection(target.id);
                    }
                } else {
                    console.log('Nenhum alvo ou convidado disponível na sala.');
                }
                break;
            case 'offer':
                if (data.from === targetParticipantId) {
                    console.log('Recebeu REQUIREMENT (offer) do alvo.');
                    const answer = await rtcClient.handleOffer(data.from, data.offer);
                    ws.send(JSON.stringify({ type: 'answer', roomId: roomName, to: data.from, answer }));
                    console.log('Enviou ANSWER.');
                }
                break;
            case 'answer':
                if (data.from === targetParticipantId || rtcClient.peers.has(data.from)) {
                    console.log('Recebeu ANSWER do alvo.');
                    await rtcClient.handleAnswer(data.from, data.answer);
                }
                break;
            case 'ice-candidate':
                if (data.from === targetParticipantId || rtcClient.peers.has(data.from)) {
                    await rtcClient.handleCandidate(data.from, data.candidate);
                }
                break;
            case 'overlay-control':
                console.log('[CleanFeed] Overlay control received:', data);
                updateOverlay(data.action, data.name, data.title);
                break;
        }
    };
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
        setTimeout(() => {
            if (overlay.classList.contains('overlay-animated-out')) {
                overlay.style.opacity = '0';
            }
        }, 400);
    }
}

async function initiateConnection(targetId) {
    const offer = await rtcClient.createOffer(targetId);
    ws.send(JSON.stringify({ type: 'offer', roomId: roomName, to: targetId, offer }));
}

const targetType = urlParams.get('type') || 'camera'; // 'camera' ou 'screen'
let videoTrackCount = 0;

function handleRemoteTrack(targetId, stream, track) {
    if (track.kind !== 'video') return;

    videoTrackCount++;
    console.log(`Receiving remote track ${videoTrackCount} (${track.kind}) for clean feed: ${targetId}`);

    const statusEl = document.getElementById('status');

    if (targetId === targetParticipantId) {
        // Lógica de seleção: 
        // Se type=camera, pegamos o primeiro rastro de vídeo.
        // Se type=screen, pegamos o segundo rastro de vídeo.
        const isScreen = targetType === 'screen';
        const shouldShowThisTrack = (isScreen && videoTrackCount === 2) || (!isScreen && videoTrackCount === 1);

        if (!shouldShowThisTrack) {
            console.log(`Pulando rastro ${videoTrackCount} (Alvo é ${targetType})`);
            return;
        }

        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.textContent = 'CONECTADO! Iniciando vídeo...';
            statusEl.style.background = 'green';
        }

        // Criamos um novo stream apenas com este track para garantir isolamento
        const singleStream = new MediaStream([track]);
        remoteVideo.srcObject = singleStream;

        remoteVideo.onloadedmetadata = () => {
            remoteVideo.play()
                .then(() => {
                    console.log('Autoplay ok! Ocultando alerta...');
                    if (statusEl) statusEl.style.display = 'none';
                })
                .catch(e => {
                    console.log('Play failed: ' + e.message);
                    if (statusEl) {
                        statusEl.style.display = 'block';
                        statusEl.textContent = 'CLIQUE AQUI PARA ATIVAR';
                        statusEl.style.background = 'red';
                        statusEl.style.cursor = 'pointer';
                        statusEl.onclick = () => {
                            remoteVideo.play();
                            statusEl.style.display = 'none';
                        };
                    }
                });
        };
    } else {
        console.warn(`Recebido track de ${targetId}, mas o alvo esperado é ${targetParticipantId}`);
    }
}

function handleIceCandidate(targetId, candidate) {
    console.log('Sending ICE Candidate from Clean Feed');
    ws.send(JSON.stringify({ type: 'ice-candidate', roomId: roomName, to: targetId, candidate }));
}

init();
