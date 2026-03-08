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
        const all = [];
        const localCard = document.getElementById('video-card-local');
        if (localCard) { const v = localCard.querySelector('video'); if (v && v.srcObject) all.push(v); }
        document.querySelectorAll('[id^="video-card-"]').forEach(card => {
            if (card.id === 'video-card-local') return;
            const v = card.querySelector('video');
            if (v && v.srcObject) all.push(v);
        });
        return all;
    }

    // ── Layout calculator (mirrors grid.js + grid.html logic) ────────────────
    function computeLayout(n) {
        const layoutId = (window.currentRoomSettings && window.currentRoomSettings.layout) || 'auto-grid';

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

            case 'cnn-vertical':
            case 'portrait-cards': {
                const gapPx = layoutId === 'portrait-cards' ? 16 : 2;
                const padPx = layoutId === 'portrait-cards' ? 16 : 0;
                const rounded = layoutId === 'portrait-cards' ? 16 : 0;

                let cols, rows;
                if (n <= 5)      { cols = n; rows = 1; }
                else if (n <= 6) { cols = 3; rows = 2; }
                else if (n <= 8) { cols = 4; rows = 2; }
                else if (n <= 9) { cols = 3; rows = 3; }
                else             { cols = 5; rows = Math.ceil(n / 5); }

                const availW = CANVAS_W - padPx * 2;
                const availH = CANVAS_H - padPx * 2;

                const cellW = (availW - (cols - 1) * gapPx) / cols;
                let cellH = cellW * 16 / 9; // portrait 9:16
                const maxCellH = (availH - (rows - 1) * gapPx) / rows;
                if (cellH > maxCellH) cellH = maxCellH;

                const totalW = cols * cellW + (cols - 1) * gapPx;
                const totalH = rows * cellH + (rows - 1) * gapPx;
                const startX = padPx + (availW - totalW) / 2;
                const startY = padPx + (availH - totalH) / 2;

                return Array.from({ length: n }, (_, i) => ({
                    x: startX + (i % cols) * (cellW + gapPx),
                    y: startY + Math.floor(i / cols) * (cellH + gapPx),
                    w: cellW,
                    h: cellH,
                    rounded,
                    cover: true,
                }));
            }

            case 'speaker-highlight': {
                const mainH = Math.round(CANVAS_H * 0.72);
                const stripH = CANVAS_H - mainH - 2;
                const stripCount = n - 1;
                const cells = [{ x: 0, y: 0, w: CANVAS_W, h: mainH, cover: false }];
                if (stripCount > 0) {
                    const stripW = (CANVAS_W - (stripCount - 1) * 2) / stripCount;
                    for (let i = 0; i < stripCount; i++) {
                        cells.push({ x: i * (stripW + 2), y: mainH + 2, w: stripW, h: stripH, cover: true });
                    }
                }
                return cells;
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

    function drawFrame(videoEls, layout) {
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        videoEls.forEach((v, i) => {
            if (i >= layout.length) return;
            const { x, y, w, h, cover = false, rounded = 0 } = layout[i];

            if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) {
                ctx.fillStyle = '#1a1a22';
                if (rounded > 0) {
                    ctx.save(); roundedRect(x, y, w, h, rounded); ctx.fill(); ctx.restore();
                } else {
                    ctx.fillRect(x, y, w, h);
                }
                return;
            }

            // Source rect: cover crops to fill, contain letterboxes
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

            if (rounded > 0) {
                ctx.save(); roundedRect(x, y, w, h, rounded); ctx.clip();
            }
            ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh);
            if (rounded > 0) ctx.restore();
        });
    }

    function startCompositor(videoEls) {
        canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        ctx = canvas.getContext('2d');

        function loop() {
            drawFrame(videoEls, computeLayout(videoEls.length));
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

        const videoEls = collectVideoElements();
        if (videoEls.length === 0) {
            showToast && showToast('Nenhum vídeo disponível para gravar.', 'error');
            return;
        }

        const videoStream = startCompositor(videoEls);
        const audioStream = buildAudioMix(videoEls);

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
