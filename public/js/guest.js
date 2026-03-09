// ── Presets de Qualidade de Vídeo ────────────────────────────────────────────
const VIDEO_QUALITY_PRESETS = {
    '1080_30': { label: '1080p 30fps', width: 1920, height: 1080, frameRate: 30 },
    '720': { label: '720p HD', width: 1280, height: 720, frameRate: 30 },
    '480': { label: '480p SD', width: 854, height: 480, frameRate: 30 },
    '360': { label: '360p LQ', width: 640, height: 360, frameRate: 30 },
};

function buildVideoConstraints(qualityKey, extras = {}) {
    const p = VIDEO_QUALITY_PRESETS[qualityKey] || VIDEO_QUALITY_PRESETS['720'];
    return {
        width: { ideal: p.width },
        height: { ideal: p.height },
        // Remover constrição amarrada de FPS para garantir que mais hardwares rodem em 1080p
        ...extras
    };
}

function detectAndSuggestQuality() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return; // Safari e outros sem Network Information API — mantém padrão 720p

    const downlink = conn.downlink || 0; // Mbps estimados
    const eff = conn.effectiveType || '4g';

    let suggested = '720';
    if (downlink >= 15) {
        suggested = '1080_30';
    } else if (downlink >= 4 && eff === '4g') {
        suggested = '720'; // padrão, sem notificação
    } else if (eff === '3g' || (downlink > 0 && downlink < 3)) {
        suggested = '480';
    } else if (eff === '2g' || eff === 'slow-2g') {
        suggested = '360';
    }

    if (suggested === '720') return; // padrão, não precisa notificar

    const el = document.getElementById('video-quality');
    if (el) {
        el.value = suggested;
        el.dispatchEvent(new Event('change'));
    }
    // Toast aparece depois que a UI está pronta
    setTimeout(() => {
        const preset = VIDEO_QUALITY_PRESETS[suggested];
        showToast(`Qualidade ajustada para ${preset.label} baseada na sua conexão`, 'info');
    }, 1500);
}

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
let wsReconnectDelay = 2000;     // Backoff exponencial (inicia em 2s, max 30s)
let wsIntentionalClose = false;  // Evita reconexão em saídas propositais (kick, reject)
let isHostMuted = false;
let audioContext;
let analyser;
let processedStream = null; // Stream pós-IA (se ativo)
let currentVbMode = 'none';
let currentVbImage = null;
let currentVbBtnId = 'vb-btn-none';
let isScreenSharing = false;
let screenStream = null;

// === Speaker View State ===
let pinnedParticipantId = null; // ID do participante fixado manualmente
let activeSpeakerId = null; // ID do speaker ativo detectado automaticamente
let remoteStreams = new Map(); // targetId -> MediaStream
let remoteNames = new Map(); // targetId -> name
let speakerAnalyzers = new Map(); // targetId -> { analyser, dataArray, source }
let speakerDetectionInterval = null;
let speakerAudioCtx = null;
let currentFullscreenId = null; // ID de quem está sendo exibido em fullscreen (pin ou auto)
let currentParticipants = []; // array cache de particpantes da sala

// ── Noise-tolerant speaker detection parameters ──────────────────────────────
// Requires sustained speech before switching; ignores brief spikes and background noise.
const SPEAK_THRESHOLD = 18;  // Raw avg level (0-255) above noise floor to count as speaking
const SPEAK_CONFIRM_FRAMES = 6;   // Must speak for 6 × 200ms = ~1.2s before switching
const SILENCE_CONFIRM_FRAMES = 25; // Must be silent for 25 × 200ms = ~5s before switching back
const SPEAKER_SWITCH_COOLDOWN = 3000; // Minimum ms between auto-switches
const SMOOTH_WINDOW = 5;          // Frames averaged for level smoothing
const NOISE_FLOOR_WINDOW = 40;    // Rolling history length for noise floor calculation
// ─────────────────────────────────────────────────────────────────────────────
let lastSpeakerSwitch = 0;

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
        if (savedQuality && qualitySelect) {
            qualitySelect.value = savedQuality;
        } else {
            detectAndSuggestQuality();
        }

        const qualityKey = qualitySelect ? qualitySelect.value : '720';
        const facingExtras = { facingMode: companionOf ? 'environment' : 'user' };
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: buildVideoConstraints(qualityKey, facingExtras),
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
        } catch (constraintErr) {
            // Se a câmera não suporta a resolução pedida, tentar 720p como fallback
            console.warn(`[Media] Falha com ${qualityKey}, tentando 720p:`, constraintErr.message);
            if (qualityKey !== '720') {
                if (qualitySelect) qualitySelect.value = '720';
                localStorage.setItem('lyncro_video_quality', '720');
            }
            localStream = await navigator.mediaDevices.getUserMedia({
                video: buildVideoConstraints('720', facingExtras),
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
        }

        if (localStream.getAudioTracks().length > 0) {
            localStream.getAudioTracks()[0].enabled = isMicOn; // Assegura que o estado global permaneceu
        }

        // Aplicar processamento de Fundo Virtual (se ativo)
        if (currentVbMode !== 'none') {
            const btn = document.getElementById(currentVbBtnId);
            if (btn) btn.classList.add('opacity-50', 'pointer-events-none'); // Disable during load

            try {
                processedStream = await window.vbManager.start(localStream, { mode: currentVbMode, imageUrl: currentVbImage });
                preVideo.srcObject = processedStream;
            } catch (e) {
                console.error("Falha ao iniciar Virtual Background, usando stream limpo", e);
                processedStream = localStream;
                preVideo.srcObject = localStream;
            } finally {
                if (btn) btn.classList.remove('opacity-50', 'pointer-events-none');
            }
        } else {
            processedStream = localStream;
            preVideo.srcObject = localStream;
            window.vbManager.stop();
        }

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
        const preset = VIDEO_QUALITY_PRESETS[val] || VIDEO_QUALITY_PRESETS['720'];
        const display = document.getElementById('quality-display-name');
        if (display) display.innerText = preset.label;

        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
        }
        startPreCall();
    });
}

