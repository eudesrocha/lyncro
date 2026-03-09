// Virtual Background Manager usando MediaPipe Selfie Segmentation
// Arquivo responsável por capturar o stream original e processar os frames em um Canvas.

class VirtualBackground {
    constructor() {
        this.active = false;
        this.mode = 'none'; // 'none', 'blur', 'image', 'anim-fireflies', 'anim-geometric', 'anim-waves', 'homeoffice', 'kitchen', 'balcony'
        this.backgroundImage = null;

        this.sourceVideo = document.createElement('video');
        this.sourceVideo.autoplay = true;
        this.sourceVideo.playsInline = true;
        this.sourceVideo.muted = true;
        this.sourceVideo.style.cssText = 'position: absolute; opacity: 0; pointer-events: none; width: 1px; height: 1px; z-index: -9999; left: -100px;';
        document.body.appendChild(this.sourceVideo);

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'position: absolute; opacity: 0; pointer-events: none; width: 1px; height: 1px; z-index: -9999; left: -100px;';
        document.body.appendChild(this.canvas);

        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

        this.segmentation = null;
        this.isModelLoaded = false;
        this.loadingPromise = null;

        this.animationFrameId = null;
        this.lastTime = 0;
        this.fpsLimit = 30;

        // Offscreen canvases for blur
        this.blurCanvas = null;
        this.blurCtx = null;
        this.blurCanvas2 = null;
        this.blurCtx2 = null;
        this.blurCanvas3 = null;
        this.blurCtx3 = null;

        // Offscreen canvas for animated BGs
        this.bgCanvas = null;
        this.bgCtx = null;

        // Geometric BG state
        this._geoShapes = null;

        // Fireflies state
        this._fireflies = null;
    }

