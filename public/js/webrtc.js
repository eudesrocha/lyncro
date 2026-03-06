class WebRTCClient {
    constructor(participantId, onTrack, onIceCandidate, onNegotiationNeeded, onDataChannel, onDataMessage) {
        this.participantId = participantId;
        this.onTrack = onTrack;
        this.onIceCandidate = onIceCandidate;
        this.onNegotiationNeeded = onNegotiationNeeded;
        this.onDataChannel = onDataChannel;
        this.onDataMessage = onDataMessage;
        this.peers = new Map(); // targetId -> RTCPeerConnection
        this.dataChannels = new Map(); // targetId -> RTCDataChannel
        this.fileTransferBuffers = new Map(); // targetId -> { meta: null, chunks: [] }
        this.candidateQueues = new Map(); // targetId -> Array of candidates
        this.localStream = null;
        this.returnAudioTrack = null;
        this.returnAudioSenders = new Map(); // targetId -> RTCRtpSender
        this.config = {
            iceServers: (window.LYNCRO_CONFIG && window.LYNCRO_CONFIG.ICE_SERVERS) || [
                { urls: 'stun:stun.l.google.com:19302' }
            ],
            iceTransportPolicy: 'all',
            iceCandidatePoolSize: 10
        };
    }

    log(msg) {
        console.log(`[WebRTC] ${msg}`);
        if (typeof window.debugLog === 'function') {
            window.debugLog(`[RTC] ${msg}`);
        }
    }

    updateConfig(newIceServers) {
        if (newIceServers && newIceServers.length > 0) {
            this.config.iceServers = newIceServers;
            this.log('Configuration updated');
        }
    }

    async setLocalStream(stream) {
        this.localStream = stream;
    }

    getPeer(targetId) {
        if (this.peers.has(targetId)) {
            return this.peers.get(targetId);
        }

        const pc = new RTCPeerConnection(this.config);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.onIceCandidate(targetId, event.candidate);
            }
        };

        pc.oniceconnectionstatechange = () => {
            this.log(`ICE State with ${targetId}: ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                this.checkSelectedCandidate(targetId, pc);
            }
        };

        pc.onicecandidateerror = (e) => {
            this.log(`ICE Candidate Error: ${e.errorText} (${e.errorCode})`);
        };

        pc.ontrack = (event) => {
            this.log(`Track received from: ${targetId} (${event.track.kind})`);
            const stream = event.streams[0] || new MediaStream([event.track]);
            this.onTrack(targetId, stream);
        };

        pc.onnegotiationneeded = () => {
            this.log(`Negotiation needed with ${targetId}`);
            if (this.onNegotiationNeeded) {
                this.onNegotiationNeeded(targetId);
            }
        };

        pc.ondatachannel = (event) => {
            this.log(`DataChannel received from ${targetId}`);
            this.setupDataChannel(targetId, event.channel);
            if (this.onDataChannel) this.onDataChannel(targetId, event.channel);
        };

        // Criar DataChannel se não existir
        if (!this.dataChannels.has(targetId)) {
            const dc = pc.createDataChannel("media-drop", { reliable: true });
            this.setupDataChannel(targetId, dc);
        }

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                pc.addTrack(track, this.localStream);
            });
        }

        // Adicionar trilha de retorno se existir
        if (this.returnAudioTrack) {
            this.log(`Adding existing return audio track to new peer ${targetId}`);
            const sender = pc.addTrack(this.returnAudioTrack, new MediaStream([this.returnAudioTrack]));
            this.returnAudioSenders.set(targetId, sender);
        }

        if (!this.localStream && !this.returnAudioTrack) {
            // Se não temos stream de saída, forçamos transceivers para receber
            this.log('Adding recvonly transceivers (No outgoing tracks)');
            try {
                pc.addTransceiver('video', { direction: 'recvonly' });
                pc.addTransceiver('audio', { direction: 'recvonly' });
            } catch (e) {
                this.log('Error adding transceivers: ' + e.message);
            }
        }

        this.peers.set(targetId, pc);
        return pc;
    }

    async checkSelectedCandidate(targetId, pc) {
        try {
            const stats = await pc.getStats();
            stats.forEach(report => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.writable) {
                    const localCandidate = stats.get(report.localCandidateId);
                    const remoteCandidate = stats.get(report.remoteCandidateId);
                    if (localCandidate && remoteCandidate) {
                        this.log(`[4G-TEST] Active Pair: Local(${localCandidate.candidateType}) <-> Remote(${remoteCandidate.candidateType})`);
                        if (localCandidate.candidateType === 'relay' || remoteCandidate.candidateType === 'relay') {
                            this.log(`✅ [SUCCESS] Conexão via TURN (Relay) ativa! 4G/Firewall funcionando.`);
                        }
                    }
                }
            });
        } catch (e) {
            this.log('Stats error: ' + e.message);
        }
    }

    async createOffer(targetId) {
        const pc = this.getPeer(targetId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        return offer;
    }

    async handleOffer(targetId, offer) {
        const pc = this.getPeer(targetId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.processCandidateQueue(targetId);
        return answer;
    }

    async handleAnswer(targetId, answer) {
        const pc = this.getPeer(targetId);
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await this.processCandidateQueue(targetId);
    }

    async handleCandidate(targetId, candidate) {
        const pc = this.getPeer(targetId);
        if (!pc.remoteDescription) {
            if (!this.candidateQueues.has(targetId)) this.candidateQueues.set(targetId, []);
            this.candidateQueues.get(targetId).push(candidate);
            return;
        }
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    async processCandidateQueue(targetId) {
        const pc = this.peers.get(targetId);
        const queue = this.candidateQueues.get(targetId);
        if (pc && queue) {
            while (queue.length > 0) {
                const candidate = queue.shift();
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
        }
    }

    removePeer(targetId) {
        if (this.peers.has(targetId)) {
            this.peers.get(targetId).close();
            this.peers.delete(targetId);
            this.returnAudioSenders.delete(targetId);
        }
        if (this.dataChannels.has(targetId)) {
            this.dataChannels.get(targetId).close();
            this.dataChannels.delete(targetId);
        }
        this.fileTransferBuffers.delete(targetId);
    }

    setupDataChannel(targetId, dc) {
        dc.onopen = () => this.log(`DataChannel with ${targetId} is OPEN`);
        dc.onclose = () => this.log(`DataChannel with ${targetId} is CLOSED`);
        dc.onerror = (e) => this.log(`DataChannel with ${targetId} ERROR: ${e.message}`);
        dc.onmessage = (event) => this.handleDataMessage(targetId, event.data);
        this.dataChannels.set(targetId, dc);
    }

    handleDataMessage(targetId, data) {
        if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'file-meta') {
                    this.log(`Receiving file meta from ${targetId}: ${msg.fileName}`);
                    this.fileTransferBuffers.set(targetId, {
                        meta: msg,
                        chunks: [],
                        receivedSize: 0
                    });
                } else if (msg.type === 'file-end') {
                    this.log(`File transfer complete from ${targetId}`);
                    const buffer = this.fileTransferBuffers.get(targetId);
                    if (buffer && buffer.chunks.length > 0) {
                        const blob = new Blob(buffer.chunks, { type: buffer.meta.fileType });
                        if (this.onDataMessage) {
                            this.onDataMessage(targetId, {
                                type: 'file',
                                fileName: buffer.meta.fileName,
                                blob: blob
                            });
                        }
                    }
                    this.fileTransferBuffers.delete(targetId);
                }
            } catch (e) {
                if (this.onDataMessage) this.onDataMessage(targetId, data);
            }
        } else {
            // Binary data (chunk)
            const buffer = this.fileTransferBuffers.get(targetId);
            if (buffer) {
                buffer.chunks.push(data);
                buffer.receivedSize += data.byteLength;
                if (this.onDataMessage) {
                    this.onDataMessage(targetId, {
                        type: 'file-progress',
                        fileName: buffer.meta.fileName,
                        progress: (buffer.receivedSize / buffer.meta.fileSize) * 100
                    });
                }
            }
        }
    }

    async sendFile(targetId, file, onProgress) {
        const dc = this.dataChannels.get(targetId);
        if (!dc || dc.readyState !== 'open') {
            throw new Error(`DataChannel with ${targetId} is not open`);
        }

        const CHUNK_SIZE = 16384; // 16KB
        const meta = {
            type: 'file-meta',
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type
        };

        dc.send(JSON.stringify(meta));

        const reader = new FileReader();
        let offset = 0;

        const readNextChunk = () => {
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.readAsArrayBuffer(slice);
        };

        reader.onload = (e) => {
            const buffer = e.target.result;

            if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
                dc.onbufferedamountlow = () => {
                    dc.onbufferedamountlow = null;
                    send();
                };
            } else {
                send();
            }

            function send() {
                dc.send(buffer);
                offset += buffer.byteLength;

                if (onProgress) onProgress((offset / file.size) * 100);

                if (offset < file.size) {
                    readNextChunk();
                } else {
                    dc.send(JSON.stringify({ type: 'file-end' }));
                }
            }
        };

        readNextChunk();
    }

    async replaceTrack(newTrack) {
        for (const [targetId, pc] of this.peers.entries()) {
            const senders = pc.getSenders();
            const sender = senders.find(s => s.track && s.track.kind === newTrack.kind && s !== this.returnAudioSenders.get(targetId));
            if (sender) {
                try {
                    await sender.replaceTrack(newTrack);
                    this.log(`Track ${newTrack.kind} replaced for peer ${targetId}`);
                } catch (e) {
                    this.log(`Failed to replace ${newTrack.kind} for ${targetId}: ${e.message}`);
                }
            } else {
                this.log(`No existing ${newTrack.kind} sender found for ${targetId}. Adding new track.`);
                pc.addTrack(newTrack, this.localStream || new MediaStream());
            }
        }
    }

    async addReturnAudioTrack(track) {
        this.returnAudioTrack = track;
        for (const [targetId, pc] of this.peers.entries()) {
            if (!this.returnAudioSenders.has(targetId)) {
                this.log(`Adding return audio track to peer ${targetId}`);
                const sender = pc.addTrack(track, new MediaStream([track]));
                this.returnAudioSenders.set(targetId, sender);
                pc.dispatchEvent(new Event('negotiationneeded'));
            } else {
                this.log(`Replacing return audio track for peer ${targetId}`);
                await this.returnAudioSenders.get(targetId).replaceTrack(track);
            }
        }
    }

    async removeReturnAudioTrack() {
        this.returnAudioTrack = null;
        for (const [targetId, pc] of this.peers.entries()) {
            const sender = this.returnAudioSenders.get(targetId);
            if (sender) {
                pc.removeTrack(sender);
                this.returnAudioSenders.delete(targetId);
                pc.dispatchEvent(new Event('negotiationneeded'));
            }
        }
    }

    closeAll() {
        this.peers.forEach(pc => pc.close());
        this.peers.clear();
        this.returnAudioSenders.clear();
        this.dataChannels.forEach(dc => dc.close());
        this.dataChannels.clear();
        this.fileTransferBuffers.clear();
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
        }
        if (this.returnAudioTrack) {
            this.returnAudioTrack.stop();
        }
    }
}