// Funcao exposta pro HTML para selecionar Fundo
window.setVirtualBackground = async (mode, imageUrl = null, btnId = null) => {
    currentVbMode = mode;
    currentVbImage = imageUrl;

    let targetId = btnId;
    if (!targetId) {
        // Fallback
        targetId = mode === 'image' ? (imageUrl?.includes('office') ? 'office-premium' : imageUrl?.includes('studio') ? 'studio-pro' : imageUrl?.includes('loft') ? 'loft' : imageUrl?.includes('living') ? 'living' : 'abstract') : mode;
    } else {
        targetId = targetId.replace('pre-vb-btn-', '').replace('vb-btn-', '');
    }

    // Reset UI styling for all background buttons
    document.querySelectorAll('[id*="vb-btn-"]').forEach(el => {
        el.classList.remove('border-win-accent', 'bg-win-accent/10');
        el.classList.add('border-transparent');
    });

    // Highlight selected across all lists
    document.querySelectorAll(`[id$="vb-btn-${targetId}"]`).forEach(activeEl => {
        activeEl.classList.remove('border-transparent');
        activeEl.classList.add('border-win-accent', 'bg-win-accent/10');
    });

    if (localStream) {
        document.querySelectorAll(`[id$="vb-btn-${targetId}"]`).forEach(btn => btn.classList.add('opacity-50', 'pointer-events-none'));

        try {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                if (mode !== 'none') {
                    processedStream = await window.vbManager.start(localStream, { mode, imageUrl });
                    if (!precallScreen.classList.contains('hidden')) {
                        preVideo.srcObject = processedStream;
                    } else {
                        mainVideo.srcObject = processedStream;
                    }
                    if (rtcClient) await rtcClient.replaceTrack(processedStream.getVideoTracks()[0]);
                } else {
                    window.vbManager.stop();
                    processedStream = localStream;
                    if (!precallScreen.classList.contains('hidden')) {
                        preVideo.srcObject = localStream;
                    } else {
                        mainVideo.srcObject = localStream;
                    }
                    if (rtcClient) await rtcClient.replaceTrack(videoTrack);
                }
            }
        } catch (e) {
            console.error("Falha ao aplicar fundo virtual", e);
        } finally {
            document.querySelectorAll(`[id$="vb-btn-${targetId}"]`).forEach(btn => btn.classList.remove('opacity-50', 'pointer-events-none'));
        }
    }
};

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
    console.log('Receiving remote track from:', targetId, '| Tracks:', stream.getTracks().map(t => t.kind));

    // Guardar referência ao stream remoto
    remoteStreams.set(targetId, stream);

    const remoteContainer = document.getElementById('remote-videos');

    // --- Áudio: sempre tocar ---
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
        console.log('Playing remote audio from:', targetId);
        let audioEl = document.getElementById(`remote-audio-${targetId}`);
        if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = `remote-audio-${targetId}`;
            audioEl.autoplay = true;
            audioEl.playsInline = true;
            document.body.appendChild(audioEl);
        }
        audioEl.srcObject = stream;
        audioEl.play().catch(e => console.error('Erro ao tocar áudio remoto:', e));

        // Iniciar detecção de speaker para este participante
        setupSpeakerAnalyzer(targetId, stream);
    }

    // --- Vídeo: renderizar como PiP ---
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && remoteContainer) {
        console.log('Rendering remote video PiP from:', targetId);
        createOrUpdatePipCard(targetId, stream);

        // Se este participante está pinned, atualizar o vídeo principal
        if (pinnedParticipantId === targetId) {
            const pinnedVideo = document.getElementById('pinnedVideo');
            if (pinnedVideo) pinnedVideo.srcObject = stream;
        }
    }

    // Iniciar detecção global de speaker se ainda não está rodando
    startSpeakerDetection();
}

function createOrUpdatePipCard(targetId, stream) {
    const remoteContainer = document.getElementById('remote-videos');
    if (!remoteContainer) return;

    let card = document.getElementById(`remote-card-${targetId}`);
    if (!card) {
        card = document.createElement('div');
        card.id = `remote-card-${targetId}`;
        card.className = 'glass-panel relative w-28 h-36 sm:w-36 sm:h-24 rounded-2xl overflow-hidden border border-white/10 shadow-2xl transition-all duration-300 hover:scale-105 cursor-pointer hover:border-win-accent flex-shrink-0';
        card.innerHTML = `
            <video autoplay playsinline muted class="w-full h-full object-cover"></video>
            <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1">
                <span class="text-[8px] font-bold uppercase tracking-widest text-white/80" id="remote-name-${targetId}">Participante</span>
            </div>
            <div class="absolute top-1 right-1 bg-black/50 rounded px-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <i class="ph ph-push-pin text-white text-[8px]"></i>
            </div>
        `;
        // Tap/Click para fixar no main
        card.addEventListener('click', () => pinParticipant(targetId));
        remoteContainer.appendChild(card);
    }
    const videoEl = card.querySelector('video');
    videoEl.srcObject = stream;
    return card;
}

// === HIDE/SHOW PiP cards (evitar redundância quando está em fullscreen) ===
function hidePipCard(targetId) {
    if (!targetId) return;
    const card = document.getElementById(`remote-card-${targetId}`);
    if (card) card.classList.add('hidden');
}

function showPipCard(targetId) {
    if (!targetId) return;
    const card = document.getElementById(`remote-card-${targetId}`);
    if (card) card.classList.remove('hidden');
}

// === PIN / UNPIN ===
function pinParticipant(targetId) {
    const stream = remoteStreams.get(targetId);
    if (!stream) return;

    const pinnedVideo = document.getElementById('pinnedVideo');
    const localVideoEl = document.getElementById('localVideo');
    const nameOverlay = document.getElementById('main-video-name');
    const nameText = document.getElementById('main-video-name-text');

    // Se já está pinned no mesmo, desafixar
    if (pinnedParticipantId === targetId) {
        unpinParticipant();
        return;
    }

    // Mostrar card do participante anteriormente em fullscreen (se houver)
    showPipCard(pinnedParticipantId || currentFullscreenId);

    pinnedParticipantId = targetId;
    currentFullscreenId = targetId;

    // Trocar: remoto → main, local → PiP
    pinnedVideo.srcObject = stream;
    pinnedVideo.classList.remove('hidden');
    localVideoEl.classList.add('hidden');

    // Mostrar nome
    const name = remoteNames.get(targetId) || 'Participante';
    if (nameText) nameText.textContent = name;
    if (nameOverlay) nameOverlay.classList.remove('hidden');

    // Criar/mostrar self-pip (meu vídeo local como miniatura)
    ensureSelfPip();

    // Esconder PiP card de quem está em fullscreen
    hidePipCard(targetId);

    // Atualizar visual das cards
    updatePipHighlights();

    console.log('Pinned participant:', targetId, name);
}

function unpinParticipant() {
    const previousId = pinnedParticipantId || currentFullscreenId;
    pinnedParticipantId = null;
    currentFullscreenId = null;

    const pinnedVideo = document.getElementById('pinnedVideo');
    const localVideoEl = document.getElementById('localVideo');
    const nameOverlay = document.getElementById('main-video-name');

    // Voltar: local → main
    if (pinnedVideo) {
        pinnedVideo.classList.add('hidden');
        pinnedVideo.srcObject = null;
    }
    if (localVideoEl) {
        localVideoEl.srcObject = processedStream || localStream; // Garante que a tag de vídeo receba o stream atualizado após sair do PiP
        localVideoEl.classList.remove('hidden');
    }
    if (nameOverlay) nameOverlay.classList.add('hidden');

    // Mostrar PiP card de quem saiu do fullscreen
    showPipCard(previousId);

    // Remover self-pip
    removeSelfPip();

    // Atualizar visuals
    updatePipHighlights();

    console.log('Unpinned. Voltando ao modo auto-speaker.');
}

// Auto-switch para speaker ativo (sem pin manual)
function autoSwitchToSpeaker(speakerId) {
    if (pinnedParticipantId) return; // Se tem pin manual, não auto-switch
    if (!speakerId || speakerId === myId) return;

    const stream = remoteStreams.get(speakerId);
    if (!stream) return;

    const pinnedVideo = document.getElementById('pinnedVideo');
    const localVideoEl = document.getElementById('localVideo');
    const nameOverlay = document.getElementById('main-video-name');
    const nameText = document.getElementById('main-video-name-text');

    // Mostrar card do anterior
    showPipCard(currentFullscreenId);

    currentFullscreenId = speakerId;

    // Trocar para o speaker
    pinnedVideo.srcObject = stream;
    pinnedVideo.classList.remove('hidden');
    localVideoEl.classList.add('hidden');

    const name = remoteNames.get(speakerId) || 'Participante';
    if (nameText) nameText.textContent = name;
    if (nameOverlay) {
        nameOverlay.classList.remove('hidden');
        // Esconder botão de unpin no modo auto
        const unpinBtn = document.getElementById('unpin-btn');
        if (unpinBtn) unpinBtn.classList.add('hidden');
    }

    // Esconder PiP de quem está em fullscreen
    hidePipCard(speakerId);

    ensureSelfPip();
    updatePipHighlights();
}

