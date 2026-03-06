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

function setupWebSocket() {
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
        }
    };
}

async function initiateConnection(targetId) {
    const offer = await rtcClient.createOffer(targetId);
    ws.send(JSON.stringify({ type: 'offer', roomId: roomName, to: targetId, offer }));
}

function handleRemoteTrack(targetId, stream) {
    console.log('Receiving remote stream for clean feed: ' + targetId);
    const statusEl = document.getElementById('status');

    if (targetId === targetParticipantId) {
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.textContent = 'CONECTADO! Iniciando vídeo...';
            statusEl.style.background = 'green';
        }

        remoteVideo.srcObject = stream;
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
