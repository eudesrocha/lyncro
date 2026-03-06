const WebSocket = require('ws');
const roomManager = require('./rooms');
const { getIceServers } = require('./ice');

function setupSignaling(server) {
    const wss = new WebSocket.Server({ server });

    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress;
        console.log(`\n[WS] >>> TENTATIVA DE CONEXÃO RECEBIDA DE: ${ip}`);
        console.log(`[WS] User-Agent: ${req.headers['user-agent']}`);

        let currentRoomId = null;
        let participantId = null;

        ws.on('error', (err) => console.error(`[WS Error] ${ip}:`, err));

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                const rawRoomId = data.roomId;
                const normalizedRoomId = (rawRoomId || 'default').trim();
                const { type, to } = data;

                switch (type) {
                    case 'join':
                        currentRoomId = normalizedRoomId;
                        const room_join = roomManager.rooms.get(normalizedRoomId);

                        // Validar senha se a sala possuir uma
                        if (room_join && room_join.password && data.password !== room_join.password) {
                            console.log(`[JOIN REJECTED] Room: "${normalizedRoomId}" | Motivo: Senha Incorreta`);
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: 'Senha incorreta para esta sala.'
                            }));
                            return;
                        }

                        const participant = roomManager.joinRoom(normalizedRoomId, { ...data.participant, ws });
                        participantId = participant.id;

                        console.log(`[JOIN] Room: "${normalizedRoomId}" | Participant: "${participant.name}" | Role: ${participant.role}`);

                        // Buscar IceServers dinâmicos para o cliente
                        const iceServers = await getIceServers();

                        // Enviar configuração de rede inicial apenas para o participante que entrou
                        ws.send(JSON.stringify({
                            type: 'init-network',
                            iceServers: iceServers,
                            yourId: participantId
                        }));

                        // Avisar a todos na sala sobre a atualização
                        broadcastToRoom(normalizedRoomId, {
                            type: 'participant-update',
                            participants: roomManager.getRoom(normalizedRoomId).participants
                        });
                        break;

                    case 'offer':
                    case 'answer':
                    case 'ice-candidate':
                        // Encaminhar sinalização WebRTC para o destinatário específico
                        if (to) {
                            sendToParticipant(normalizedRoomId, to, { ...data, from: participantId });
                        }
                        break;

                    case 'chat':
                        broadcastToRoom(normalizedRoomId, {
                            type: 'chat',
                            from: participantId,
                            name: data.name,
                            text: data.text,
                            timestamp: Date.now()
                        });
                        break;

                    case 'tally-change':
                        const room = roomManager.getRoom(normalizedRoomId);
                        if (room.host === participantId) {
                            roomManager.updateParticipant(normalizedRoomId, data.participantId, { tallyState: data.tallyState });

                            broadcastToRoom(normalizedRoomId, {
                                type: 'participant-update',
                                participants: roomManager.getRoom(normalizedRoomId).participants
                            });
                        }
                        break;

                    case 'media-control':
                        const rm = roomManager.getRoom(normalizedRoomId);
                        if (rm && rm.host === participantId) {
                            const targetParticipant = rm.participants.find(p => p.id === data.targetId);
                            if (targetParticipant && data.mediaType === 'audio') {
                                if (data.action === 'mute') {
                                    roomManager.updateParticipant(normalizedRoomId, data.targetId, { hostMuted: true });
                                } else if (data.action === 'unmute') {
                                    // if the guest muted themselves, the host cannot unmute them
                                    if (targetParticipant.guestMutedSelf) {
                                        sendToParticipant(normalizedRoomId, participantId, {
                                            type: 'error',
                                            message: 'O convidado silenciou o próprio microfone por privacidade.'
                                        });
                                        return; // Intercept command
                                    }
                                    roomManager.updateParticipant(normalizedRoomId, data.targetId, { hostMuted: false });
                                }
                            }

                            sendToParticipant(normalizedRoomId, data.targetId, {
                                type: 'media-control',
                                mediaType: data.mediaType,
                                action: data.action
                            });
                        }
                        break;

                    case 'room-admission':
                        const rmAdm = roomManager.getRoom(normalizedRoomId);
                        if (rmAdm && rmAdm.host === participantId) {
                            roomManager.updateParticipant(normalizedRoomId, data.targetId, { status: data.status });
                            // Avisar o convidado que ele foi aceito ou rejeitado
                            sendToParticipant(normalizedRoomId, data.targetId, {
                                type: 'admission-result',
                                status: data.status
                            });
                            // Atualizar a lista de todos
                            broadcastToRoom(normalizedRoomId, {
                                type: 'participant-update',
                                participants: roomManager.getRoom(normalizedRoomId).participants
                            });
                        }
                        break;

                    case 'media-status-change':
                        const updates = {
                            audioMuted: data.audioMuted,
                            videoMuted: data.videoMuted
                        };
                        // Track if the guest muted themselves voluntarily
                        if (data.audioMuted !== undefined) {
                            updates.guestMutedSelf = data.audioMuted;
                        }

                        roomManager.updateParticipant(normalizedRoomId, participantId, updates);
                        broadcastToRoom(normalizedRoomId, {
                            type: 'participant-update',
                            participants: roomManager.getRoom(normalizedRoomId).participants
                        });
                        break;

                    case 'screen-status-change':
                        roomManager.updateParticipant(normalizedRoomId, participantId, {
                            isScreenSharing: data.isScreenSharing
                        });
                        broadcastToRoom(normalizedRoomId, {
                            type: 'participant-update',
                            participants: roomManager.getRoom(normalizedRoomId).participants
                        });
                        break;

                    case 'overlay-control':
                        const rmOverlay = roomManager.getRoom(normalizedRoomId);
                        if (rmOverlay && rmOverlay.host === participantId) {
                            // Persistir o estado do overlay no participante alvo
                            roomManager.updateParticipant(normalizedRoomId, data.targetId, {
                                overlayActive: data.action === 'show',
                                overlayName: data.name || '',
                                overlayTitle: data.title || ''
                            });

                            // Broadcast para todos na sala (incluindo o alvo e clean feeds)
                            broadcastToRoom(normalizedRoomId, {
                                type: 'overlay-control',
                                targetId: data.targetId,
                                action: data.action, // 'show' ou 'hide'
                                name: data.name,
                                title: data.title
                            });

                            // Também avisar a todos sobre a atualização de estado (para quem entrar depois)
                            broadcastToRoom(normalizedRoomId, {
                                type: 'participant-update',
                                participants: roomManager.getRoom(normalizedRoomId).participants
                            });
                        }
                        break;
                }
            } catch (err) {
                console.error('Error processing WS message:', err);
            }
        });

        ws.on('close', () => {
            if (currentRoomId && participantId) {
                console.log(`Participant ${participantId} left room ${currentRoomId}`);
                roomManager.leaveRoom(currentRoomId, participantId);

                const room = roomManager.getRoom(currentRoomId);
                if (room) {
                    broadcastToRoom(currentRoomId, {
                        type: 'participant-update',
                        participants: room.participants
                    });
                }
            }
        });
    });

    function broadcastToRoom(roomId, message) {
        const participants = roomManager.getParticipants(roomId);
        if (participants.length === 0) return;
        let payload = JSON.stringify(message);

        // Se for atualização de lista, garantir que observers sumiram
        if (message.type === 'participant-update') {
            const publicOnly = message.participants.filter(p => p.role !== 'observer');
            payload = JSON.stringify({ ...message, participants: publicOnly });
            console.log(`[Broadcast] Room ${roomId} update. Sending ${publicOnly.length} participants.`);
        }

        participants.forEach(p => {
            if (p.ws && p.ws.readyState === WebSocket.OPEN) {
                p.ws.send(payload);
            }
        });
    }

    function sendToParticipant(roomId, targetId, message) {
        const participants = roomManager.getParticipants(roomId);
        const target = participants.find(p => p.id === targetId);
        if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(JSON.stringify(message));
        }
    }
}

module.exports = setupSignaling;
