/**
 * Lyncro — Recording via getDisplayMedia
 * Captures the clean grid dashboard tab + mixes WebRTC audio.
 * Exports: window.LYNCRO_RECORDER.start(), .stop(), .isRecording()
 */
(function () {
    const MIME_PREFERENCE = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
    ];

    let mediaRecorder = null;
    let chunks = [];
    let displayStream = null;
    let audioCtx = null;
    let mixDest = null;
    let audioSources = [];
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

    // ── Audio mixer (WebRTC streams from host.html) ──────────────────────────
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

    async function start() {
        if (mediaRecorder) return;

        showToast && showToast('Selecione a aba "Lyncro - Master Grid" no seletor do navegador.', 'info');

        try {
            displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: 30, displaySurface: 'browser' },
                audio: false,
                preferCurrentTab: false,
            });
        } catch (e) {
            showToast && showToast('Captura de tela cancelada.', 'error');
            return;
        }

        const videoEls = collectVideoElements();
        const audioStream = buildAudioMix(videoEls);

        const combinedStream = new MediaStream();
        displayStream.getVideoTracks().forEach(t => combinedStream.addTrack(t));
        if (audioStream) audioStream.getAudioTracks().forEach(t => combinedStream.addTrack(t));

        // Auto-stop quando o usuário clica "Parar compartilhamento" no browser
        displayStream.getVideoTracks()[0].addEventListener('ended', () => {
            if (isRecording()) stop();
        });

        const mime = chooseMime();
        const options = mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : {};

        try {
            mediaRecorder = new MediaRecorder(combinedStream, options);
        } catch (e) {
            console.error('[Recorder] MediaRecorder init failed:', e);
            teardownAudio();
            displayStream.getTracks().forEach(t => t.stop());
            displayStream = null;
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

        showToast && showToast('Gravação do dashboard iniciada.', 'success');
        console.log('[Recorder] Started. MIME:', mime || '(browser default)');
    }

    function stop() {
        if (!mediaRecorder) return;
        clearInterval(timerInterval);
        timerInterval = null;
        mediaRecorder.stop();
        mediaRecorder = null;
        if (displayStream) { displayStream.getTracks().forEach(t => t.stop()); displayStream = null; }
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