function autoSwitchBack() {
    if (pinnedParticipantId) return;

    const previousId = currentFullscreenId;
    currentFullscreenId = null;

    const pinnedVideo = document.getElementById('pinnedVideo');
    const localVideoEl = document.getElementById('localVideo');
    const nameOverlay = document.getElementById('main-video-name');

    if (pinnedVideo) {
        pinnedVideo.classList.add('hidden');
        pinnedVideo.srcObject = null;
    }
    if (localVideoEl) {
        localVideoEl.srcObject = processedStream || localStream; // Garante a reconexão da imagem
        localVideoEl.classList.remove('hidden');
    }
    if (nameOverlay) nameOverlay.classList.add('hidden');

    // Mostrar PiP de quem saiu do fullscreen
    showPipCard(previousId);

    removeSelfPip();
    updatePipHighlights();
}

// === SELF PIP (meu vídeo local como miniatura) ===
function ensureSelfPip() {
    const remoteContainer = document.getElementById('remote-videos');
    if (!remoteContainer) return;

    let selfCard = document.getElementById('remote-card-self');
    if (!selfCard) {
        selfCard = document.createElement('div');
        selfCard.id = 'remote-card-self';
        selfCard.className = 'glass-panel relative w-28 h-36 sm:w-36 sm:h-24 rounded-2xl overflow-hidden border border-win-accent/50 shadow-2xl transition-all duration-300 hover:scale-105 cursor-pointer pip-self-card flex-shrink-0';
        selfCard.innerHTML = `
            <video autoplay playsinline muted class="w-full h-full object-cover"></video>
            <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1">
                <span class="text-[8px] font-bold uppercase tracking-widest text-blue-400">Você</span>
            </div>
        `;
        selfCard.addEventListener('click', () => unpinParticipant());
        // Inserir no topo (primeiro item)
        remoteContainer.insertBefore(selfCard, remoteContainer.firstChild);
    }
    const selfVideo = selfCard.querySelector('video');
    selfVideo.srcObject = processedStream || localStream;
}

function removeSelfPip() {
    const selfCard = document.getElementById('remote-card-self');
    if (selfCard) selfCard.remove();
}

// === SPEAKER DETECTION (Web Audio API) ===
function setupSpeakerAnalyzer(targetId, stream) {
    try {
        if (!speakerAudioCtx) {
            speakerAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        // Limpar anterior se existir
        if (speakerAnalyzers.has(targetId)) {
            const old = speakerAnalyzers.get(targetId);
            try { old.source.disconnect(); } catch (e) { }
            speakerAnalyzers.delete(targetId);
        }

        const source = speakerAudioCtx.createMediaStreamSource(stream);
        const analyser = speakerAudioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);
        // NÃO conectar ao destination para evitar eco

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        speakerAnalyzers.set(targetId, {
            analyser, dataArray, source,
            speakFrames: 0,      // consecutive frames above threshold
            silenceFrames: 0,    // consecutive frames below threshold
            levelHistory: []     // rolling buffer for smoothing + noise floor
        });
    } catch (e) {
        console.error('Erro ao criar speaker analyzer:', e);
    }
}

function startSpeakerDetection() {
    if (speakerDetectionInterval) return;

    speakerDetectionInterval = setInterval(() => {
        let loudestId = null;
        let loudestEffectiveLevel = 0;

        speakerAnalyzers.forEach((data, targetId) => {
            data.analyser.getByteFrequencyData(data.dataArray);

            // Raw average across frequency bins
            let sum = 0;
            for (let i = 0; i < data.dataArray.length; i++) sum += data.dataArray[i];
            const rawLevel = sum / data.dataArray.length;

            // Rolling history for smoothing and noise floor
            data.levelHistory.push(rawLevel);
            if (data.levelHistory.length > NOISE_FLOOR_WINDOW) data.levelHistory.shift();

            // Smoothed level: average of last SMOOTH_WINDOW frames
            const smoothWindow = data.levelHistory.slice(-SMOOTH_WINDOW);
            const smoothLevel = smoothWindow.reduce((a, b) => a + b, 0) / smoothWindow.length;

            // Dynamic noise floor: average of the quietest 30% of recent history
            const sorted = [...data.levelHistory].sort((a, b) => a - b);
            const floorCount = Math.max(1, Math.floor(sorted.length * 0.3));
            const noiseFloor = sorted.slice(0, floorCount).reduce((a, b) => a + b, 0) / floorCount;

            // Effective level: how far above the noise floor this person is
            const effectiveLevel = Math.max(0, smoothLevel - noiseFloor * 1.25);

            if (effectiveLevel > SPEAK_THRESHOLD) {
                data.speakFrames++;
                data.silenceFrames = 0;
            } else {
                data.silenceFrames++;
                // Decay speak frames gradually so brief pauses don't reset the counter
                data.speakFrames = Math.max(0, data.speakFrames - 1);
            }

            // Only qualify as confirmed speaker
            if (data.speakFrames >= SPEAK_CONFIRM_FRAMES && effectiveLevel > loudestEffectiveLevel) {
                loudestEffectiveLevel = effectiveLevel;
                loudestId = targetId;
            }
        });

        const now = Date.now();

        if (loudestId && loudestId !== activeSpeakerId && (now - lastSpeakerSwitch) > SPEAKER_SWITCH_COOLDOWN) {
            // New confirmed speaker detected
            activeSpeakerId = loudestId;
            lastSpeakerSwitch = now;
            // Reset silence counter for the new speaker so they hold the slot
            const d = speakerAnalyzers.get(loudestId);
            if (d) d.silenceFrames = 0;
            updatePipHighlights();
            if (!pinnedParticipantId && remoteStreams.size > 1) {
                autoSwitchToSpeaker(loudestId);
            }
        } else if (!loudestId && activeSpeakerId) {
            // Current speaker may be going silent — only release after confirmed silence
            const d = speakerAnalyzers.get(activeSpeakerId);
            if (d && d.silenceFrames >= SILENCE_CONFIRM_FRAMES) {
                activeSpeakerId = null;
                updatePipHighlights();
                if (!pinnedParticipantId && remoteStreams.size > 1) {
                    autoSwitchBack();
                }
            }
        }
    }, 200);
}

function updatePipHighlights() {
    // Limpar highlights de todas as cards
    document.querySelectorAll('[id^="remote-card-"]').forEach(card => {
        card.classList.remove('pip-active-speaker', 'pip-card-pinned');
    });

    // Highlight speaker ativo
    if (activeSpeakerId) {
        const speakerCard = document.getElementById(`remote-card-${activeSpeakerId}`);
        if (speakerCard) speakerCard.classList.add('pip-active-speaker');
    }

    // Highlight card pinado
    if (pinnedParticipantId) {
        const pinnedCard = document.getElementById(`remote-card-${pinnedParticipantId}`);
        if (pinnedCard) pinnedCard.classList.add('pip-card-pinned');

        // Mostrar botão de unpin
        const unpinBtn = document.getElementById('unpin-btn');
        if (unpinBtn) unpinBtn.classList.remove('hidden');
    }
}

