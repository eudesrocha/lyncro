// Virtual Background Manager usando MediaPipe Selfie Segmentation
// Arquivo responsável por capturar o stream original e processar os frames em um Canvas.

class VirtualBackground {
    constructor() {
        this.active = false;
        this.mode = 'none'; // 'none', 'blur', 'image'
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
    }

    async init() {
        if (this.isModelLoaded) return;
        if (this.loadingPromise) return this.loadingPromise;

        console.log("[VirtualBackground] Iniciando carregamento do MediaPipe...");

        this.loadingPromise = new Promise((resolve, reject) => {
            // Carregar scripts do MediaPipe dinamicamente se não estiverem presentes
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
                    modelSelection: 1 // 0 = General (alta qualidade), 1 = Landscape (rápido/mobile)
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

        // Configurar vídeo de origem
        this.sourceVideo.srcObject = new MediaStream([videoTrack]);

        // Listen for orientation/resolution changes on the source video
        this.sourceVideo.addEventListener('resize', () => {
            if (this.active && this.sourceVideo.videoWidth > 0 && this.sourceVideo.videoHeight > 0) {
                console.log(`[VirtualBackground] Video resized: ${this.sourceVideo.videoWidth}x${this.sourceVideo.videoHeight}`);
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

        // O track processado é capturado do canvas (mantendo 30fps)
        const processedStream = this.canvas.captureStream(30);

        // Adicionar trilha de áudio original ao stream processado
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
    }

    async processFrame() {
        if (!this.active) return;

        // Limitar FPS para poupar CPU
        const now = performance.now();
        if (now - this.lastTime < (1000 / this.fpsLimit)) {
            this.animationFrameId = requestAnimationFrame(() => this.processFrame());
            return;
        }
        this.lastTime = now;

        if (this.sourceVideo.readyState >= 2) {
            try {
                if (this.mode === 'none') {
                    // Sem IA, apenas desenha o vídeo original no canvas
                    this.ctx.drawImage(this.sourceVideo, 0, 0, this.canvas.width, this.canvas.height);
                } else if (this.mode === 'blur' || (this.mode === 'image' && this.backgroundImage) || this.mode.startsWith('anim-')) {
                    // Passa frame para a IA de segmentação
                    await this.segmentation.send({ image: this.sourceVideo });
                }
            } catch (err) {
                console.error("Erro no processamento do MediaPipe:", err);
            }
        }

        this.animationFrameId = requestAnimationFrame(() => this.processFrame());
    }

    onResults(results) {
        if (!this.active) return;

        this.ctx.save();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Desenhar a máscara de segmentação
        this.ctx.drawImage(results.segmentationMask, 0, 0, this.canvas.width, this.canvas.height);

        // Configurar composição para desenhar a pessoa *onde a máscara existe*
        this.ctx.globalCompositeOperation = 'source-in';
        this.ctx.drawImage(results.image, 0, 0, this.canvas.width, this.canvas.height);

        // Configurar composição para desenhar o fundo *onde a máscara NÃO existe*
        this.ctx.globalCompositeOperation = 'destination-over';

        if (this.mode === 'blur') {
            // Técnica de downscale/upscale: funciona em TODOS os browsers (incluindo Safari iOS)
            // ctx.filter não é suportado no Safari iOS, então usamos escala reduzida + imageSmoothingQuality
            if (!this.blurCanvas) {
                this.blurCanvas = document.createElement('canvas');
                this.blurCtx = this.blurCanvas.getContext('2d');
            }

            const scale = 0.125; // Reduzir 8x para criar o blur
            const bw = Math.max(1, Math.floor(this.canvas.width * scale));
            const bh = Math.max(1, Math.floor(this.canvas.height * scale));

            if (this.blurCanvas.width !== bw || this.blurCanvas.height !== bh) {
                this.blurCanvas.width = bw;
                this.blurCanvas.height = bh;
            }

            // 1. Desenhar imagem reduzida (perde detalhes = blur)
            this.blurCtx.drawImage(results.image, 0, 0, bw, bh);

            // 2. Ampliar de volta para o tamanho original (bilinear filtering = smooth blur)
            this.ctx.imageSmoothingEnabled = true;
            this.ctx.imageSmoothingQuality = 'high';
            this.ctx.drawImage(this.blurCanvas, 0, 0, bw, bh, 0, 0, this.canvas.width, this.canvas.height);

            // 3. Aplicar leve saturação via overlay de cor (opcional, compensa perda de cor)
            this.ctx.globalCompositeOperation = 'overlay';
            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.02)';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.globalCompositeOperation = 'destination-over';
        } else if (this.mode === 'image' && this.backgroundImage && this.backgroundImage.complete) {
            // Desenhar imagem de fundo

            // Lógica para objeto contain/cover (Cover mantendo a proporção da imagem de fundo)
            const hRatio = this.canvas.width / this.backgroundImage.width;
            const vRatio = this.canvas.height / this.backgroundImage.height;
            const ratio = Math.max(hRatio, vRatio);
            const centerShift_x = (this.canvas.width - this.backgroundImage.width * ratio) / 2;
            const centerShift_y = (this.canvas.height - this.backgroundImage.height * ratio) / 2;

            this.ctx.drawImage(this.backgroundImage, 0, 0, this.backgroundImage.width, this.backgroundImage.height,
                centerShift_x, centerShift_y, this.backgroundImage.width * ratio, this.backgroundImage.height * ratio);
        } else if (this.mode === 'anim-window') {
            const time = performance.now() * 0.001;
            const w = this.canvas.width;
            const h = this.canvas.height;

            // === FUNDO: Céu azul suave ===
            const skyGrad = this.ctx.createLinearGradient(0, 0, 0, h);
            skyGrad.addColorStop(0, '#87CEEB');
            skyGrad.addColorStop(0.5, '#B0E0F6');
            skyGrad.addColorStop(1, '#d4eaf7');
            this.ctx.fillStyle = skyGrad;
            this.ctx.fillRect(0, 0, w, h);

            // === RAIO DE SOL movendo-se ===
            const sunX = w * 0.75 + Math.sin(time * 0.3) * 40;
            const sunY = h * 0.15 + Math.cos(time * 0.2) * 20;
            const sunGrad = this.ctx.createRadialGradient(sunX, sunY, 5, sunX, sunY, w * 0.5);
            sunGrad.addColorStop(0, 'rgba(255, 255, 220, 0.35)');
            sunGrad.addColorStop(0.3, 'rgba(255, 255, 200, 0.1)');
            sunGrad.addColorStop(1, 'rgba(255, 255, 200, 0)');
            this.ctx.fillStyle = sunGrad;
            this.ctx.fillRect(0, 0, w, h);

            // === COPA DA ÁRVORE (folhas balançando) ===
            this.ctx.fillStyle = '#2d5a1e';
            for (let i = 0; i < 18; i++) {
                const baseX = w * (0.1 + (i % 6) * 0.16);
                const baseY = h * (0.05 + Math.floor(i / 6) * 0.12);
                const sway = Math.sin(time * 1.2 + i * 0.7) * (8 + i * 1.5);
                const swayY = Math.cos(time * 0.8 + i * 1.1) * 4;
                const size = 30 + (i % 5) * 12;

                // Folha escura
                this.ctx.beginPath();
                this.ctx.ellipse(baseX + sway, baseY + swayY, size, size * 0.7, Math.sin(time + i) * 0.3, 0, Math.PI * 2);
                this.ctx.fill();
            }
            // Folhas mais claras por cima
            this.ctx.fillStyle = '#3d7a2e';
            for (let i = 0; i < 12; i++) {
                const baseX = w * (0.15 + (i % 5) * 0.18);
                const baseY = h * (0.08 + Math.floor(i / 5) * 0.1);
                const sway = Math.sin(time * 1.5 + i * 1.3) * (10 + i * 2);
                const swayY = Math.cos(time * 1.0 + i * 0.9) * 5;
                const size = 20 + (i % 4) * 10;
                this.ctx.beginPath();
                this.ctx.ellipse(baseX + sway, baseY + swayY, size, size * 0.6, Math.cos(time * 0.5 + i) * 0.4, 0, Math.PI * 2);
                this.ctx.fill();
            }

            // === MOLDURA DA JANELA ===
            this.ctx.fillStyle = '#f5f0e8';
            // Moldura esquerda
            this.ctx.fillRect(0, 0, w * 0.04, h);
            // Moldura direita
            this.ctx.fillRect(w * 0.96, 0, w * 0.04, h);
            // Moldura superior
            this.ctx.fillRect(0, 0, w, h * 0.04);
            // Moldura inferior (peitoril)
            this.ctx.fillRect(0, h * 0.88, w, h * 0.12);
            // Divisória central vertical
            this.ctx.fillRect(w * 0.49, 0, w * 0.02, h * 0.88);

            // Sombra no peitoril
            const shelfGrad = this.ctx.createLinearGradient(0, h * 0.88, 0, h * 0.92);
            shelfGrad.addColorStop(0, 'rgba(0,0,0,0.15)');
            shelfGrad.addColorStop(1, 'rgba(0,0,0,0)');
            this.ctx.fillStyle = shelfGrad;
            this.ctx.fillRect(0, h * 0.88, w, h * 0.04);

            // === CORTINA ondulando com brisa ===
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            // Cortina esquerda
            this.ctx.beginPath();
            this.ctx.moveTo(w * 0.04, 0);
            for (let y = 0; y < h * 0.88; y += 5) {
                const wave = Math.sin(time * 2.0 + y * 0.015) * (15 + Math.sin(time * 0.5) * 8);
                this.ctx.lineTo(w * 0.04 + w * 0.08 + wave, y);
            }
            this.ctx.lineTo(w * 0.04, h * 0.88);
            this.ctx.closePath();
            this.ctx.fill();

            // Cortina direita
            this.ctx.beginPath();
            this.ctx.moveTo(w * 0.96, 0);
            for (let y = 0; y < h * 0.88; y += 5) {
                const wave = Math.sin(time * 2.0 + y * 0.015 + 1.5) * (15 + Math.sin(time * 0.5 + 1) * 8);
                this.ctx.lineTo(w * 0.96 - w * 0.08 - wave, y);
            }
            this.ctx.lineTo(w * 0.96, h * 0.88);
            this.ctx.closePath();
            this.ctx.fill();

        } else if (this.mode === 'anim-studio') {
            // Fundo animado Studio Pulse (cinemático, escuro com pulsação de luz)
            const time = performance.now() * 0.001;

            // 1. Pulsação de luz (Frente)
            const pulse = Math.sin(time * 0.5) * 0.5 + 0.5; // 0 a 1
            const gradient = this.ctx.createRadialGradient(
                this.canvas.width * 0.5, this.canvas.height * 0.2, 10,
                this.canvas.width * 0.5, this.canvas.height * 0.5, this.canvas.width * 0.8
            );
            gradient.addColorStop(0, `rgba(20, 60, 150, ${0.1 + pulse * 0.15})`);
            gradient.addColorStop(1, 'rgba(10, 10, 15, 0.9)');

            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            // 2. Cor de Fundo Escuro (Fundo)
            this.ctx.fillStyle = '#111116';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        } else if (this.mode === 'anim-particles') {
            // Gradiente com partículas premium flutuantes
            const time = performance.now() * 0.001;

            // 1. Partículas (Frente)
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            for (let i = 0; i < 30; i++) {
                const x = (Math.sin(i * 123.45 + time * 0.2) * 0.5 + 0.5) * this.canvas.width;
                const y = ((i * 321.12 - time * 20) % this.canvas.height + this.canvas.height) % this.canvas.height;
                const size = (Math.sin(i) * 0.5 + 0.5) * 2 + 0.5;
                this.ctx.beginPath();
                this.ctx.arc(x, y, size, 0, Math.PI * 2);
                this.ctx.fill();
            }

            // 2. Gradiente (Fundo)
            const gradient = this.ctx.createLinearGradient(0, 0, this.canvas.width, this.canvas.height);
            gradient.addColorStop(0, '#0a0a2a');
            gradient.addColorStop(1, '#1a0a1f');
            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        } else {
            // Fallback (fundo verde ou preto caso a imagem falhe)
            this.ctx.fillStyle = '#1c1c1c';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }

        this.ctx.restore();
    }
}

// Expor globalmente
window.vbManager = new VirtualBackground();
