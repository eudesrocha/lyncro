const { v4: uuidv4 } = require('uuid');

class RoomManager {
    constructor() {
        this.rooms = new Map(); // roomId -> { participants: Map(participantId -> data), host: participantId }
    }

    createRoom(roomId = uuidv4(), password = null) {
        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, {
                participants: new Map(),
                host: null,
                hostUserId: null, // Supabase user ID do dono da sala
                password: password ? String(password).trim() : null
            });
        }
        return roomId;
    }

    joinRoom(roomId, participantData) {
        if (!this.rooms.has(roomId)) {
            this.createRoom(roomId);
        }

        const room = this.rooms.get(roomId);
        const participantId = participantData.id || uuidv4();

        const participant = {
            id: participantId,
            name: participantData.name || 'Anonymous',
            role: participantData.role || 'guest',
            status: participantData.role === 'host' || participantData.role === 'observer' ? 'accepted' : 'waiting',
            tallyState: 'off',
            muted: false,
            audioMuted: false,
            videoMuted: false,
            hostMuted: false,
            guestMutedSelf: false,
            isScreenSharing: false,
            ...participantData
        };

        // Validar ownership: se alguém tenta entrar como host numa sala que já tem dono
        if (participant.role === 'host') {
            const incomingUserId = participantData.userId || null;

            if (room.hostUserId && incomingUserId && room.hostUserId !== incomingUserId) {
                // Usuário diferente tentando ser host — REJEITAR
                return { rejected: true, reason: 'Esta sala já pertence a outro usuário.' };
            }

            // Registrar ou manter o dono
            if (!room.hostUserId && incomingUserId) {
                room.hostUserId = incomingUserId;
            }

            // Se já existia um host antigo (ex: aba duplicada do MESMO usuário), removemos ele
            if (room.host && room.host !== participantId) {
                const oldHost = room.participants.get(room.host);
                if (oldHost && oldHost.ws) {
                    try {
                        oldHost.ws.send(JSON.stringify({ type: 'error', message: 'Nova conexão de Host detectada. Esta sessão foi desconectada.' }));
                        oldHost.ws.close();
                    } catch (e) { }
                }
                room.participants.delete(room.host);
            }
            room.host = participantId;
        }

        room.participants.set(participantId, participant);
        return participant;
    }

    leaveRoom(roomId, participantId) {
        if (!this.rooms.has(roomId)) return null;

        const room = this.rooms.get(roomId);
        const participant = room.participants.get(participantId);

        room.participants.delete(participantId);

        if (room.host === participantId) {
            room.host = null;
            // Manter hostUserId para que só o dono possa reconectar como host
        }

        if (room.participants.size === 0) {
            this.rooms.delete(roomId); // Limpa tudo incluindo hostUserId
        }

        return participant;
    }

    getRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return null;

        return {
            id: roomId,
            host: room.host,
            participants: Array.from(room.participants.values()).map(p => {
                const { ws, userId, ...data } = p; // Remove WebSocket e userId do retorno
                return data;
            })
        };
    }

    updateParticipant(roomId, participantId, updates) {
        if (!this.rooms.has(roomId)) return null;
        const room = this.rooms.get(roomId);
        const participant = room.participants.get(participantId);
        if (!participant) return null;

        Object.assign(participant, updates);
        return participant;
    }

    getParticipants(roomId) {
        if (!this.rooms.has(roomId)) return [];
        return Array.from(this.rooms.get(roomId).participants.values());
    }
}

module.exports = new RoomManager();