// Mapeia nomes dos participantes remotos para suas cards
function updateRemoteNames(participants) {
    if (!participants) return;
    participants.forEach(p => {
        remoteNames.set(p.id, p.name || 'Participante');
        const nameEl = document.getElementById(`remote-name-${p.id}`);
        if (nameEl) nameEl.textContent = p.name || 'Participante';

        // Atualizar nome no main se este participante está em destaque
        if ((pinnedParticipantId === p.id || activeSpeakerId === p.id)) {
            const nameText = document.getElementById('main-video-name-text');
            if (nameText) nameText.textContent = p.name || 'Participante';
        }
    });

    // Limpar cards de participantes que saíram
    const remoteContainer = document.getElementById('remote-videos');
    if (remoteContainer) {
        const currentIds = participants.map(p => p.id);
        Array.from(remoteContainer.children).forEach(card => {
            const cardId = card.id.replace('remote-card-', '');
            if (cardId === 'self') return; // Não limpar self-pip
            if (!currentIds.includes(cardId)) {
                card.remove();
                // Remover áudio e stream
                const audioEl = document.getElementById(`remote-audio-${cardId}`);
                if (audioEl) audioEl.remove();
                remoteStreams.delete(cardId);
                remoteNames.delete(cardId);

                // Limpar speaker analyzer
                if (speakerAnalyzers.has(cardId)) {
                    try { speakerAnalyzers.get(cardId).source.disconnect(); } catch (e) { }
                    speakerAnalyzers.delete(cardId);
                }

                // Se o participante que saiu era o pinned, desafixar
                if (pinnedParticipantId === cardId) unpinParticipant();
                if (activeSpeakerId === cardId) {
                    activeSpeakerId = null;
                    if (!pinnedParticipantId) autoSwitchBack();
                }
            }
        });
    }

    // Se só tem 1 remoto e ninguém pinado, auto-pin nele
    if (remoteStreams.size === 1 && !pinnedParticipantId) {
        const [onlyId] = remoteStreams.keys();
        autoSwitchToSpeaker(onlyId);
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

const BOTTOM_ANIM_STYLES = new Set(['broadcast', 'corporate', 'fade']);

function updateOverlay(action, name, title, style) {
    const overlay = document.getElementById('lower-third');
    const box = document.getElementById('lt-box');
    const nameEl = document.getElementById('ov-display-name');
    const titleEl = document.getElementById('ov-display-title');

    if (!overlay || !nameEl || !titleEl) return;

    const useBottomAnim = BOTTOM_ANIM_STYLES.has(style);
    const animIn = useBottomAnim ? 'overlay-in-bottom' : 'overlay-animated-in';
    const animOut = useBottomAnim ? 'overlay-out-bottom' : 'overlay-animated-out';

    if (action === 'show') {
        if (box && style) box.className = `lt-${style}`;
        nameEl.textContent = name;
        titleEl.textContent = title;
        overlay.classList.remove('overlay-animated-in', 'overlay-animated-out', 'overlay-in-bottom', 'overlay-out-bottom');
        void overlay.offsetWidth;
        overlay.classList.add(animIn);
        overlay.style.opacity = '1';
    } else {
        overlay.classList.remove('overlay-animated-in', 'overlay-animated-out', 'overlay-in-bottom', 'overlay-out-bottom');
        overlay.classList.add(animOut);
        setTimeout(() => {
            if (overlay.classList.contains(animOut)) overlay.style.opacity = '0';
        }, 400);
    }
}

async function setupWebSocket() {
    // Aguardar config estar pronta antes de ler SIGNALING_URL (evita race condition)
    if (window.LYNCRO_CONFIG_READY) await window.LYNCRO_CONFIG_READY;

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
        wsReconnectDelay = 2000; // Reset do backoff após conexão bem-sucedida
        console.log('Conectado ao servidor de sinalização');

        // Feedback visual na tela de espera
        const waitTitle = document.querySelector('#waiting-screen h2');
        if (waitTitle) waitTitle.innerHTML = 'Conectado! <br><span class="text-sm font-normal text-gray-400">Aguardando aprovação do produtor...</span>';

        rtcClient = new WebRTCClient(userName, handleRemoteTrack, handleIceCandidate, null, null, handleDataMessage);

        // Forçar estado do Hardware de acordo com UI para prevenir suspensão do SO na reconexão (ex: 4G->WiFi)
        if (localStream && localStream.getAudioTracks().length > 0) {
            localStream.getAudioTracks()[0].enabled = isMicOn;
        }
        if (localStream && localStream.getVideoTracks().length > 0) {
            localStream.getVideoTracks()[0].enabled = isVideoOn;
        }

        // Garantir que a conexão WebRTC envie a câmera processada com o fundo virtual (se as opções estiverem visíveis)
        rtcClient.setLocalStream(processedStream || localStream);

        const passwordEl = document.getElementById('room-password');
        const password = passwordEl ? passwordEl.value.trim() : null;

        const storedReconnectId = sessionStorage.getItem(`lyncro_reconnect_id_${roomName}`);
        const joinPayload = {
            type: 'join',
            roomId: roomName,
            participant: {
                name: userName,
                role: 'guest',
                companionOf: companionOf,
                ...(storedReconnectId ? { reconnectId: storedReconnectId } : {})
            }
        };

        if (password) joinPayload.password = password;

        ws.send(JSON.stringify(joinPayload));

        // Sincronizar o estado de Mudo e Vídeo com o Host ao re-estabelecer o socket
        ws.send(JSON.stringify({
            type: 'media-control',
            roomId: roomName,
            mediaType: 'audio',
            action: isMicOn ? 'unmute' : 'mute'
        }));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        switch (data.type) {
            case 'init-network':
                myId = data.yourId;
                if (rtcClient) {
                    rtcClient.updateConfig(data.iceServers);
                    // Wifi ressuscitou: matar lixo P2P do estado velho
                    Array.from(rtcClient.peers.keys()).forEach(id => rtcClient.removePeer(id));
                }
                sessionStorage.setItem(`lyncro_reconnect_id_${roomName}`, myId);
                console.log('My ID:', myId);
                break;
            case 'participant-update':
                currentParticipants = data.participants;
                const me = data.participants.find(p => p.id === myId);
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

                // --- Room Status: Contagem + Host Online ---
                updateRoomStatus(data.participants);
                // --- Atualizar nomes e limpar cards PiP de quem saiu ---
                updateRemoteNames(data.participants);

                const hostP = data.participants.find(p => p.role === 'host');
                if (hostP && hostP.status !== 'disconnected') {
                    const banner = document.getElementById('session-banner');
                    if (banner && banner.textContent.includes('desconectou')) {
                        banner.className = 'fixed top-0 inset-x-0 z-[300] flex items-center justify-center gap-3 py-3 px-6 text-sm font-bold bg-green-600/90 text-white backdrop-blur-sm shadow-xl transition-opacity duration-1000';
                        banner.innerHTML = '<i class="ph ph-check-circle text-lg"></i><span>Host reconectado</span>';
                        setTimeout(() => { if (banner) banner.style.opacity = '0'; }, 2000);
                        setTimeout(() => { if (banner) banner.remove(); }, 3000);
                    }
                }
                break;
            case 'chat-typing':
                handleTypingIndicator(data.name, data.isTyping);
                break;
            case 'peer-reconnected':
            case 'participant-left':
                // Alguém desconectou (ou caiu e voltou): limpar o RTC antigo para forçar nova negotiation
                if (data.participantId && rtcClient) {
                    rtcClient.removePeer(data.participantId);
                }
                break;
            case 'host-disconnected':
                // Força descartar a via WebRTC do Host para que possamos aceitar Nova Oferta dele quando voltar.
                console.warn('[Signal] Host desconectou. Removendo peer morto...');
                if (rtcClient) {
                    const hostParticipant = currentParticipants && currentParticipants.find(p => p.role === 'host');
                    if (hostParticipant) rtcClient.removePeer(hostParticipant.id);
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
                    wsIntentionalClose = true;
                    showSessionEndedScreen('Sua entrada não foi aprovada pelo produtor.');
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
                    if (data.action === 'mute') {
                        isHostMuted = true;
                        setMicEnabled(false, true); // force mute
                    } else if (data.action === 'unmute') {
                        isHostMuted = false;
                        setMicEnabled(true, true); // force unmute
                    }
                } else if (data.mediaType === 'video') {
                    setVideoEnabled(!isVideoOn);
                }
                break;
            case 'overlay-control':
                console.log('Overlay control received:', data);
                updateOverlay(data.action, data.name, data.title, data.style);
                break;
            case 'graphic-overlay':
                handleGuestGraphicOverlay(data);
                break;
            case 'prompter-sync':
                if (data.payload) {
                    updatePrompterState(data.payload);
                }
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
            case 'host-disconnected':
                showSessionBanner(
                    window.LYNCRO_I18N ? LYNCRO_I18N.t('host_disconnected') : 'Produtor desconectado. Aguardando reconexão...',
                    'warning'
                );
                break;

            case 'session-ended': {
                wsIntentionalClose = true;
                if (localStream) localStream.getTracks().forEach(t => t.stop());
                if (rtcClient) { rtcClient.peers.forEach(pc => { try { pc.close(); } catch (_) { } }); rtcClient.peers.clear(); }
                if (speakerDetectionInterval) { clearInterval(speakerDetectionInterval); speakerDetectionInterval = null; }
                let endReason;
                if (data.reason === 'host_timeout') {
                    endReason = window.LYNCRO_I18N ? LYNCRO_I18N.t('session_ended_timeout') : 'Conexão do produtor foi perdida.';
                } else if (data.reason === 'time_limit') {
                    endReason = window.LYNCRO_I18N ? LYNCRO_I18N.t('session_ended_time_limit') : 'O limite de 20 minutos do plano gratuito foi atingido.';
                } else {
                    endReason = window.LYNCRO_I18N ? LYNCRO_I18N.t('session_ended_host') : 'O produtor encerrou a sessão.';
                }
                showSessionEndedScreen(endReason);
                break;
            }

            case 'kicked':
                wsIntentionalClose = true;
                if (localStream) localStream.getTracks().forEach(t => t.stop());
                if (rtcClient) { rtcClient.peers.forEach(pc => { try { pc.close(); } catch (_) { } }); rtcClient.peers.clear(); }
                if (speakerDetectionInterval) { clearInterval(speakerDetectionInterval); speakerDetectionInterval = null; }
                showSessionEndedScreen('Você foi removido da sala pelo produtor.');
                break;
            case 'error':
                console.error('SERVER ERROR:', data.message);
                lyncroToast.error(data.message, 8000);
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
        console.error('[WS] Erro na conexão:', err);
        // onclose será chamado logo em seguida — a reconexão acontece lá
    };

    ws.onclose = () => {
        if (wsIntentionalClose) return;
        const delay = wsReconnectDelay;
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
        console.warn(`[WS] Conexão perdida. Reconectando em ${delay / 1000}s...`);
        const waitTitle = document.querySelector('#waiting-screen h2');
        if (waitTitle) waitTitle.innerHTML = `<span class="text-red-500">Conexão Perdida</span> <br><span class="text-sm font-normal text-gray-400">Reconectando em ${delay / 1000}s...</span>`;
        setTimeout(setupWebSocket, delay);
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

// 3. Controles de Mídia
function setMicEnabled(enabled, forceHostOverride = false) {
    if (isHostMuted && !forceHostOverride) {
        // Se o Host mutou rigidamente via sistema e a tentativa é de desmutar localmente
        if (enabled) {
            showToast("O Produtor mutou seu microfone.", "error");
            return;
        }
    }

    isMicOn = enabled;
    if (localStream && localStream.getAudioTracks().length > 0) {
        localStream.getAudioTracks()[0].enabled = isMicOn;
    }

    // UI Update
    const micBtn = document.getElementById('toggleMic');
    micBtn.classList.toggle('bg-red-600/20', !isMicOn);
    micBtn.classList.toggle('text-red-500', !isMicOn);

    // Update icon (show lock if host muted)
    if (isHostMuted) {
        micBtn.innerHTML = `<i class="ph ph-lock text-2xl"></i>`;
        micBtn.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
        micBtn.innerHTML = `<i class="ph ${isMicOn ? 'ph-microphone' : 'ph-microphone-slash'} text-2xl"></i>`;
        micBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }

    // Only broadcast tracking if this was an actual local interaction (not forced by the host's own command overriding)
    if (!forceHostOverride && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'media-status-change',
            roomId: roomName,
            audioMuted: !isMicOn,
            videoMuted: !isVideoOn
        }));
    }
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

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'media-status-change',
            roomId: roomName,
            audioMuted: !isMicOn,
            videoMuted: !isVideoOn
        }));
    }
}

