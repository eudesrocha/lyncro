const WebSocket = require('ws');
const roomManager = require('./rooms');
const { getIceServers } = require('./ice');
const { verifySupabaseToken, getUserPlan } = require('./auth');

// Rate limiting simples por IP: máx de conexões simultâneas e mensagens por segundo
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_MESSAGES_PER_SECOND = 30;
const connectionsByIp = new Map(); // ip -> count

const HOST_GRACE_MS = 45_000;          // 45s para o host reconectar antes de encerrar a sessão
const GUEST_GRACE_MS = 30_000;         // 30s para convidado aceito reconectar antes de ser removido
const FREE_SESSION_MS = 20 * 60 * 1000; // 20 minutos para sessões FREE
const FREE_MAX_GUESTS = 3;             // Máximo de convidados simultâneos em sessões FREE

function setupSignaling(server) {
    const wss = new WebSocket.Server({ server });
    const hostGraceTimers = new Map();   // roomId       -> setTimeout handle
    const guestGraceTimers = new Map();  // participantId -> setTimeout handle
    const freeSessionTimers = new Map(); // roomId       -> setTimeout handle (20min FREE)

    const interval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                ws.missedPings = (ws.missedPings || 0) + 1;
                if (ws.missedPings >= 3) {
                    console.log(`[Heartbeat] Cliente não respondeu a 3 pings (15s). Derrubando TCP.`);
                    return ws.terminate(); // Cai somente após 3 erros (ajuda o 4G oscilante)
                }
            } else {
                ws.missedPings = 0;
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 5000); // Roda a cada 5s

    wss.on('close', () => clearInterval(interval));

    wss.on('connection', (ws, req) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        const ip = req.socket.remoteAddress;

        // Limitar conexões simultâneas por IP
        const ipCount = (connectionsByIp.get(ip) || 0) + 1;
        if (ipCount > MAX_CONNECTIONS_PER_IP) {
            console.warn(`[Rate Limit] IP ${ip} excedeu limite de conexões (${MAX_CONNECTIONS_PER_IP}). Rejeitando.`);
            ws.close(1008, 'Muitas conexões do mesmo IP.');
            return;
        }
        connectionsByIp.set(ip, ipCount);

        console.log(`\n[WS] Conexão de: ${ip} (${ipCount}/${MAX_CONNECTIONS_PER_IP})`);
        console.log(`[WS] User-Agent: ${req.headers['user-agent']}`);

        // Contador de mensagens por segundo
        let msgCount = 0;
        const msgReset = setInterval(() => { msgCount = 0; }, 1000);

        let currentRoomId = null;
        let participantId = null;

        ws.on('error', (err) => console.error(`[WS Error] ${ip}:`, err));

        ws.on('message', async (message) => {
            // Rate limit: rejeitar se exceder mensagens por segundo
            msgCount++;
            if (msgCount > MAX_MESSAGES_PER_SECOND) {
                console.warn(`[Rate Limit] IP ${ip} excedeu ${MAX_MESSAGES_PER_SECOND} msg/s. Ignorando.`);
                return;
            }

            try {
                const data = JSON.parse(message);
                const rawRoomId = data.roomId;
                const normalizedRoomId = (rawRoomId || 'default').trim();
                const { type, to } = data;

                switch (type) {
                    case 'join':
                        currentRoomId = normalizedRoomId;
                        const room_join = roomManager.rooms.get(normalizedRoomId);

                        // Reconexão transparente: convidado já aceito voltando após queda de WS
                        if (data.participant && data.participant.reconnectId) {
                            const reconnectId = data.participant.reconnectId;
                            const existingRoom = roomManager.rooms.get(normalizedRoomId);
                            if (existingRoom && existingRoom.participants.has(reconnectId)) {
                                const existing = existingRoom.participants.get(reconnectId);
                                if (existing.status === 'accepted' && existing.role === 'guest') {
                                    // Cancelar o grace timer pendente (se houver)
                                    if (guestGraceTimers.has(reconnectId)) {
                                        clearTimeout(guestGraceTimers.get(reconnectId));
                                        guestGraceTimers.delete(reconnectId);
                                    }
                                    roomManager.updateParticipant(normalizedRoomId, reconnectId, { ws });
                                    participantId = reconnectId;
                                    console.log(`[RECONNECT] "${existing.name}" reconectou à sala "${normalizedRoomId}" (ID: ${reconnectId})`);

                                    const roomRecon = roomManager.rooms.get(normalizedRoomId);
                                    const iceServersRecon = await getIceServers(roomRecon && roomRecon.hostPlan === 'pro');
                                    ws.send(JSON.stringify({ type: 'init-network', iceServers: iceServersRecon, yourId: reconnectId }));
                                    ws.send(JSON.stringify({ type: 'admission-result', status: 'accepted' }));

                                    // Avisar todos que este participante reconectou (para limpar peer antigo e re-iniciar)
                                    broadcastToRoom(normalizedRoomId, { type: 'peer-reconnected', participantId: reconnectId });

                                    broadcastToRoom(normalizedRoomId, {
                                        type: 'participant-update',
                                        layout: existingRoom.layout,
                                        participants: roomManager.getRoom(normalizedRoomId).participants
                                    });
                                    break;
                                }
                            }
                        }

                        // Validar identidade do host via JWT do Supabase
                        // Só aplica se SUPABASE_URL e SUPABASE_ANON_KEY estiverem configurados.
                        // Sem essas variáveis (ex: dev local), a validação é pulada com aviso.
                        let hostPlan = 'free'; // padrão conservador
                        if (data.participant && data.participant.role === 'host') {
                            if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
                                const supabaseUser = await verifySupabaseToken(data.participant.token);
                                if (!supabaseUser) {
                                    console.log(`[JOIN REJECTED] Room: "${normalizedRoomId}" | Motivo: Token de host inválido`);
                                    ws.send(JSON.stringify({
                                        type: 'error',
                                        message: 'Acesso de host negado. Faça login novamente.'
                                    }));
                                    ws.close();
                                    return;
                                }
                                // Garantir que o userId usado para ownership seja o do Supabase
                                data.participant.userId = supabaseUser.id;
                                // Verificar plano do host (server-side, não bypassável)
                                hostPlan = await getUserPlan(supabaseUser.id);
                                console.log(`[PLAN] Host ${supabaseUser.id} plano=${hostPlan} sala="${normalizedRoomId}"`);
                            } else {
                                console.warn('[Auth] SUPABASE_URL/ANON_KEY não configurados. Pulando validação JWT e plano do host.');
                                hostPlan = 'pro'; // dev mode: sem restrição
                            }
                        }

                        // Validar senha se a sala possuir uma
                        if (room_join && room_join.password && data.password !== room_join.password) {
                            console.log(`[JOIN REJECTED] Room: "${normalizedRoomId}" | Motivo: Senha Incorreta`);
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: 'Senha incorreta para esta sala.'
                            }));
                            return;
                        }

                        // Se o host estava no grace period, cancelar o timer de encerramento
                        if (data.participant && data.participant.role === 'host' && hostGraceTimers.has(normalizedRoomId)) {
                            clearTimeout(hostGraceTimers.get(normalizedRoomId));
                            hostGraceTimers.delete(normalizedRoomId);
                            console.log(`[GRACE] Host reconectou à sala "${normalizedRoomId}". Sessão mantida.`);
                        }
                        // O timer FREE não é cancelado na reconexão — o tempo continua correndo

                        const participant = roomManager.joinRoom(normalizedRoomId, { ...data.participant, ws });

                        // Verificar se o join foi rejeitado por ownership
                        if (participant.rejected) {
                            console.log(`[JOIN REJECTED] Room: "${normalizedRoomId}" | Motivo: ${participant.reason}`);
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: participant.reason
                            }));
                            ws.close();
                            return;
                        }

                        participantId = participant.id;

                        // Limitar convidados em sessões FREE
                        if (participant.role === 'guest') {
                            const roomForLimit = roomManager.rooms.get(normalizedRoomId);
                            const isPlanFree = !roomForLimit || roomForLimit.hostPlan !== 'pro';
                            if (isPlanFree) {
                                const guestCount = roomManager.getParticipants(normalizedRoomId)
                                    .filter(p => p.role === 'guest' && p.id !== participant.id).length;
                                if (guestCount >= FREE_MAX_GUESTS) {
                                    console.log(`[JOIN REJECTED] Sala "${normalizedRoomId}" atingiu limite FREE de ${FREE_MAX_GUESTS} convidados.`);
                                    ws.send(JSON.stringify({
                                        type: 'error',
                                        message: `Esta sessão gratuita atingiu o limite de ${FREE_MAX_GUESTS} convidados. O produtor precisa do plano PRO para mais convidados.`
                                    }));
                                    roomManager.leaveRoom(normalizedRoomId, participantId);
                                    ws.close();
                                    return;
                                }
                            }
                        }

                        console.log(`[JOIN] Room: "${normalizedRoomId}" | Participant: "${participant.name}" | Role: ${participant.role}`);

                        // ── Timer de 20 minutos para hosts FREE ──────────────────────────────
                        if (participant.role === 'host' && hostPlan === 'free') {
                            // Cancelar timer anterior caso o host esteja reconectando
                            if (freeSessionTimers.has(normalizedRoomId)) {
                                clearTimeout(freeSessionTimers.get(normalizedRoomId));
                            }
                            const freeTimer = setTimeout(() => {
                                freeSessionTimers.delete(normalizedRoomId);
                                console.log(`[FREE LIMIT] Sessão FREE da sala "${normalizedRoomId}" expirou após 20min.`);
                                broadcastToRoom(normalizedRoomId, {
                                    type: 'session-ended',
                                    reason: 'time_limit'
                                });
                                // Fechar conexões após breve delay para garantia de entrega
                                setTimeout(() => {
                                    roomManager.getParticipants(normalizedRoomId).forEach(p => {
                                        if (p.ws) try { p.ws.close(); } catch (_) { }
                                    });
                                }, 2000);
                            }, FREE_SESSION_MS);
                            freeSessionTimers.set(normalizedRoomId, freeTimer);
                            console.log(`[FREE LIMIT] Timer de 20min iniciado para sala "${normalizedRoomId}".`);

                            // Avisar o host sobre o limite (para a UI exibir contagem regressiva se necessário)
                            ws.send(JSON.stringify({
                                type: 'session-plan',
                                plan: 'free',
                                sessionLimitMs: FREE_SESSION_MS
                            }));
                        } else if (participant.role === 'host' && hostPlan === 'pro') {
                            // PRO: cancelar qualquer timer FREE residual e confirmar plano
                            if (freeSessionTimers.has(normalizedRoomId)) {
                                clearTimeout(freeSessionTimers.get(normalizedRoomId));
                                freeSessionTimers.delete(normalizedRoomId);
                            }
                            ws.send(JSON.stringify({ type: 'session-plan', plan: 'pro' }));
                        }

                        // ── ICE Servers: TURN Twilio apenas para PRO ─────────────────────────
                        // Guests herdam o plano da sala (sala criada por PRO = todos com TURN)
                        const roomForIce = roomManager.rooms.get(normalizedRoomId);
                        const roomIsPro = participant.role === 'host'
                            ? hostPlan === 'pro'
                            : (roomForIce && roomForIce.hostPlan === 'pro');
                        const iceServers = await getIceServers(roomIsPro);

                        // Armazenar plano do host na sala para que guests herdem TURN
                        if (participant.role === 'host') {
                            if (roomForIce) roomForIce.hostPlan = hostPlan;
                        }

                        // Enviar configuração de rede inicial apenas para o participante que entrou
                        ws.send(JSON.stringify({
                            type: 'init-network',
                            iceServers: iceServers,
                            yourId: participantId
                        }));

                        // [FIX] Crucial: Informar ao participante seu status (waiting/accepted)
                        ws.send(JSON.stringify({
                            type: 'admission-result',
                            status: participant.status
                        }));

                        // Avisar a todos na sala sobre a atualização
                        broadcastToRoom(normalizedRoomId, {
                            type: 'participant-update',
                            layout: roomManager.getRoom(normalizedRoomId).layout,
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

                    case 'session-ended':
                        // Host encerrou a sessão intencionalmente
                        if (currentRoomId && participantId) {
                            console.log(`[SESSION-END] Host ${participantId} encerrou a sessão "${currentRoomId}" intencionalmente.`);
                            // Avisar todos os convidados antes de limpar
                            broadcastToRoom(currentRoomId, { type: 'session-ended', reason: 'host_ended' });
                            // Cancelar todos os timers da sala
                            if (hostGraceTimers.has(currentRoomId)) {
                                clearTimeout(hostGraceTimers.get(currentRoomId));
                                hostGraceTimers.delete(currentRoomId);
                            }
                            if (freeSessionTimers.has(currentRoomId)) {
                                clearTimeout(freeSessionTimers.get(currentRoomId));
                                freeSessionTimers.delete(currentRoomId);
                            }
                            // Fechar conexões dos convidados após breve delay
                            setTimeout(() => {
                                const r = roomManager.getRoom(currentRoomId);
                                if (r) roomManager.getParticipants(currentRoomId).forEach(p => {
                                    if (p.ws) try { p.ws.close(); } catch (_) { }
                                });
                            }, 1500);
                        }
                        break;

                    case 'leave':
                        // O Cliente explicitamente avisou que está de saída definitiva
                        if (currentRoomId && participantId) {
                            console.log(`[LEAVE EXPLICIT] Participant ${participantId} saiu ativamente da sala ${currentRoomId}.`);
                            if (guestGraceTimers.has(participantId)) {
                                clearTimeout(guestGraceTimers.get(participantId));
                                guestGraceTimers.delete(participantId);
                            }
                            roomManager.leaveRoom(currentRoomId, participantId);
                            const roomNow = roomManager.getRoom(currentRoomId);
                            if (roomNow) {
                                broadcastToRoom(currentRoomId, {
                                    type: 'participant-update',
                                    layout: roomNow.layout,
                                    participants: roomNow.participants
                                });
                                // Sinaliza pra limpar webRTC imediatamente no Grid e Host
                                broadcastToRoom(currentRoomId, { type: 'participant-left', participantId: participantId });
                            }
                        }
                        break;

                    case 'chat-typing':
                        broadcastToRoom(normalizedRoomId, {
                            type: 'chat-typing',
                            name: data.name,
                            isTyping: data.isTyping
                        });
                        break;

                    case 'prompter-sync': {
                        // PRO-only feature: rejeitar no server se plano FREE
                        const prompterRoom = roomManager.rooms.get(normalizedRoomId);
                        if (prompterRoom && prompterRoom.hostPlan !== 'pro') {
                            ws.send(JSON.stringify({ type: 'error', message: 'Teleprompter requer plano PRO.' }));
                            break;
                        }
                        // Mirror the teleprompter state (text, speed, playback, etc) verbatim to everyone in the room
                        broadcastToRoom(normalizedRoomId, {
                            type: 'prompter-sync',
                            payload: data.payload
                        });
                        break;
                    }

                    case 'prompter-finished':
                        // Guest avisando o Host que a rolagem dele acabou
                        broadcastToRoom(normalizedRoomId, {
                            type: 'prompter-finished'
                        });
                        break;

                    case 'tally-change':
                        const room = roomManager.getRoom(normalizedRoomId);
                        if (room.host === participantId) {
                            roomManager.updateParticipant(normalizedRoomId, data.participantId, { tallyState: data.tallyState });

                            broadcastToRoom(normalizedRoomId, {
                                type: 'participant-update',
                                layout: room.layout,
                                participants: roomManager.getRoom(normalizedRoomId).participants
                            });
                        }
                        break;

                    case 'media-control':
                        const rm = roomManager.getRoom(normalizedRoomId);
                        if (!rm) break;

                        if (rm.host === participantId) {
                            // Host tá mutando o convidado
                            const targetParticipant = rm.participants.find(p => p.id === data.targetId);
                            if (targetParticipant) {
                                const isMute = data.action === 'mute';
                                if (data.mediaType === 'audio') {
                                    roomManager.updateParticipant(normalizedRoomId, data.targetId, {
                                        hostMuted: isMute,
                                        audioMuted: isMute
                                    });
                                } else if (data.mediaType === 'video') {
                                    roomManager.updateParticipant(normalizedRoomId, data.targetId, {
                                        videoMuted: isMute
                                    });
                                }
                            }
                            sendToParticipant(normalizedRoomId, data.targetId, {
                                type: 'media-control',
                                mediaType: data.mediaType,
                                action: data.action
                            });
                        } else {
                            // O próprio Convidado trocou o botão dele e quer avisar a sala
                            const isMute = data.action === 'mute';
                            if (data.mediaType === 'audio') {
                                roomManager.updateParticipant(normalizedRoomId, participantId, { audioMuted: isMute });
                            } else if (data.mediaType === 'video') {
                                roomManager.updateParticipant(normalizedRoomId, participantId, { videoMuted: isMute });
                            }
                        }

                        // Pra todos atualizarem os hud com o estado novo da mídia (icones de mic cortado)
                        broadcastToRoom(normalizedRoomId, {
                            type: 'participant-update',
                            layout: rm.layout,
                            participants: roomManager.getRoom(normalizedRoomId).participants
                        });
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
                                layout: rmAdm.layout,
                                participants: roomManager.getRoom(normalizedRoomId).participants
                            });
                        }
                        break;

                    case 'kick':
                        const rmKick = roomManager.getRoom(normalizedRoomId);
                        if (rmKick && rmKick.host === participantId) {
                            // Enviar notificação de kick ao convidado alvo
                            sendToParticipant(normalizedRoomId, data.targetId, {
                                type: 'kicked',
                                message: 'Você foi removido da sala pelo produtor.'
                            });

                            // Fechar a conexão WebSocket do convidado
                            const targetParts = roomManager.getParticipants(normalizedRoomId);
                            const kickedP = targetParts.find(p => p.id === data.targetId);
                            if (kickedP && kickedP.ws) {
                                try { kickedP.ws.close(); } catch (e) { }
                            }

                            // Remover da sala
                            roomManager.leaveRoom(normalizedRoomId, data.targetId);

                            // Broadcast atualização
                            broadcastToRoom(normalizedRoomId, {
                                type: 'participant-update',
                                layout: rmKick.layout,
                                participants: roomManager.getRoom(normalizedRoomId)?.participants || []
                            });

                            console.log(`[KICK] ${data.targetId} removido da sala ${normalizedRoomId} pelo host`);
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
                            layout: roomManager.getRoom(normalizedRoomId).layout,
                            participants: roomManager.getRoom(normalizedRoomId).participants
                        });
                        break;

                    case 'screen-status-change':
                        roomManager.updateParticipant(normalizedRoomId, participantId, {
                            isScreenSharing: data.isScreenSharing
                        });
                        broadcastToRoom(normalizedRoomId, {
                            type: 'participant-update',
                            layout: roomManager.getRoom(normalizedRoomId).layout,
                            participants: roomManager.getRoom(normalizedRoomId).participants
                        });
                        break;

                    case 'overlay-control': {
                        // PRO-only feature: rejeitar no server se plano FREE
                        const overlayRoomRaw = roomManager.rooms.get(normalizedRoomId);
                        if (overlayRoomRaw && overlayRoomRaw.hostPlan !== 'pro') {
                            ws.send(JSON.stringify({ type: 'error', message: 'Lower Thirds requer plano PRO.' }));
                            break;
                        }
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
                                title: data.title,
                                style: data.style || 'classic'
                            });

                            // Também avisar a todos sobre a atualização de estado (para quem entrar depois)
                            broadcastToRoom(normalizedRoomId, {
                                type: 'participant-update',
                                layout: rmOverlay.layout,
                                participants: roomManager.getRoom(normalizedRoomId).participants
                            });
                        }
                        break;
                    }

                    case 'layout-change':
                        const rmLayout = roomManager.getRoom(normalizedRoomId);
                        if (rmLayout && rmLayout.host === participantId) {
                            // Atualizar estado global da sala
                            roomManager.updateRoom(normalizedRoomId, { layout: data.layout });

                            // Avisar a todos sobre o novo layout
                            broadcastToRoom(normalizedRoomId, {
                                type: 'participant-update',
                                layout: data.layout,
                                participants: roomManager.getRoom(normalizedRoomId).participants
                            });
                        }
                        break;

                    case 'labels-toggle':
                        broadcastToRoom(normalizedRoomId, {
                            type: 'labels-toggle',
                            showLabels: data.showLabels
                        });
                        break;
                }
            } catch (err) {
                console.error('Error processing WS message:', err);
            }
        });

        ws.on('close', () => {
            clearInterval(msgReset);
            const remaining = (connectionsByIp.get(ip) || 1) - 1;
            if (remaining <= 0) connectionsByIp.delete(ip);
            else connectionsByIp.set(ip, remaining);

            if (currentRoomId && participantId) {
                const roomBeforeLeave = roomManager.getRoom(currentRoomId);
                const wasHost = roomBeforeLeave && roomBeforeLeave.host === participantId;
                const participantSnap = roomBeforeLeave && roomBeforeLeave.participants.find(p => p.id === participantId);
                const isAcceptedGuest = !wasHost && participantSnap && participantSnap.status === 'accepted' && participantSnap.role === 'guest';

                console.log(`Participant ${participantId} left room ${currentRoomId}${wasHost ? ' [HOST]' : isAcceptedGuest ? ' [GUEST – grace period]' : ''}`);

                if (isAcceptedGuest) {
                    // Não remover imediatamente: dar grace period para reconexão transparente
                    roomManager.updateParticipant(currentRoomId, participantId, { ws: null });

                    const graceTimer = setTimeout(() => {
                        guestGraceTimers.delete(participantId);
                        roomManager.leaveRoom(currentRoomId, participantId);
                        console.log(`[GRACE] Convidado "${participantSnap.name}" não reconectou. Removido da sala "${currentRoomId}".`);
                        const roomAfter = roomManager.getRoom(currentRoomId);
                        if (roomAfter) {
                            broadcastToRoom(currentRoomId, { type: 'participant-update', participants: roomAfter.participants });
                        }
                    }, GUEST_GRACE_MS);

                    guestGraceTimers.set(participantId, graceTimer);
                    console.log(`[GRACE] Convidado "${participantSnap.name}" desconectou. Grace period de ${GUEST_GRACE_MS / 1000}s iniciado.`);
                    // Não broadcast participant-update aqui — o convidado provavelmente vai reconectar em breve
                } else {
                    roomManager.leaveRoom(currentRoomId, participantId);
                }

                if (wasHost) {
                    // Pausar o timer FREE enquanto o host está offline (não penalizar por queda)
                    // O timer recomeça quando o host reconectar
                    if (freeSessionTimers.has(currentRoomId)) {
                        clearTimeout(freeSessionTimers.get(currentRoomId));
                        freeSessionTimers.delete(currentRoomId);
                        console.log(`[FREE LIMIT] Timer FREE pausado durante desconexão do host na sala "${currentRoomId}".`);
                    }

                    // Grace period: dá 45s para o host reconectar antes de encerrar a sessão
                    const timer = setTimeout(() => {
                        hostGraceTimers.delete(currentRoomId);
                        // Limpar timer FREE também se o host não voltou
                        if (freeSessionTimers.has(currentRoomId)) {
                            clearTimeout(freeSessionTimers.get(currentRoomId));
                            freeSessionTimers.delete(currentRoomId);
                        }
                        const room = roomManager.getRoom(currentRoomId);
                        const hasGuests = room && room.participants.some(p => p.role !== 'host');

                        if (hasGuests) {
                            console.log(`[GRACE] Host não reconectou à sala "${currentRoomId}". Encerrando sessão para ${room.participants.length} convidado(s).`);
                            broadcastToRoom(currentRoomId, { type: 'session-ended', reason: 'host_timeout' });
                            // Fechar conexões dos convidados após breve delay para garantir entrega
                            setTimeout(() => {
                                roomManager.getParticipants(currentRoomId).forEach(p => {
                                    if (p.ws) try { p.ws.close(); } catch (_) { }
                                });
                            }, 2000);
                        }
                    }, HOST_GRACE_MS);

                    hostGraceTimers.set(currentRoomId, timer);
                    console.log(`[GRACE] Host da sala "${currentRoomId}" desconectou. Grace period de ${HOST_GRACE_MS / 1000}s iniciado.`);

                    // Avisar convidados que o host desconectou (mas a sessão ainda está viva)
                    broadcastToRoom(currentRoomId, { type: 'host-disconnected', gracePeriodMs: HOST_GRACE_MS });
                }

                const room = roomManager.getRoom(currentRoomId);
                if (room && !isAcceptedGuest) {
                    broadcastToRoom(currentRoomId, {
                        type: 'participant-update',
                        layout: room.layout,
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