    async init() {
        if (this.isModelLoaded) return;
        if (this.loadingPromise) return this.loadingPromise;

        console.log("[VirtualBackground] Iniciando carregamento do MediaPipe...");

        this.loadingPromise = new Promise((resolve, reject) => {
            const loadScripts = async () => {
                if (!window.SelfieSegmentation) {
                    await this.loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
                    await this.loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/control_utils/control_utils.js');
                    await this.loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js');
                    await this.loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js');
                }
            };

            loadScripts().then(() => {
                this.segmentation = new window.SelfieSegmentation({
                    locateFile: (file) => {
                        return `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
                    }
                });

                this.segmentation.setOptions({
                    modelSelection: 1 // 1 = Landscape (mais preciso, melhor para webcam desktop)
                });

                this.segmentation.onResults((results) => this.onResults(results));

                this.isModelLoaded = true;
                console.log("[VirtualBackground] MediaPipe carregado com sucesso.");
                resolve();
            }).catch(reject);
        });

        return this.loadingPromise;
    }

    loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.crossOrigin = "anonymous";
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    async start(stream, options = { mode: 'blur', imageUrl: null }) {
        await this.init();

        if (!stream) return null;

        this.setMode(options.mode, options.imageUrl);
        this.active = true;

        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) return stream;

        this.sourceVideo.srcObject = new MediaStream([videoTrack]);

        this.sourceVideo.addEventListener('resize', () => {
            if (this.active && this.sourceVideo.videoWidth > 0 && this.sourceVideo.videoHeight > 0) {
                this.canvas.width = this.sourceVideo.videoWidth;
                this.canvas.height = this.sourceVideo.videoHeight;
            }
        });

        await new Promise(resolve => {
            this.sourceVideo.onloadedmetadata = () => {
                this.sourceVideo.play();
                this.canvas.width = this.sourceVideo.videoWidth;
                this.canvas.height = this.sourceVideo.videoHeight;
                resolve();
            };
        });

        console.log(`[VirtualBackground] Processando start... Mode: ${this.mode}`);
        this.processFrame();

        const processedStream = this.canvas.captureStream(30);

        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
            processedStream.addTrack(audioTracks[0]);
        }

        return processedStream;
    }

    stop() {
        this.active = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        if (this.sourceVideo.srcObject) {
            this.sourceVideo.srcObject.getTracks().forEach(t => t.stop());
            this.sourceVideo.srcObject = null;
        }
    }

    setMode(mode, imageUrl = null) {
        this.mode = mode;
        if (imageUrl) {
            this.backgroundImage = new Image();
            this.backgroundImage.src = imageUrl;
        } else {
            this.backgroundImage = null;
        }
        // Reset animated BG state on mode change
        this._geoShapes = null;
        this._fireflies = null;
    }

    async processFrame() {
        if (!this.active) return;

        const now = performance.now();
        if (now - this.lastTime < (1000 / this.fpsLimit)) {
            this.animationFrameId = requestAnimationFrame(() => this.processFrame());
            return;
        }
        this.lastTime = now;

        if (this.sourceVideo.readyState >= 2) {
            try {
                if (this.mode === 'none') {
                    this.ctx.drawImage(this.sourceVideo, 0, 0, this.canvas.width, this.canvas.height);
                } else {
                    await this.segmentation.send({ image: this.sourceVideo });
                }
            } catch (err) {
                console.error("Erro no processamento do MediaPipe:", err);
            }
        }

        this.animationFrameId = requestAnimationFrame(() => this.processFrame());
    }

    // ─── Ensure offscreen BG canvas ───────────────────────────────────────────
    _getBgCanvas(w, h) {
        if (!this.bgCanvas) {
            this.bgCanvas = document.createElement('canvas');
            this.bgCtx = this.bgCanvas.getContext('2d');
        }
        if (this.bgCanvas.width !== w || this.bgCanvas.height !== h) {
            this.bgCanvas.width = w;
            this.bgCanvas.height = h;
        }
        return { c: this.bgCanvas, cx: this.bgCtx };
    }

    // ─── Fireflies ─────────────────────────────────────────────────────────────
    _initFireflies(w, h) {
        const count = 60;
        this._fireflies = Array.from({ length: count }, () => ({
            x: Math.random() * w,
            y: Math.random() * h,
            r: 1.5 + Math.random() * 2.5,
            vx: (Math.random() - 0.5) * 0.4,
            vy: (Math.random() - 0.5) * 0.4,
            phase: Math.random() * Math.PI * 2,
            speed: 0.5 + Math.random() * 1.5,
            color: ['#b3ff6e', '#7effa0', '#ffe080', '#80ffee'][Math.floor(Math.random() * 4)]
        }));
    }

    _drawFireflies(cx, w, h, time) {
        // Background: deep night gradient
        const grad = cx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#050d1a');
        grad.addColorStop(0.6, '#061022');
        grad.addColorStop(1, '#02060f');
        cx.fillStyle = grad;
        cx.fillRect(0, 0, w, h);

        // Subtle ground glow
        const groundGrad = cx.createRadialGradient(w * 0.5, h, 0, w * 0.5, h, w * 0.6);
        groundGrad.addColorStop(0, 'rgba(20, 60, 30, 0.18)');
        groundGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        cx.fillStyle = groundGrad;
        cx.fillRect(0, 0, w, h);

        if (!this._fireflies) this._initFireflies(w, h);

        for (const f of this._fireflies) {
            // Organic drift
            f.x += f.vx + Math.sin(time * f.speed * 0.4 + f.phase) * 0.3;
            f.y += f.vy + Math.cos(time * f.speed * 0.3 + f.phase * 1.3) * 0.2;

            // Wrap around
            if (f.x < -10) f.x = w + 10;
            if (f.x > w + 10) f.x = -10;
            if (f.y < -10) f.y = h + 10;
            if (f.y > h + 10) f.y = -10;

            // Pulse brightness
            const alpha = 0.4 + Math.sin(time * f.speed * 2 + f.phase) * 0.5;
            const glow = cx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 8);
            glow.addColorStop(0, f.color.replace(')', `, ${Math.max(0, alpha)})`).replace('rgb', 'rgba').replace('#', 'rgba(').replace(/([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})\)/, (_, r, g, b) =>
                `${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${Math.max(0, alpha)})`));
            glow.addColorStop(1, 'rgba(0,0,0,0)');

            // Draw glow halo
            cx.beginPath();
            cx.fillStyle = glow;
            cx.arc(f.x, f.y, f.r * 8, 0, Math.PI * 2);
            cx.fill();

            // Draw core dot
            cx.beginPath();
            cx.fillStyle = f.color;
            cx.globalAlpha = Math.max(0, alpha);
            cx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
            cx.fill();
            cx.globalAlpha = 1;
        }
    }

    // ─── Geometric Shapes ──────────────────────────────────────────────────────
    _initGeoShapes(w, h) {
        const colors = ['#0078d4', '#00b4d8', '#7b2d8b', '#c77dff', '#023e8a', '#48cae4', '#e040fb'];
        this._geoShapes = Array.from({ length: 12 }, () => ({
            x: Math.random() * w,
            y: Math.random() * h,
            size: 40 + Math.random() * 90,
            vx: (Math.random() - 0.5) * 1.2,
            vy: (Math.random() - 0.5) * 1.2,
            rot: Math.random() * Math.PI * 2,
            rotSpeed: (Math.random() - 0.5) * 0.015,
            sides: [3, 4, 6][Math.floor(Math.random() * 3)],
            color: colors[Math.floor(Math.random() * colors.length)],
            alpha: 0.12 + Math.random() * 0.18,
        }));
    }

    _drawPolygon(cx, x, y, size, sides, rot) {
        cx.beginPath();
        for (let i = 0; i < sides; i++) {
            const angle = rot + (i / sides) * Math.PI * 2;
            const px = x + Math.cos(angle) * size;
            const py = y + Math.sin(angle) * size;
            i === 0 ? cx.moveTo(px, py) : cx.lineTo(px, py);
        }
        cx.closePath();
    }

    _drawGeometric(cx, w, h, _time) {
        // Background: deep dark blue-charcoal
        const grad = cx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#070d1e');
        grad.addColorStop(0.5, '#0a0f22');
        grad.addColorStop(1, '#100820');
        cx.fillStyle = grad;
        cx.fillRect(0, 0, w, h);

        // Subtle grid
        cx.strokeStyle = 'rgba(0, 120, 212, 0.04)';
        cx.lineWidth = 1;
        const gridSize = 40;
        for (let x = 0; x < w; x += gridSize) { cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, h); cx.stroke(); }
        for (let y = 0; y < h; y += gridSize) { cx.beginPath(); cx.moveTo(0, y); cx.lineTo(w, y); cx.stroke(); }

        if (!this._geoShapes) this._initGeoShapes(w, h);

        for (const s of this._geoShapes) {
            s.x += s.vx;
            s.y += s.vy;
            s.rot += s.rotSpeed;

            // Bounce off edges
            if (s.x < -s.size) s.x = w + s.size;
            if (s.x > w + s.size) s.x = -s.size;
            if (s.y < -s.size) s.y = h + s.size;
            if (s.y > h + s.size) s.y = -s.size;

            // Fill
            this._drawPolygon(cx, s.x, s.y, s.size, s.sides, s.rot);
            cx.fillStyle = s.color;
            cx.globalAlpha = s.alpha;
            cx.fill();

            // Stroke (outline only, brighter)
            this._drawPolygon(cx, s.x, s.y, s.size, s.sides, s.rot);
            cx.strokeStyle = s.color;
            cx.lineWidth = 1.5;
            cx.globalAlpha = s.alpha * 2.5;
            cx.stroke();

            cx.globalAlpha = 1;
        }
    }

    // ─── Wave Lines ────────────────────────────────────────────────────────────
    _drawWaves(cx, w, h, time) {
        // Background: very dark charcoal with soft blue tint
        const grad = cx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#080c14');
        grad.addColorStop(1, '#0c1220');
        cx.fillStyle = grad;
        cx.fillRect(0, 0, w, h);

        const waves = [
            { amp: h * 0.06, freq: 2.1, speed: 0.4, y: h * 0.25, color: '#0078d4', alpha: 0.25, width: 1.5 },
            { amp: h * 0.08, freq: 1.7, speed: 0.3, y: h * 0.38, color: '#00b4d8', alpha: 0.18, width: 1.5 },
            { amp: h * 0.05, freq: 2.8, speed: 0.55, y: h * 0.50, color: '#7b2d8b', alpha: 0.22, width: 1.5 },
            { amp: h * 0.07, freq: 1.4, speed: 0.35, y: h * 0.62, color: '#c77dff', alpha: 0.15, width: 1.5 },
            { amp: h * 0.09, freq: 2.4, speed: 0.45, y: h * 0.75, color: '#0078d4', alpha: 0.12, width: 2 },
            { amp: h * 0.04, freq: 3.2, speed: 0.6,  y: h * 0.85, color: '#48cae4', alpha: 0.20, width: 1 },
        ];

        for (const wave of waves) {
            cx.beginPath();
            cx.moveTo(0, wave.y);
            for (let x = 0; x <= w; x += 3) {
                const y = wave.y + Math.sin((x / w) * Math.PI * wave.freq + time * wave.speed) * wave.amp;
                cx.lineTo(x, y);
            }
            cx.strokeStyle = wave.color;
            cx.lineWidth = wave.width;
            cx.globalAlpha = wave.alpha;
            cx.stroke();
            cx.globalAlpha = 1;
        }
    }

    // ─── Static Canvas BGs ─────────────────────────────────────────────────────
    _drawHomeOffice(cx, w, h) {
        // Warm cream/beige wall
        const wallGrad = cx.createLinearGradient(0, 0, 0, h);
        wallGrad.addColorStop(0, '#e8e0d4');
        wallGrad.addColorStop(1, '#d4c9b8');
        cx.fillStyle = wallGrad;
        cx.fillRect(0, 0, w, h);

        // Subtle wall texture horizontal lines
        cx.strokeStyle = 'rgba(180, 165, 145, 0.15)';
        cx.lineWidth = 1;
        for (let y = 0; y < h; y += 8) {
            cx.beginPath(); cx.moveTo(0, y); cx.lineTo(w, y); cx.stroke();
        }

        // Wood floor at bottom
        const floorY = h * 0.82;
        const floorGrad = cx.createLinearGradient(0, floorY, 0, h);
        floorGrad.addColorStop(0, '#8b6943');
        floorGrad.addColorStop(1, '#6b4f2e');
        cx.fillStyle = floorGrad;
        cx.fillRect(0, floorY, w, h - floorY);

        // Floor planks
        cx.strokeStyle = 'rgba(90, 55, 20, 0.3)';
        cx.lineWidth = 1;
        for (let x = 0; x < w; x += w / 5) {
            cx.beginPath(); cx.moveTo(x, floorY); cx.lineTo(x, h); cx.stroke();
        }

        // Baseboard
        cx.fillStyle = '#f0ebe2';
        cx.fillRect(0, floorY - 6, w, 6);

        // Bookshelf (right side)
        const shelfX = w * 0.62;
        const shelfW = w * 0.35;
        const shelfTop = h * 0.1;
        const shelfH = h * 0.68;
        cx.fillStyle = '#7a5c3a';
        cx.fillRect(shelfX, shelfTop, shelfW, shelfH);

        // Shelf boards
        const numShelves = 4;
        for (let i = 0; i <= numShelves; i++) {
            const sy = shelfTop + (shelfH / numShelves) * i;
            cx.fillStyle = '#8b6943';
            cx.fillRect(shelfX, sy - 4, shelfW, 6);
        }

        // Books on shelves
        const bookColors = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#e67e22', '#1abc9c', '#d35400'];
        for (let shelf = 0; shelf < numShelves; shelf++) {
            const sy = shelfTop + (shelfH / numShelves) * shelf + 4;
            const shelfHt = shelfH / numShelves - 8;
            let bx = shelfX + 4;
            let bi = 0;
            while (bx < shelfX + shelfW - 8) {
                const bw = 8 + Math.floor((bi * 7 + shelf * 3) % 14);
                const bh = shelfHt * (0.7 + (bi * 5 + shelf) % 3 * 0.1);
                cx.fillStyle = bookColors[(bi + shelf) % bookColors.length];
                cx.fillRect(bx, sy + shelfHt - bh, bw, bh);
                bx += bw + 1;
                bi++;
            }
        }

        // Plant (left side)
        const plantX = w * 0.08;
        const plantY = floorY;
        // Pot
        cx.fillStyle = '#b85c38';
        cx.beginPath();
        cx.moveTo(plantX - 15, plantY);
        cx.lineTo(plantX + 15, plantY);
        cx.lineTo(plantX + 12, plantY - 28);
        cx.lineTo(plantX - 12, plantY - 28);
        cx.closePath();
        cx.fill();

        // Stem
        cx.strokeStyle = '#3a7d44';
        cx.lineWidth = 3;
        cx.beginPath();
        cx.moveTo(plantX, plantY - 28);
        cx.bezierCurveTo(plantX - 5, plantY - 80, plantX + 20, plantY - 100, plantX + 5, plantY - 140);
        cx.stroke();

        // Leaves
        const leafPositions = [
            [plantX - 10, plantY - 65, -0.6],
            [plantX + 18, plantY - 85, 0.5],
            [plantX - 5, plantY - 110, -0.8],
            [plantX + 15, plantY - 125, 0.4],
        ];
        for (const [lx, ly, angle] of leafPositions) {
            cx.save();
            cx.translate(lx, ly);
            cx.rotate(angle);
            cx.fillStyle = '#2d6a4f';
            cx.beginPath();
            cx.ellipse(0, 0, 18, 8, 0, 0, Math.PI * 2);
            cx.fill();
            cx.restore();
        }

        // Window (center-left): soft daylight
        const winX = w * 0.16;
        const winY = h * 0.12;
        const winW = w * 0.25;
        const winH = h * 0.45;

        const lightGrad = cx.createRadialGradient(winX + winW / 2, winY, 10, winX + winW / 2, winY + winH, winH * 1.2);
        lightGrad.addColorStop(0, 'rgba(255, 248, 220, 0.55)');
        lightGrad.addColorStop(1, 'rgba(255, 248, 220, 0)');
        cx.fillStyle = lightGrad;
        cx.fillRect(winX - winW, winY, winW * 3, winH * 2);

        cx.fillStyle = '#b8d4e8';
        cx.fillRect(winX, winY, winW, winH);

        cx.strokeStyle = '#d8c9b0';
        cx.lineWidth = 6;
        cx.strokeRect(winX, winY, winW, winH);
        cx.lineWidth = 3;
        cx.beginPath();
        cx.moveTo(winX + winW / 2, winY); cx.lineTo(winX + winW / 2, winY + winH);
        cx.moveTo(winX, winY + winH / 2); cx.lineTo(winX + winW, winY + winH / 2);
        cx.stroke();
    }

    _drawKitchen(cx, w, h) {
        // Light grey wall
        cx.fillStyle = '#f2f0ec';
        cx.fillRect(0, 0, w, h);

        // Subtle tile backsplash upper half
        const tileY = h * 0.05;
        const tileH = h * 0.55;
        cx.fillStyle = '#e8e4df';
        cx.fillRect(0, tileY, w, tileH);

        const tileSize = 30;
        cx.strokeStyle = 'rgba(200, 192, 180, 0.5)';
        cx.lineWidth = 1;
        for (let x = 0; x < w; x += tileSize) {
            cx.beginPath(); cx.moveTo(x, tileY); cx.lineTo(x, tileY + tileH); cx.stroke();
        }
        for (let y = tileY; y < tileY + tileH; y += tileSize) {
            cx.beginPath(); cx.moveTo(0, y); cx.lineTo(w, y); cx.stroke();
        }

        // Upper cabinets
        const cabTop = h * 0.05;
        const cabH = h * 0.28;
        cx.fillStyle = '#ffffff';
        cx.fillRect(0, cabTop, w, cabH);
        cx.strokeStyle = '#d0cac0';
        cx.lineWidth = 1.5;
        cx.strokeRect(0, cabTop, w, cabH);

        // Cabinet doors
        const cabDoorW = w / 4;
        for (let i = 0; i < 4; i++) {
            const cdx = i * cabDoorW;
            cx.strokeStyle = '#d0cac0';
            cx.lineWidth = 1.5;
            cx.strokeRect(cdx + 4, cabTop + 4, cabDoorW - 8, cabH - 8);
            // Handle
            cx.fillStyle = '#a89880';
            cx.fillRect(cdx + cabDoorW / 2 - 8, cabTop + cabH / 2 - 3, 16, 6);
            cx.beginPath();
            cx.arc(cdx + cabDoorW / 2 - 8, cabTop + cabH / 2, 3, 0, Math.PI * 2);
            cx.arc(cdx + cabDoorW / 2 + 8, cabTop + cabH / 2, 3, 0, Math.PI * 2);
            cx.fillStyle = '#c8b89a';
            cx.fill();
        }

        // Counter
        const counterY = h * 0.65;
        const counterH = h * 0.12;
        cx.fillStyle = '#c8c0b4';
        cx.fillRect(0, counterY, w, counterH);
        cx.strokeStyle = '#b0a89a';
        cx.lineWidth = 1;
        cx.strokeRect(0, counterY, w, counterH);

        // Counter top edge highlight
        cx.fillStyle = '#e8e0d5';
        cx.fillRect(0, counterY, w, 4);

        // Lower cabinets
        cx.fillStyle = '#f5f0ea';
        cx.fillRect(0, counterY + counterH, w, h - counterY - counterH);
        cx.strokeStyle = '#d0cac0';
        cx.lineWidth = 1.5;
        const lowerDoorW = w / 3;
        for (let i = 0; i < 3; i++) {
            const ldx = i * lowerDoorW;
            cx.strokeRect(ldx + 4, counterY + counterH + 4, lowerDoorW - 8, h - counterY - counterH - 8);
        }

        // Stove / sink suggestions
        // Stove burners
        cx.strokeStyle = '#888';
        cx.lineWidth = 2;
        const burnerY = counterY + counterH / 2;
        [[w * 0.3, burnerY], [w * 0.5, burnerY]].forEach(([bx, by]) => {
            cx.beginPath(); cx.arc(bx, by, 12, 0, Math.PI * 2); cx.stroke();
            cx.beginPath(); cx.arc(bx, by, 6, 0, Math.PI * 2); cx.stroke();
        });

        // A coffee mug on counter
        cx.fillStyle = '#e8f4fd';
        cx.fillRect(w * 0.72, counterY - 28, 22, 26);
        cx.strokeStyle = '#c0d8e8';
        cx.lineWidth = 1;
        cx.strokeRect(w * 0.72, counterY - 28, 22, 26);
        // Handle
        cx.beginPath();
        cx.arc(w * 0.72 + 22 + 6, counterY - 18, 7, -0.5, 0.5 + Math.PI, false);
        cx.stroke();

        // Window above counter-ish area
        const winX = w * 0.35;
        const winY = h * 0.32;
        const winW = w * 0.28;
        const winH = h * 0.28;
        cx.fillStyle = '#b8d8f0';
        cx.fillRect(winX, winY, winW, winH);
        cx.strokeStyle = '#d0c8bc';
        cx.lineWidth = 5;
        cx.strokeRect(winX, winY, winW, winH);
        cx.lineWidth = 2;
        cx.beginPath();
        cx.moveTo(winX + winW / 2, winY); cx.lineTo(winX + winW / 2, winY + winH);
        cx.stroke();
    }

    _drawBalcony(cx, w, h) {
        // Sky gradient
        const skyGrad = cx.createLinearGradient(0, 0, 0, h * 0.65);
        skyGrad.addColorStop(0, '#1a6fc4');
        skyGrad.addColorStop(0.5, '#3d9be9');
        skyGrad.addColorStop(1, '#7ec8e3');
        cx.fillStyle = skyGrad;
        cx.fillRect(0, 0, w, h * 0.65);

        // Distant horizon haze
        const hazeGrad = cx.createLinearGradient(0, h * 0.55, 0, h * 0.65);
        hazeGrad.addColorStop(0, 'rgba(200, 230, 255, 0)');
        hazeGrad.addColorStop(1, 'rgba(200, 230, 255, 0.35)');
        cx.fillStyle = hazeGrad;
        cx.fillRect(0, h * 0.55, w, h * 0.12);

        // Sea
        const seaGrad = cx.createLinearGradient(0, h * 0.65, 0, h * 0.82);
        seaGrad.addColorStop(0, '#1a5f8a');
        seaGrad.addColorStop(0.5, '#1e7aad');
        seaGrad.addColorStop(1, '#1a5f8a');
        cx.fillStyle = seaGrad;
        cx.fillRect(0, h * 0.63, w, h * 0.2);

        // Sea shimmer lines
        cx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        cx.lineWidth = 1;
        for (let y = h * 0.65; y < h * 0.82; y += 6) {
            cx.beginPath();
            cx.moveTo(0, y);
            for (let x = 0; x <= w; x += 20) {
                cx.lineTo(x, y + Math.sin(x * 0.05) * 2);
            }
            cx.stroke();
        }

        // Balcony floor
        const floorY = h * 0.82;
        const floorGrad = cx.createLinearGradient(0, floorY, 0, h);
        floorGrad.addColorStop(0, '#c8bdb0');
        floorGrad.addColorStop(1, '#b0a598');
        cx.fillStyle = floorGrad;
        cx.fillRect(0, floorY, w, h - floorY);

        // Floor tiles
        cx.strokeStyle = 'rgba(160, 148, 135, 0.5)';
        cx.lineWidth = 1;
        const tileW = w / 6;
        const tileH2 = (h - floorY) / 2;
        for (let x = 0; x < w; x += tileW) {
            cx.beginPath(); cx.moveTo(x, floorY); cx.lineTo(x, h); cx.stroke();
        }
        cx.beginPath(); cx.moveTo(0, floorY + tileH2); cx.lineTo(w, floorY + tileH2); cx.stroke();

        // Railing
        const railY = h * 0.72;
        // railH intentionally unused — kept for layout reference

        // Vertical balusters
        cx.strokeStyle = 'rgba(240, 235, 228, 0.8)';
        cx.lineWidth = 2.5;
        const balusterSpacing = w / 18;
        for (let x = 0; x < w; x += balusterSpacing) {
            cx.beginPath();
            cx.moveTo(x, railY + 8);
            cx.lineTo(x, floorY);
            cx.stroke();
        }

        // Top rail
        cx.fillStyle = 'rgba(240, 236, 230, 0.9)';
        cx.fillRect(0, railY, w, 8);

        // Bottom rail
        cx.fillStyle = 'rgba(240, 236, 230, 0.7)';
        cx.fillRect(0, floorY - 6, w, 6);

        // Small cloud shapes
        cx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        [[w * 0.15, h * 0.12, 50, 18], [w * 0.6, h * 0.08, 70, 22], [w * 0.8, h * 0.18, 40, 14]].forEach(([cx2, cy, cw, ch]) => {
            cx.beginPath();
            cx.ellipse(cx2, cy, cw, ch, 0, 0, Math.PI * 2);
            cx.fill();
            cx.beginPath();
            cx.ellipse(cx2 + cw * 0.4, cy - 4, cw * 0.5, ch * 0.8, 0, 0, Math.PI * 2);
            cx.fill();
        });
    }

    // ─── onResults ─────────────────────────────────────────────────────────────
    onResults(results) {
        if (!this.active) return;

        const w = this.canvas.width;
        const h = this.canvas.height;
        const { c: bgC, cx: bgCx } = this._getBgCanvas(w, h);

        this.ctx.save();
        this.ctx.clearRect(0, 0, w, h);

        // Draw segmentation mask
        this.ctx.drawImage(results.segmentationMask, 0, 0, w, h);

        // Draw person where mask exists
        this.ctx.globalCompositeOperation = 'source-in';
        this.ctx.drawImage(results.image, 0, 0, w, h);

        // Draw background where mask does NOT exist
        this.ctx.globalCompositeOperation = 'destination-over';

        const time = performance.now() * 0.001;

        if (this.mode === 'blur') {
            // Improved multi-pass progressive blur (5-pass: deeper downscale for heavier blur)
            if (!this.blurCanvas) {
                this.blurCanvas = document.createElement('canvas');
                this.blurCtx = this.blurCanvas.getContext('2d');
            }
            if (!this.blurCanvas2) {
                this.blurCanvas2 = document.createElement('canvas');
                this.blurCtx2 = this.blurCanvas2.getContext('2d');
            }
            if (!this.blurCanvas3) {
                this.blurCanvas3 = document.createElement('canvas');
                this.blurCtx3 = this.blurCanvas3.getContext('2d');
            }

            // Pass 1: full → 25%
            const w1 = Math.max(1, Math.floor(w * 0.25));
            const h1 = Math.max(1, Math.floor(h * 0.25));
            if (this.blurCanvas.width !== w1 || this.blurCanvas.height !== h1) {
                this.blurCanvas.width = w1; this.blurCanvas.height = h1;
            }
            this.blurCtx.imageSmoothingEnabled = true;
            this.blurCtx.imageSmoothingQuality = 'high';
            this.blurCtx.drawImage(results.image, 0, 0, w1, h1);

            // Pass 2: 25% → 12%
            const w2 = Math.max(1, Math.floor(w1 * 0.5));
            const h2 = Math.max(1, Math.floor(h1 * 0.5));
            if (this.blurCanvas2.width !== w2 || this.blurCanvas2.height !== h2) {
                this.blurCanvas2.width = w2; this.blurCanvas2.height = h2;
            }
            this.blurCtx2.imageSmoothingEnabled = true;
            this.blurCtx2.imageSmoothingQuality = 'high';
            this.blurCtx2.drawImage(this.blurCanvas, 0, 0, w2, h2);

            // Pass 3: 12% → 6%
            const w3 = Math.max(1, Math.floor(w2 * 0.5));
            const h3 = Math.max(1, Math.floor(h2 * 0.5));
            if (this.blurCanvas3.width !== w3 || this.blurCanvas3.height !== h3) {
                this.blurCanvas3.width = w3; this.blurCanvas3.height = h3;
            }
            this.blurCtx3.imageSmoothingEnabled = true;
            this.blurCtx3.imageSmoothingQuality = 'high';
            this.blurCtx3.drawImage(this.blurCanvas2, 0, 0, w3, h3);

            // Pass 4: 6% → 25% (upscale with bilinear → lots of blur)
            this.blurCtx.imageSmoothingEnabled = true;
            this.blurCtx.imageSmoothingQuality = 'high';
            this.blurCtx.drawImage(this.blurCanvas3, 0, 0, w1, h1);

            // Pass 5: 25% → full (final upscale)
            this.ctx.imageSmoothingEnabled = true;
            this.ctx.imageSmoothingQuality = 'high';
            this.ctx.drawImage(this.blurCanvas, 0, 0, w, h);

        } else if (this.mode === 'image' && this.backgroundImage && this.backgroundImage.complete) {
            const hRatio = w / this.backgroundImage.width;
            const vRatio = h / this.backgroundImage.height;
            const ratio = Math.max(hRatio, vRatio);
            const cx = (w - this.backgroundImage.width * ratio) / 2;
            const cy = (h - this.backgroundImage.height * ratio) / 2;
            this.ctx.drawImage(this.backgroundImage,
                0, 0, this.backgroundImage.width, this.backgroundImage.height,
                cx, cy, this.backgroundImage.width * ratio, this.backgroundImage.height * ratio);

        } else if (this.mode === 'anim-fireflies') {
            this._drawFireflies(bgCx, w, h, time);
            this.ctx.drawImage(bgC, 0, 0);

        } else if (this.mode === 'anim-geometric') {
            this._drawGeometric(bgCx, w, h, time);
            this.ctx.drawImage(bgC, 0, 0);

        } else if (this.mode === 'anim-waves') {
            this._drawWaves(bgCx, w, h, time);
            this.ctx.drawImage(bgC, 0, 0);

        } else if (this.mode === 'homeoffice') {
            this._drawHomeOffice(bgCx, w, h);
            this.ctx.drawImage(bgC, 0, 0);

        } else if (this.mode === 'kitchen') {
            this._drawKitchen(bgCx, w, h);
            this.ctx.drawImage(bgC, 0, 0);

        } else if (this.mode === 'balcony') {
            this._drawBalcony(bgCx, w, h);
            this.ctx.drawImage(bgC, 0, 0);

        } else {
            this.ctx.fillStyle = '#1c1c1c';
            this.ctx.fillRect(0, 0, w, h);
        }

        this.ctx.restore();
    }
}

// Expor globalmente
window.vbManager = new VirtualBackground();