document.getElementById('toggleMic').onclick = () => setMicEnabled(!isMicOn);
document.getElementById('toggleVideo').onclick = () => setVideoEnabled(!isVideoOn);

const switchCamBtn = document.getElementById('switchCamera');
if (switchCamBtn) {
    switchCamBtn.onclick = async () => {
        const tracks = localStream.getTracks();
        tracks.forEach(t => t.stop());

        // Alternar entre user e environment (frente/trás) no mobile
        const currentMode = localStream.getVideoTracks()[0].getSettings().facingMode;
        const newMode = currentMode === 'user' ? 'environment' : 'user';

        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: newMode },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
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
}

const leaveBtn = document.getElementById('leaveRoom');
if (leaveBtn) {
    leaveBtn.onclick = () => {
        // Envia recado de morte explícita
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'leave', roomId: roomName }));
            ws.close();
            wsIntentionalClose = true;
        }
        window.location.href = 'index.html';
    };
}
const unpinBtn = document.getElementById('unpin-btn');
if (unpinBtn) unpinBtn.onclick = () => unpinParticipant();

const pinnedVideoEl = document.getElementById('pinnedVideo');
if (pinnedVideoEl) {
    pinnedVideoEl.addEventListener('click', () => {
        if (pinnedParticipantId) unpinParticipant();
    });
}



// 4. Seleção Avançada de Dispositivos (Chevrons UI) e Settings
const micMenu = document.getElementById('mic-menu');
const camMenu = document.getElementById('cam-menu');
const settingsPanel = document.getElementById('settings-panel');

document.getElementById('btn-mic-menu').onclick = async (e) => {
    e.stopPropagation();
    camMenu.classList.add('hidden');
    if (settingsPanel) settingsPanel.classList.add('hidden');
    micMenu.classList.toggle('hidden');
    if (!micMenu.classList.contains('hidden')) await loadDevices();
};

document.getElementById('btn-cam-menu').onclick = async (e) => {
    e.stopPropagation();
    micMenu.classList.add('hidden');
    if (settingsPanel) settingsPanel.classList.add('hidden');
    camMenu.classList.toggle('hidden');
    if (!camMenu.classList.contains('hidden')) await loadDevices();
};

const toggleSettingsBtn = document.getElementById('toggleSettings');
const closeSettingsBtn = document.getElementById('closeSettings');

