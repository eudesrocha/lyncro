/**
 * Lyncro — Phase 1 Recording
 * Canvas compositor + MediaRecorder, runs entirely in the host browser.
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

    // ── UI refs (injected after DOM ready) ──────────────────────────────────
    let btnEl = null;
    let badgeEl = null;
    let timerEl = null;

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
        const mm = String(Math.floor(s / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        timerEl.textContent = `${mm}:${ss}`;
    }

    // ── Stream collection ────────────────────────────────────────────────────
    function collectVideoElements() {
        // Local first, then guests in DOM order
        const all = [];
        const localCard = document.getElementById('video-card-local');
        if (localCard) {
            const v = localCard.querySelector('video');
            if (v && v.srcObject) all.push(v);
        }
        document.querySelectorAll('[id^="video-card-"]').forEach(card => {
            if (card.id === 'video-card-local') return;
            const v = card.querySelector('video');
            if (v && v.srcObject) all.push(v);
        });
        return all;
    }

    // ── Canvas compositor ────────────────────────────────────────────────────
    function computeLayout(count) {
        if (count === 0) return [];
        if (count === 1) return [{ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H }];

        // Equal grid
        const cols = Math.ceil(Math.sqrt(count));
        const rows = Math.ceil(count / cols);
        const cellW = CANVAS_W / cols;
        const cellH = CANVAS_H / rows;
        const cells = [];
        for (let i = 0; i < count; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            cells.push({ x: col * cellW, y: row * cellH, w: cellW, h: cellH });
        }
        return cells;
    }

    function drawFrame(videoEls, layout) {
        ctx.fillStyle = '#111113';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        videoEls.forEach((v, i) => {
            if (i >= layout.length) return;
            const cell = layout[i];
            const pad = 4;
            const dx = cell.x + pad;
            const dy = cell.y + pad;
            const dw = cell.w - pad * 2;
            const dh = cell.h - pad * 2;

            if (v.readyState >= 2 && v.videoWidth && v.videoHeight) {
                // Letterbox / pillarbox: maintain aspect ratio
                const vAR = v.videoWidth / v.videoHeight;
                const cAR = dw / dh;
                let sx = 0, sy = 0, sw = dw, sh = dh;
                if (vAR > cAR) {
                    sh = dw / vAR;
                    sy = (dh - sh) / 2;
                } else {
                    sw = dh * vAR;
                    sx = (dw - sw) / 2;
                }
                ctx.drawImage(v, dx + sx, dy + sy, sw, sh);
            } else {
                ctx.fillStyle = '#1e1e22';
                ctx.fillRect(dx, dy, dw, dh);
            }
        });
    }

    function startCompositor(videoEls) {
        canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        ctx = canvas.getContext('2d');

        const layout = computeLayout(videoEls.length);

        function loop() {
            drawFrame(videoEls, layout);
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

    // ── Audio mixer ──────────────────────────────────────────────────────────
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
                } catch (e) {
                    console.warn('[Recorder] Audio source error:', e);
                }
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

    // ── MediaRecorder ────────────────────────────────────────────────────────
    function chooseMime() {
        return MIME_PREFERENCE.find(m => MediaRecorder.isTypeSupported(m)) || '';
    }

    function download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function start() {
        if (mediaRecorder) return; // already recording

        const videoEls = collectVideoElements();
        if (videoEls.length === 0) {
            showToast && showToast('Nenhum vídeo disponível para gravar.', 'error');
            return;
        }

        const videoStream = startCompositor(videoEls);
        const audioStream = buildAudioMix(videoEls);

        // Merge tracks
        const combinedStream = new MediaStream();
        videoStream.getVideoTracks().forEach(t => combinedStream.addTrack(t));
        if (audioStream) audioStream.getAudioTracks().forEach(t => combinedStream.addTrack(t));

        const mime = chooseMime();
        const options = mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : {};

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

        mediaRecorder.start(1000); // collect chunks every 1s
        startTime = Date.now();
        timerInterval = setInterval(tickTimer, 1000);
        updateUI(true);

        showToast && showToast('Gravação iniciada.', 'success');
        console.log('[Recorder] Started. MIME:', mime || '(browser default)');
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

    // ── DOM wiring (after DOM ready) ─────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        btnEl   = document.getElementById('btn-record');
        badgeEl = document.getElementById('rec-badge');
        timerEl = document.getElementById('rec-timer');
        if (btnEl) btnEl.addEventListener('click', toggle);
    });

    window.LYNCRO_RECORDER = { start, stop, toggle, isRecording };
})();
