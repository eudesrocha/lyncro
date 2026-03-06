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
            // Criar um canvas offscreen se não existir (corrige bug iOS Canvas Filter + destination-over)
            if (!this.offscreenCanvas) {
                this.offscreenCanvas = document.createElement('canvas');
                this.offscreenCtx = this.offscreenCanvas.getContext('2d');
            }
            if (this.offscreenCanvas.width !== this.canvas.width || this.offscreenCanvas.height !== this.canvas.height) {
                this.offscreenCanvas.width = this.canvas.width;
                this.offscreenCanvas.height = this.canvas.height;
            }

            // Aplicar desfoque ao vídeo original no canvas offscreen
            this.offscreenCtx.filter = 'blur(8px) saturate(1.2)';
            this.offscreenCtx.drawImage(results.image, 0, 0, this.canvas.width, this.canvas.height);

            // Desenhar o resultado do offscreen no canvas principal
            this.ctx.drawImage(this.offscreenCanvas, 0, 0, this.canvas.width, this.canvas.height);
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
        } else if (this.mode === 'anim-window' && this.backgroundImage && this.backgroundImage.complete) {
            const time = performance.now() * 0.001;

            // 1. Um pequeno brilho solar que se move (Frente - desenhado primeiro com destination-over)
            const gradient = this.ctx.createRadialGradient(
                this.canvas.width * 0.8 + Math.sin(time * 0.5) * 50,
                this.canvas.height * 0.2 + Math.cos(time * 0.3) * 30,
                10,
                this.canvas.width * 0.8,
                this.canvas.height * 0.2,
                300
            );
            gradient.addColorStop(0, 'rgba(255, 255, 230, 0.15)');
            gradient.addColorStop(1, 'rgba(255, 255, 230, 0)');
            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            // 2. Adicionar animação sutil (Brisa de vento / sombras oscilantes) (Meio)
            this.ctx.fillStyle = `rgba(10, 30, 15, ${0.05 + Math.sin(time) * 0.02})`;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            // 3. Desenhar imagem base da janela (Fundo - desenhado por último)
            const hRatio = this.canvas.width / this.backgroundImage.width;
            const vRatio = this.canvas.height / this.backgroundImage.height;
            const ratio = Math.max(hRatio, vRatio);
            const centerShift_x = (this.canvas.width - this.backgroundImage.width * ratio) / 2;
            const centerShift_y = (this.canvas.height - this.backgroundImage.height * ratio) / 2;
            this.ctx.drawImage(this.backgroundImage, 0, 0, this.backgroundImage.width, this.backgroundImage.height,
                centerShift_x, centerShift_y, this.backgroundImage.width * ratio, this.backgroundImage.height * ratio);

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