if (toggleSettingsBtn && closeSettingsBtn && settingsPanel) {
    toggleSettingsBtn.onclick = (e) => {
        e.stopPropagation();
        micMenu.classList.add('hidden');
        camMenu.classList.add('hidden');
        settingsPanel.classList.remove('hidden');
        settingsPanel.classList.remove('overlay-animated-out');
        settingsPanel.classList.add('overlay-animated-in');
    };

    closeSettingsBtn.onclick = () => {
        settingsPanel.classList.remove('overlay-animated-in');
        settingsPanel.classList.add('overlay-animated-out');
        setTimeout(() => {
            if (settingsPanel.classList.contains('overlay-animated-out')) {
                settingsPanel.classList.add('hidden');
            }
        }, 400);
    };
}

document.addEventListener('click', (e) => {
    micMenu.classList.add('hidden');
    camMenu.classList.add('hidden');

    // Fechar settings clickando fora
    if (settingsPanel && !settingsPanel.classList.contains('hidden') && !settingsPanel.contains(e.target) && (!toggleSettingsBtn || !toggleSettingsBtn.contains(e.target))) {
        settingsPanel.classList.remove('overlay-animated-in');
        settingsPanel.classList.add('overlay-animated-out');
        setTimeout(() => {
            if (settingsPanel.classList.contains('overlay-animated-out')) {
                settingsPanel.classList.add('hidden');
            }
        }, 400);
    }
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
            lyncroToast.error(`Erro no P2P: ${err.message || 'Falha desconhecida'}`);
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
        const currentQuality = localStorage.getItem('lyncro_video_quality') || '720';
        const constraints = {
            audio: kind === 'audio' ? { deviceId: { exact: deviceId } } : false,
            video: kind === 'video' ? buildVideoConstraints(currentQuality, { deviceId: { exact: deviceId } }) : false
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
        lyncroToast.warning('Erro ao trocar de câmera/microfone.');
    }
};

if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
    const accessMsg = document.getElementById('access-msg');
    if (accessMsg) {
        accessMsg.innerHTML = '<b class="text-red-500">⚠️ iPhone detectado via IP:</b> A câmera do iOS só funciona via HTTPS. <br>Use o modo Túnel ou HTTPS para habilitar a câmera.';
    }
}

// Banner temporário de aviso no topo da tela (host desconectou mas ainda no grace period)
function showSessionBanner(message, type = 'warning') {
    const existing = document.getElementById('session-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'session-banner';
    banner.className = `fixed top-0 inset-x-0 z-[300] flex items-center justify-center gap-3 py-3 px-6 text-sm font-bold ${type === 'warning' ? 'bg-yellow-600/90 text-white' : 'bg-red-600/90 text-white'
        } backdrop-blur-sm shadow-xl`;
    banner.innerHTML = `<i class="ph ph-warning text-lg"></i><span>${message}</span>`;
    document.body.appendChild(banner);
}

// Tela de encerramento de sessão (host encerrou ou usuário foi removido)
function showSessionEndedScreen(reason) {
    // Remove banner de aviso se existir
    const banner = document.getElementById('session-banner');
    if (banner) banner.remove();

    // Oculta tela de chamada
    const callScreen = document.getElementById('call-screen');
    if (callScreen) callScreen.classList.add('hidden');

    // Cria overlay de encerramento
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[400] bg-win-bg flex flex-col items-center justify-center gap-6 p-8 text-center';
    overlay.innerHTML = `
        <div class="w-20 h-20 rounded-full bg-red-600/20 border border-red-500/30 flex items-center justify-center mb-2">
            <i class="ph ph-phone-disconnect text-4xl text-red-400"></i>
        </div>
        <h2 class="text-2xl font-bold text-white tracking-tight">Sessão Encerrada</h2>
        <p class="text-sm text-gray-400 max-w-xs">${reason}</p>
        <button onclick="window.location.href='index.html'"
            class="mt-4 bg-win-accent hover:bg-win-accent/80 text-white font-bold px-8 py-3 rounded-win text-sm uppercase tracking-widest transition-all active:scale-95">
            Voltar ao Início
        </button>
    `;
    document.body.appendChild(overlay);
}

function showToast(message, type = "info") {
    const toast = document.createElement('div');
    toast.className = `fixed bottom-6 right-6 px-4 py-2 rounded-win shadow-2xl border border-win-border text-xs z-50 transition-all font-semibold`;
    const colors = { success: 'bg-green-600/90 text-white', error: 'bg-red-600/90 text-white', info: 'bg-win-accent/90 text-white' };
    toast.classList.add(...(colors[type] || colors.info).split(' '));
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 3000);
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

// Chat, Typing Indicator e Room Status movidos para guest-chat.js

// --- Câmera Secundária (QR Code Companion) ---
const openMobileBtn = document.getElementById('openMobileCam');
const qrModal = document.getElementById('qr-modal');
const closeQrModal = document.getElementById('close-qr-modal');
const qrContainer = document.getElementById('qrcode-container');
let qrcodeInstance = null;

if (openMobileBtn && qrModal && closeQrModal && qrContainer) {
    openMobileBtn.addEventListener('click', () => {
        qrModal.classList.remove('hidden');

        // Gerar QR Code usando userName (sempre disponível) como identificador companion
        if (!qrcodeInstance) {
            qrContainer.innerHTML = ''; // Limpar container
            const baseUrl = window.location.origin;
            const qrUrl = new URL(`${baseUrl}/guest.html`);
            qrUrl.searchParams.set('room', roomName);
            qrUrl.searchParams.set('companionOf', myId || userName);
            qrUrl.searchParams.set('name', userName + ' (Cam 2)');

            try {
                qrcodeInstance = new QRCode(qrContainer, {
                    text: qrUrl.toString(),
                    width: 200,
                    height: 200,
                    colorDark: "#000000",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.H
                });
            } catch (err) {
                console.error('Erro ao gerar QR Code:', err);
                qrContainer.innerHTML = '<p style="color:red;font-size:12px;">Erro ao gerar QR Code</p>';
            }
        }
    });

    closeQrModal.addEventListener('click', () => {
        qrModal.classList.add('hidden');
    });

    // Fechar ao clicar fora do modal
    qrModal.addEventListener('click', (e) => {
        if (e.target === qrModal) {
            qrModal.classList.add('hidden');
        }
    });
}

// Se EU SOU o celular da Câmera Secundária, escondo coisas desnecessárias para poupar processamento
if (companionOf) {
    const toggleChat = document.getElementById('toggleChat');
    const shareScreenBtn = document.getElementById('btn-share-screen');
    if (toggleChat) toggleChat.classList.add('hidden');
    if (shareScreenBtn) shareScreenBtn.classList.add('hidden');

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

// ===== COMPARTILHAMENTO DE TELA ======
window.toggleScreenShare = async () => {
    if (isScreenSharing) {
        // Parar compartilhamento
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }
        isScreenSharing = false;

        // Reverter para câmera
        const activeStream = processedStream || localStream;
        if (activeStream && rtcClient) {
            const videoTrack = activeStream.getVideoTracks()[0];
            if (videoTrack) {
                rtcClient.replaceTrack(videoTrack).catch(e => console.error(e));
            }
        }

        // Atualizar preview local
        const localVideoEl = document.getElementById('localVideo');
        if (localVideoEl) {
            localVideoEl.srcObject = activeStream;
            localVideoEl.style.objectFit = 'cover';
        }

        const btn = document.getElementById('btn-share-screen');
        if (btn) {
            btn.classList.remove('bg-win-accent', 'text-white');
            btn.classList.add('text-gray-400', 'bg-win-surface/80');
            btn.innerHTML = `<i class="ph ph-screencast text-2xl text-gray-400 group-hover:text-white transition-colors"></i>`;
        }

    } else {
        // Iniciar compartilhamento
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            isScreenSharing = true;

            const screenTrack = screenStream.getVideoTracks()[0];

            // Reverter automaticamente se usuário parar pelo navegador
            screenTrack.onended = () => {
                if (isScreenSharing) window.toggleScreenShare();
            };

            // Atualizar peers P2P
            if (rtcClient) {
                rtcClient.replaceTrack(screenTrack).catch(e => console.error("Falha ao substituir trilha no rtcClient", e));
            }

            // Atualizar preview local (sem cortes com 'contain')
            const localVideoEl = document.getElementById('localVideo');
            if (localVideoEl) {
                localVideoEl.srcObject = screenStream;
                localVideoEl.style.objectFit = 'contain';
            }

            const btn = document.getElementById('btn-share-screen');
            if (btn) {
                btn.classList.add('bg-win-accent', 'text-white');
                btn.classList.remove('text-gray-400', 'bg-win-surface/80');
                btn.innerHTML = `<i class="ph ph-screencast text-2xl"></i>`;
            }

            if (currentVbMode !== 'none') {
                showToast('Fundo Virtual oculto na tela compartilhada', 'info');
            }

        } catch (e) {
            console.error("Erro ao compartilhar tela:", e);
        }
    }
};

