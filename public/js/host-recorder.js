/**
 * Lyncro — Canvas Compositor + MediaRecorder
 * Renders the current room layout onto a 1920×1080 canvas and records it.
 * Exports: window.LYNCRO_RECORDER.start(), .stop(), .isRecording()
 */
(function () {
    const CANVAS_W = 1920;
    const CANVAS_H = 1080;
    const FPS = 30;
    const MIME_PREFERENCE = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
    ];

    let mediaRecorder = null;
    let chunks = [];
    let animFrameId = null;
    let audioCtx = null;
    let mixDest = null;
    let audioSources = [];
    let canvas = null;
    let ctx = null;
    let startTime = null;
    let timerInterval = null;

    let btnEl = null;
    let badgeEl = null;
    let timerEl = null;

    // ── UI ───────────────────────────────────────────────────────────────────
    function updateUI(recording) {
        if (!btnEl) return;
        if (recording) {
            btnEl.classList.add('recording-active');
            btnEl.querySelector('.rec-label').textContent = 'Parar';
            if (badgeEl) badgeEl.classList.remove('hidden');
        } else {
            btnEl.classList.remove('recording-active');
            btnEl.querySelector('.rec-label').textContent = 'Gravar';
            if (badgeEl) badgeEl.classList.add('hidden');
            if (timerEl) timerEl.textContent = '00:00';
        }
    }

    function tickTimer() {
        if (!startTime || !timerEl) return;
        const s = Math.floor((Date.now() - startTime) / 1000);
        timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }

    // ── Stream collection ─────────────────────────────────────────────────────
    function collectVideoElements() {
        const participants = window.lyncroParticipants || [];
        const result = [];
        const localCard = document.getElementById('video-card-local');
        if (localCard) {
            const v = localCard.querySelector('video');
            if (v && v.srcObject) {
                const nameInput = document.getElementById('host-display-name');
                result.push({ el: v, name: nameInput ? nameInput.value : 'Host', role: 'host' });
            }
        }
        document.querySelectorAll('[id^="video-card-"]').forEach(card => {
            if (card.id === 'video-card-local') return;
            const v = card.querySelector('video');
            if (v && v.srcObject) {
                const pid = card.id.replace('video-card-', '');
                const p = participants.find(p => p.id === pid);
                result.push({ el: v, name: p ? p.name : 'Convidado', role: p ? p.role : 'guest' });
            }
        });
        return result;
    }

    // ── Layout calculator (mirrors grid.js + grid.html logic) ────────────────
    function computeLayout(n) {
        const layoutId = (window.currentRoomSettings && window.currentRoomSettings.layout) || 'dynamic-cards';

        if (n === 0) return [];
        if (n === 1) return [{ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H, cover: true }];

        switch (layoutId) {

            case 'cnn-split': {
                // 50/50 side by side; extra participants share right half via equal cols
                const half = CANVAS_W / 2;
                if (n === 2) return [
                    { x: 0,       y: 0, w: half - 1, h: CANVAS_H, cover: true },
                    { x: half + 1, y: 0, w: half - 1, h: CANVAS_H, cover: true },
                ];
                // fallthrough to auto-grid for 3+ in cnn-split
                return computeAutoGrid(n);
            }

            case 'cnn-vertical': {
                const gapPx = 2;
                let cols, rows;
                if (n <= 5)      { cols = n; rows = 1; }
                else if (n <= 6) { cols = 3; rows = 2; }
                else if (n <= 8) { cols = 4; rows = 2; }
                else if (n <= 9) { cols = 3; rows = 3; }
                else             { cols = 5; rows = Math.ceil(n / 5); }

                const cellW_v = (CANVAS_W - (cols - 1) * gapPx) / cols;
                let cellH_v = cellW_v * 16 / 9;
                const maxH_v = (CANVAS_H - (rows - 1) * gapPx) / rows;
                if (cellH_v > maxH_v) cellH_v = maxH_v;
                const startX_v = (CANVAS_W - (cols * cellW_v + (cols - 1) * gapPx)) / 2;
                const startY_v = (CANVAS_H - (rows * cellH_v + (rows - 1) * gapPx)) / 2;

                return Array.from({ length: n }, (_, i) => ({
                    x: startX_v + (i % cols) * (cellW_v + gapPx),
                    y: startY_v + Math.floor(i / cols) * (cellH_v + gapPx),
                    w: cellW_v, h: cellH_v, cover: true,
                }));
            }

            case 'portrait-cards': {
                // Height-first: todos os cards cabem na tela; espaço lateral é livre
                let cols, rows;
                if (n <= 5)      { cols = n; rows = 1; }
                else if (n <= 6) { cols = 3; rows = 2; }
                else if (n <= 8) { cols = 4; rows = 2; }
                else if (n <= 9) { cols = 3; rows = 3; }
                else             { cols = 5; rows = Math.ceil(n / 5); }

                const gapPx = 16;
                const padPx = 16;
                const availH_pc = CANVAS_H - padPx * 2 - (rows - 1) * gapPx;
                const cellH_pc  = Math.round(availH_pc / rows);
                const cellW_pc  = Math.round(cellH_pc * 9 / 16);
                const totalW_pc = cols * cellW_pc + (cols - 1) * gapPx;
                const startX_pc = Math.round((CANVAS_W - totalW_pc) / 2);

                return Array.from({ length: n }, (_, i) => ({
                    x: startX_pc + (i % cols) * (cellW_pc + gapPx),
                    y: padPx      + Math.floor(i / cols) * (cellH_pc + gapPx),
                    w: cellW_pc, h: cellH_pc, rounded: 16, cover: true,
                }));
            }

            case 'speaker-highlight': {
                // Destaque GRANDE na esquerda + miniaturas à direita.
                // AR do destaque: wide(16:9) → square(1:1) → portrait(9:16) conforme colunas crescem.
                if (n === 1) return [{ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H, cover: true }];

                const thumbCount = n - 1;
                const padPx    = 8;
                const gapMain  = 8;
                const gapThumb = 8;

                let thumbCols;
                if (thumbCount <= 4)      thumbCols = 1;
                else if (thumbCount <= 8) thumbCols = 2;
                else                      thumbCols = 3;

                let featuredAR;
                if (thumbCols === 1)      featuredAR = 16 / 9;
                else if (thumbCols === 2) featuredAR = 1;
                else                      featuredAR = 9 / 16;

                const contW    = CANVAS_W - padPx * 2;
                const contH    = CANVAS_H - padPx * 2;
                const featH    = contH;
                const featW    = Math.round(featH * featuredAR);
                const sideW    = contW - featW - gapMain;
                const thumbW   = Math.max(80, Math.floor((sideW - gapThumb * (thumbCols - 1)) / thumbCols));
                const thumbRows = Math.ceil(thumbCount / thumbCols);
                const thumbH   = Math.max(60, Math.floor((contH - gapThumb * (thumbRows - 1)) / thumbRows));
                const sideX    = padPx + featW + gapMain;

                const cells = [{ x: padPx, y: padPx, w: featW, h: featH, cover: true, rounded: 12 }];
                for (let i = 0; i < thumbCount; i++) {
                    cells.push({
                        x: sideX + (i % thumbCols) * (thumbW + gapThumb),
                        y: padPx  + Math.floor(i / thumbCols) * (thumbH + gapThumb),
                        w: thumbW, h: thumbH, cover: true, rounded: 10,
                    });
                }
                return cells;
            }

            case 'dynamic-cards': {
                const cols_dc = Math.ceil(Math.sqrt(n));
                const rows_dc = Math.ceil(n / cols_dc);
                const gapPx_dc = 12;
                const padPx_dc = 12;
                const availW_dc = CANVAS_W - padPx_dc * 2 - gapPx_dc * (cols_dc - 1);
                const availH_dc = CANVAS_H - padPx_dc * 2 - gapPx_dc * (rows_dc - 1);
                const cardW_dc = Math.round(availW_dc / cols_dc);
                const cardH_dc = Math.round(availH_dc / rows_dc);
                const totalRowW_dc = cols_dc * cardW_dc + (cols_dc - 1) * gapPx_dc;
                const startX_dc = Math.round((CANVAS_W - totalRowW_dc) / 2);
                return Array.from({ length: n }, (_, i) => ({
                    x: startX_dc + (i % cols_dc) * (cardW_dc + gapPx_dc),
                    y: padPx_dc  + Math.floor(i / cols_dc) * (cardH_dc + gapPx_dc),
                    w: cardW_dc, h: cardH_dc, rounded: 16, cover: true,
                }));
            }

            default:
                return computeAutoGrid(n);
        }
    }

    function computeAutoGrid(n) {
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const cellW = CANVAS_W / cols;
        const cellH = CANVAS_H / rows;
        return Array.from({ length: n }, (_, i) => ({
            x: (i % cols) * cellW,
            y: Math.floor(i / cols) * cellH,
            w: cellW,
            h: cellH,
            cover: false,
        }));
    }

    // ── Canvas drawing ────────────────────────────────────────────────────────
    function roundedRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function drawBadge(name, role, x, y, w, h) {
        const fontSize = Math.max(14, Math.min(26, h * 0.042));
        const label = name || 'Convidado';
        const isHost = role === 'host';

        ctx.font = `bold ${fontSize}px Inter, system-ui, sans-serif`;
        const padX = 14, padY = 7;
        const starW = isHost ? fontSize + 6 : 0;
        const textW = ctx.measureText(label).width;
        const bw = padX * 2 + starW + textW;
        const bh = fontSize + padY * 2;
        const bx = x + 12;
        const by = y + h - 12 - bh;

        // Badge background
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        roundedRect(bx, by, bw, bh, 7);
        ctx.fill();

        // Star for host
        if (isHost) {
            ctx.fillStyle = '#f59e0b';
            ctx.font = `${fontSize * 0.88}px system-ui`;
            ctx.fillText('★', bx + padX, by + padY + fontSize * 0.82);
        }

        // Name text
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.fillText(label, bx + padX + starW, by + padY + fontSize * 0.85);
    }

    function drawFrame(items, layout) {
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        const labelsOn = window.lyncroShowLabels !== false;

        items.forEach((item, i) => {
            if (i >= layout.length) return;
            const { x, y, w, h, cover = false, rounded = 0 } = layout[i];
            const v = item.el || item; // backwards compat

            if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) {
                ctx.fillStyle = '#1a1a22';
                if (rounded > 0) {
                    ctx.save(); roundedRect(x, y, w, h, rounded); ctx.fill(); ctx.restore();
                } else {
                    ctx.fillRect(x, y, w, h);
                }
                return;
            }

            let sx = 0, sy = 0, sw = v.videoWidth, sh = v.videoHeight;
            let dx = x, dy = y, dw = w, dh = h;
            const vAR = v.videoWidth / v.videoHeight;
            const cAR = w / h;

            if (cover) {
                if (vAR > cAR) { sw = v.videoHeight * cAR; sx = (v.videoWidth - sw) / 2; }
                else           { sh = v.videoWidth / cAR;  sy = (v.videoHeight - sh) / 2; }
            } else {
                if (vAR > cAR) { dh = w / vAR; dy = y + (h - dh) / 2; }
                else           { dw = h * vAR; dx = x + (w - dw) / 2; }
            }

            if (rounded > 0) { ctx.save(); roundedRect(x, y, w, h, rounded); ctx.clip(); }
            ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh);
            if (rounded > 0) ctx.restore();

            if (labelsOn && item.name) drawBadge(item.name, item.role, x, y, w, h);
        });

        // Marca d'água em gravações do plano FREE — "Lyncro.LIVE"
        const planIsFree = !window.LYNCRO_PLAN || !window.LYNCRO_PLAN.isPro();
        if (planIsFree) {
            const mainSize  = Math.round(CANVAS_H * 0.048);
            const liveSize  = Math.round(mainSize * 0.52);
            const x = CANVAS_W - 28;
            const y = CANVAS_H - 22;
            ctx.save();
            ctx.globalAlpha = 0.24;
            ctx.textAlign    = 'right';
            ctx.textBaseline = 'bottom';
            // Draw ".LIVE" first (smaller, measured to offset main text)
            ctx.font = `900 ${liveSize}px Inter, system-ui, sans-serif`;
            const liveW = ctx.measureText('.LIVE').width;
            ctx.fillStyle = '#ffffff';
            ctx.fillText('.LIVE', x, y - Math.round(mainSize * 0.28));
            // Draw "Lyncro" (larger, italic, to the left of .LIVE)
            ctx.font = `900 italic ${mainSize}px Inter, system-ui, sans-serif`;
            ctx.fillText('Lyncro', x - liveW, y);
            ctx.restore();
        }
    }

    function startCompositor(items) {
        canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        ctx = canvas.getContext('2d');

        function loop() {
            drawFrame(items, computeLayout(items.length));
            animFrameId = requestAnimationFrame(loop);
        }
        loop();

        return canvas.captureStream(FPS);
    }

    function stopCompositor() {
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        canvas = null;
        ctx = null;
    }

    // ── Audio mixer ───────────────────────────────────────────────────────────
    function buildAudioMix(videoEls) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            mixDest = audioCtx.createMediaStreamDestination();
            videoEls.forEach(v => {
                const stream = v.srcObject;
                if (!stream) return;
                const audioTracks = stream.getAudioTracks();
                if (audioTracks.length === 0) return;
                try {
                    const src = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
                    src.connect(mixDest);
                    audioSources.push(src);
                } catch (e) { console.warn('[Recorder] Audio source error:', e); }
            });
            return mixDest.stream;
        } catch (e) {
            console.error('[Recorder] AudioContext error:', e);
            return null;
        }
    }

    function teardownAudio() {
        audioSources.forEach(s => { try { s.disconnect(); } catch {} });
        audioSources = [];
        if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
        mixDest = null;
    }

    // ── MediaRecorder ─────────────────────────────────────────────────────────
    function chooseMime() {
        return MIME_PREFERENCE.find(m => MediaRecorder.isTypeSupported(m)) || '';
    }

    function download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function start() {
        if (mediaRecorder) return;

        const items = collectVideoElements();
        if (items.length === 0) {
            showToast && showToast('Nenhum vídeo disponível para gravar.', 'error');
            return;
        }

        const videoStream = startCompositor(items);
        const audioStream = buildAudioMix(items.map(i => i.el || i));

        const combinedStream = new MediaStream();
        videoStream.getVideoTracks().forEach(t => combinedStream.addTrack(t));
        if (audioStream) audioStream.getAudioTracks().forEach(t => combinedStream.addTrack(t));

        const mime = chooseMime();
        const options = mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : {};

        try {
            mediaRecorder = new MediaRecorder(combinedStream, options);
        } catch (e) {
            console.error('[Recorder] MediaRecorder init failed:', e);
            stopCompositor();
            teardownAudio();
            showToast && showToast('Gravação não suportada neste navegador.', 'error');
            return;
        }

        chunks = [];
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        mediaRecorder.onstop = () => {
            const blob = new Blob(chunks, { type: mime || 'video/webm' });
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            download(blob, `lyncro-recording-${ts}.webm`);
            chunks = [];
        };

        mediaRecorder.start(1000);
        startTime = Date.now();
        timerInterval = setInterval(tickTimer, 1000);
        updateUI(true);

        showToast && showToast('Gravação iniciada.', 'success');
        console.log('[Recorder] Started. Layout:', (window.currentRoomSettings && window.currentRoomSettings.layout) || 'auto-grid');
    }

    function stop() {
        if (!mediaRecorder) return;
        clearInterval(timerInterval);
        timerInterval = null;
        mediaRecorder.stop();
        mediaRecorder = null;
        stopCompositor();
        teardownAudio();
        updateUI(false);
        startTime = null;
        showToast && showToast('Gravação finalizada — download iniciado.', 'success');
        console.log('[Recorder] Stopped.');
    }

    function toggle() { isRecording() ? stop() : start(); }
    function isRecording() { return mediaRecorder !== null; }

    document.addEventListener('DOMContentLoaded', () => {
        btnEl   = document.getElementById('btn-record');
        badgeEl = document.getElementById('rec-badge');
        timerEl = document.getElementById('rec-timer');
        if (btnEl) btnEl.addEventListener('click', toggle);
    });

    window.LYNCRO_RECORDER = { start, stop, toggle, isRecording };
})();