// ── Teleprompter (Guest Engine) ──────────────────────────────────────────────
let prompterActive = false;
let currentPrompterSpeed = 5; // 1-10
let isPrompterPlaying = false;
let prompterScrollY = 0;
let lastFrameTime = 0;
let lastRestartToken = 0;
let prompterAnimId = null;

let isPrompterPinned = false;
let localPrompterSizeDeficit = 0;
let localPrompterSpeedDeficit = 0;
let lastPrompterStateCache = null;

function updatePrompterState(state, keepLocalPlayState = false) {
    lastPrompterStateCache = state;
    const container = document.getElementById('prompter-container');
    const textView = document.getElementById('prompter-scroll-view');
    const textContent = document.getElementById('prompter-text-content');

    if (!container || !textView || !textContent) return;

    // Verificar se a mensagem é para mim
    if (state.targetId && state.targetId !== 'all' && state.targetId !== myId) {
        // Não é pra mim. Esconder sem marcar explicitamente que "eu fechei" pra não bugar se o host mandar de novo depois.
        container.classList.add('hidden');
        const controls = document.getElementById('prompter-local-controls');
        if (controls) controls.style.display = 'none';
        prompterActive = false;
        isPrompterPlaying = false;
        return;
    }

    // Se o texto for limpo e o prompter estiver parado, esconder a janela
    if (!state.text || state.text.trim() === '') {
        container.classList.add('hidden');
        const controls = document.getElementById('prompter-local-controls');
        if (controls) controls.style.display = 'none';
        prompterActive = false;
        isPrompterPlaying = false;
        prompterScrollY = 0;
        textView.style.transform = `translateY(0px)`;
        return;
    }

    // Tratamento de Restart (Mesmo Texto)
    let wasRestarted = false;
    if (state.restartToken && state.restartToken !== lastRestartToken) {
        lastRestartToken = state.restartToken;
        wasRestarted = true;
        prompterScrollY = 0;
        textView.style.transform = `translateY(0px)`;
        container.classList.remove('hidden', 'guest-closed');
        const controls = document.getElementById('prompter-local-controls');
        if (controls) controls.style.display = 'flex';
        container.style.opacity = '1';
        prompterActive = true;
    } else {
        // Checar se o convidado fechou manualmente. Se fechou, não abre de novo automático a não ser que o host mude o texto inteiro.
        if (container.classList.contains('guest-closed') && textContent.textContent === state.text) {
            // Ignora atualizações direcionadas a estado se ele ativamente escondeu
            return;
        }

        if (!prompterActive) {
            container.classList.remove('hidden');
            container.classList.remove('guest-closed');
            const controls = document.getElementById('prompter-local-controls');
            if (controls) controls.style.display = 'flex';
            container.style.opacity = '1';
            prompterActive = true;
            if (!prompterAnimId) {
                lastFrameTime = performance.now();
                prompterAnimId = requestAnimationFrame(prompterAnimationLoop);
            }
        }
    }

    // Update text
    if (textContent.textContent !== state.text) {
        textContent.textContent = state.text;
        // Text changed significantly => reset scroll to top
        if (!wasRestarted) {
            prompterScrollY = 0;
            textView.style.transform = `translateY(0px)`;
        }
        container.classList.remove('guest-closed'); // Host forced new text, re-open it
        container.style.opacity = '1';
        const controls = document.getElementById('prompter-local-controls');
        if (controls) {
            controls.style.display = 'flex';
            controls.style.opacity = '1';
        }
        if (!prompterActive) {
            container.classList.remove('hidden');
            prompterActive = true;
            if (!prompterAnimId) {
                lastFrameTime = performance.now();
                prompterAnimId = requestAnimationFrame(prompterAnimationLoop);
            }
        }
    }

    // Update Speed, Playback Status, Size and Margin
    currentPrompterSpeed = Math.max(1, Math.min(10, (state.speed || 5) + localPrompterSpeedDeficit));

    // Ignorar sobrescrita do play status se a chamada veio do redimensionamento do próprio convidado
    if (!keepLocalPlayState) {
        isPrompterPlaying = !!state.isPlaying;
    }

    // Se foi restart e já deve rolar, certifique-se que o animLoop está andando
    if (wasRestarted && prompterActive && !prompterAnimId) {
        lastFrameTime = performance.now();
        prompterAnimId = requestAnimationFrame(prompterAnimationLoop);
    }

    // Aplicar Margem (padding horizontal do container de rolagem)
    // Map de 0 a 40 (O slider vai de 0 a 40, representa porcentagem da tela)
    const marginPct = (state.margin !== undefined ? state.margin : 20);
    // Mas para manter centrado e legal, dividimos por 2 e aplicamos nas laterais
    textContent.style.padding = `0 ${marginPct}%`;

    // Aplicar Tamanho da Fonte dinâmico (PC vs Mobile)
    let baseSizePx = state.size || 60;
    // Se a tela for pequena (celular), aplica a proporção solicitada de 50px base para cada 60px do host
    if (window.innerWidth <= 768) {
        baseSizePx = Math.round(baseSizePx * (50 / 60));
    }
    const finalSizePx = Math.max(15, baseSizePx + localPrompterSizeDeficit);
    textContent.style.fontSize = `${finalSizePx}px`;
}

function prompterAnimationLoop(currentTime) {
    if (!prompterActive) {
        prompterAnimId = null;
        return;
    }

    const deltaTime = currentTime - lastFrameTime;
    lastFrameTime = currentTime;

    if (isPrompterPlaying) {
        // Velocidade baseada no slider de 1 a 10.
        // ex: speed=5 move X pixels por segundo.
        const pixelsPerSecond = currentPrompterSpeed * 15;
        const deltaY = (pixelsPerSecond * deltaTime) / 1000;

        prompterScrollY -= deltaY;

        const textView = document.getElementById('prompter-scroll-view');
        const textContent = document.getElementById('prompter-text-content');

        if (textView && textContent) {
            textView.style.transform = `translateY(${prompterScrollY}px)`;

            // Auto fade-out quando termina de passar o texto
            // Altura do container visível: container.offsetHeight (que é 45vh).
            // O textView tem padding-top: 22vh.
            const containerHeight = document.documentElement.clientHeight * 0.45;
            const textHeight = textContent.getBoundingClientRect().height;
            // Considerando o padding-top de 22vh (~metade da altura do container)
            // O texto sai totalmente de tela quando subiu a sua própria altura + o padding superior
            const maxScroll = (containerHeight / 2) + textHeight + 60; // Margem extra de safety

            if (prompterScrollY < -maxScroll) {
                // Chegou exatamente ao fim
                const container = document.getElementById('prompter-container');
                isPrompterPlaying = false;

                // Avisa o host
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'prompter-finished', roomId: roomName }));
                }

                if (container && !isPrompterPinned) {
                    container.style.opacity = '0'; // Dispara a transição css
                    const controls = document.getElementById('prompter-local-controls');
                    if (controls) controls.style.opacity = '0';

                    setTimeout(() => {
                        if (container.style.opacity === '0') closeGuestPrompter();
                        container.style.opacity = ''; // Reseta pro inline limpo
                        if (controls) controls.style.opacity = '';
                    }, 500);
                }
            }
        }
    }
    prompterAnimId = requestAnimationFrame(prompterAnimationLoop);
}

// Botão de fechar do convidado
window.closeGuestPrompter = () => {
    const container = document.getElementById('prompter-container');
    const controls = document.getElementById('prompter-local-controls');
    if (container) {
        container.classList.add('hidden');
        container.classList.add('guest-closed');
        if (controls) controls.style.display = 'none';

        prompterActive = false;
        isPrompterPlaying = false;

        // Reset local overrides e pin pra proxima chamada
        isPrompterPinned = false;
        localPrompterSizeDeficit = 0;
        localPrompterSpeedDeficit = 0;

        const ico = document.getElementById('ico-prompter-pin');
        const btn = document.getElementById('btn-prompter-pin');
        if (ico && btn) {
            ico.classList.replace('ph-push-pin-fill', 'ph-push-pin');
            btn.classList.remove('bg-win-accent', 'text-white', 'opacity-100');
            btn.classList.add('bg-black/20', 'text-white/50');
        }
    }
};

window.togglePrompterPin = () => {
    isPrompterPinned = !isPrompterPinned;
    const ico = document.getElementById('ico-prompter-pin');
    const btn = document.getElementById('btn-prompter-pin');
    if (ico && btn) {
        if (isPrompterPinned) {
            ico.classList.replace('ph-push-pin', 'ph-push-pin-fill');
            btn.classList.add('bg-win-accent', 'text-white', 'opacity-100');
            btn.classList.remove('bg-black/20', 'text-white/50');
        } else {
            ico.classList.replace('ph-push-pin-fill', 'ph-push-pin');
            btn.classList.remove('bg-win-accent', 'text-white', 'opacity-100');
            btn.classList.add('bg-black/20', 'text-white/50');

            // Se desalfinetou e já estava rolando no vazio (terminado), então fecha.
            if (!isPrompterPlaying) {
                const containerHeight = document.documentElement.clientHeight * 0.45;
                const textContent = document.getElementById('prompter-text-content');
                if (textContent) {
                    const textHeight = textContent.getBoundingClientRect().height;
                    const maxScroll = (containerHeight / 2) + textHeight + 60;
                    if (prompterScrollY <= -maxScroll) {
                        closeGuestPrompter();
                    }
                }
            }
        }
    }
};

window.changeLocalPrompterSize = (delta) => {
    localPrompterSizeDeficit += delta;
    if (lastPrompterStateCache) updatePrompterState(lastPrompterStateCache, true);
};

window.changeLocalPrompterSpeed = (delta) => {
    localPrompterSpeedDeficit += delta;
    if (lastPrompterStateCache) updatePrompterState(lastPrompterStateCache, true);
};

// ── Controles de Toque e Arraste do Convidado ───────────────────────────────
let isPrompterDragging = false;
let prompterDragStartY = 0;
let prompterDragStartScrollY = 0;
let prompterHasMoved = false;

document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('prompter-container');
    if (container) {
        container.style.cursor = 'grab';
        container.style.touchAction = 'none'; // Evita scroll natural da página no mobile

        container.addEventListener('pointerdown', (e) => {
            if (!prompterActive) return;
            // Ignorar se clicou no botão de fechar
            if (e.target.closest('button')) return;

            isPrompterDragging = true;
            prompterHasMoved = false;
            prompterDragStartY = e.clientY;
            prompterDragStartScrollY = prompterScrollY;
            container.style.cursor = 'grabbing';
            // Impede seleção de texto enquanto arrasta
            e.preventDefault();
        });

        window.addEventListener('pointermove', (e) => {
            if (!isPrompterDragging || !prompterActive) return;

            const deltaY = e.clientY - prompterDragStartY;
            if (Math.abs(deltaY) > 5) {
                prompterHasMoved = true;
            }

            if (prompterHasMoved) {
                prompterScrollY = prompterDragStartScrollY + deltaY;
                isPrompterPlaying = false; // Pausa o motor automático

                const textView = document.getElementById('prompter-scroll-view');
                if (textView) {
                    textView.style.transform = `translateY(${prompterScrollY}px)`;
                }
            }
        });

        window.addEventListener('pointerup', (e) => {
            if (!isPrompterDragging) return;
            isPrompterDragging = false;
            if (container) container.style.cursor = 'grab';

            if (!prompterHasMoved) {
                // Foi apenas um clique, sem arrastar -> Toggle Play/Pause
                isPrompterPlaying = !isPrompterPlaying;

                // Forçar acordar animação se estava dormente
                if (isPrompterPlaying && !prompterAnimId && prompterActive) {
                    lastFrameTime = performance.now();
                    prompterAnimId = requestAnimationFrame(prompterAnimationLoop);
                }
            }
        });

        window.addEventListener('pointercancel', (e) => {
            if (!isPrompterDragging) return;
            isPrompterDragging = false;
            if (container) container.style.cursor = 'grab';
        });
    }
});

// ── More Menu (toolbar do convidado) ──────────────────────────────────────────
window.toggleMoreMenu = function () {
    const menu = document.getElementById('more-menu');
    if (menu) menu.classList.toggle('hidden');
};

window.closeMoreMenu = function () {
    const menu = document.getElementById('more-menu');
    if (menu) menu.classList.add('hidden');
};

document.addEventListener('click', (e) => {
    const wrap = document.getElementById('more-menu-wrap');
    if (wrap && !wrap.contains(e.target)) closeMoreMenu();
});

// ── Graphic Overlay: QR Code para convidados ──────────────────────────────────
function handleGuestGraphicOverlay(data) {
    const qr = document.getElementById('go-qr-guest');
    if (!qr) return;

    if (data.action === 'reset' || (data.action === 'qr' && !data.qrVisible)) {
        qr.style.opacity = '0';
        setTimeout(() => { qr.style.display = 'none'; }, 420);
        return;
    }

    // Logo: guests não exibem logo — apenas QR quando showGuests=true
    if (data.action !== 'qr') return;
    if (!data.qrShowGuests) {
        qr.style.opacity = '0';
        setTimeout(() => { qr.style.display = 'none'; }, 420);
        return;
    }

    const sizePx = Math.round(120 * (data.qrScale || 1));
    qr.innerHTML = '';
    if (typeof QRCode !== 'undefined' && data.qrUrl) {
        new QRCode(qr, { text: data.qrUrl, width: sizePx, height: sizePx, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
    }
    // Position
    const x = data.qrX ?? 96;
    const y = data.qrY ?? 96;
    qr.style.left  = x + '%';
    qr.style.top   = y + '%';
    qr.style.transform = `translate(-${x > 50 ? '100' : '0'}%, -${y > 50 ? '100' : '0'}%)`;
    qr.style.display = 'block';
    requestAnimationFrame(() => { qr.style.opacity = '1'; });
}
