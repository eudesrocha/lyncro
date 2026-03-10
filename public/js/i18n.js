/**
 * i18n.js — Sistema de localização do Lyncro
 * Idiomas: pt (Português) e en (English)
 * Expõe: window.LYNCRO_I18N
 */
(function () {
    'use strict';

    const TRANSLATIONS = {
        pt: {
            // ── Modal de Upgrade ──────────────────────────────────────────────────
            modal_unlock: 'Desbloqueie todos os recursos.',
            modal_pro_feature: '"{{name}}" é um recurso exclusivo do plano PRO.',
            modal_pro_feature_generic: 'Este recurso é exclusivo do plano PRO.',
            modal_footer: 'Cancele a qualquer momento · Pagamento seguro via Stripe',
            btn_subscribe: 'Assinar',
            btn_loading: 'Aguarde...',
            // FREE vs PRO
            free_watermark: "Marca d'água Lyncro",
            free_720p: 'Até 720p',
            free_20min: 'Chamadas até 20 min',
            free_no_recording: 'Sem gravação',
            free_no_teleprompter: 'Sem teleprompter',
            free_no_lower_thirds: 'Sem lower thirds',
            free_no_files: 'Sem arquivos no chat',
            pro_no_watermark: "Sem marca d'água",
            pro_1080p: '1080p Full HD',
            pro_unlimited: 'Chamadas ilimitadas',
            pro_recording: 'Gravação de transmissão',
            pro_teleprompter: 'Teleprompter',
            pro_lower_thirds: 'Lower thirds & letreiros',
            pro_files: 'Arquivos no chat',
            // Preços — labels
            period_monthly: 'Mensal',
            period_semiannual: 'Semestral',
            period_annual: 'Anual',
            sub_monthly: '/mês',
            sub_semiannual: '/6 meses',
            sub_annual: '/ano',
            badge_popular: 'Mais popular',
            savings_16: 'Economia de 16%',
            savings_15: 'Economia de 15%',
            savings_4mo: '4 meses grátis',
            // Gates e badges
            plan_locked_suffix: '— Upgrade necessário',
            // Toast
            toast_pro: 'Bem-vindo ao PRO! Aproveite todos os recursos.',
            // Erros
            err_checkout: 'Erro ao iniciar pagamento: ',
            err_portal: 'Erro ao abrir portal: ',
            // ── Landing Page ──────────────────────────────────────────────────────
            tagline: 'Design Minimalista. Performance Máxima',
            hero_line1: 'CONECTE.',
            hero_line2: 'CAPTURE. TRANSMITA.',
            hero_sub: 'Conecte-se com convidados em qualquer lugar do planeta através de uma rede de baixa latência. O LYNCRO é a ponte invisível entre a sua mensagem e o resto do mundo.',
            // Feature slides
            s1_title: 'Mobile First, Sempre',
            s1_desc: 'Convide pessoas de qualquer lugar. Eles entram pelo celular e você recebe áudio e vídeo em altíssima qualidade — sem burocracias.',
            s2_title: 'A Ponte Perfeita (Clean Feed)',
            s2_desc: 'Puxe fontes imaculadas (Clean Feed) diretas para seu OBS Studio ou vMix, sem interfaces ou popups da chamada vazando no ar.',
            s3_title: 'Áudio Quality Studio',
            s3_desc: 'Desabilite cancelamentos agressivos. Transmita o áudio limpo dos microfones como se estivessem no mesmo estúdio.',
            s4_title: 'Chat Backstage',
            s4_desc: 'Converse em tempo real com sua equipe e convidados de forma privada durante a transmissão.',
            s5_title: 'Lower Thirds (GCs)',
            s5_desc: 'Injete letreiros animados com nome e profissão diretamente no feed visual dos participantes instantaneamente.',
            s6_title: 'Multi-Cam Suporte',
            s6_desc: 'Troque fluidamente entre a câmera frontal ou traseira (mobile) e selecione placas de captura (desktop).',
            s7_title: 'Controle de Mute Total',
            s7_desc: 'O diretor domina o painel. Corte ou libere o áudio dos convidados remotamente.',
            s8_title: 'Media Drop / Arquivos',
            s8_desc: 'Envie roteiros, pautas, ou imagens arrastando pro painel usando WebRTC (ponto a ponto, sem provedor no meio).',
            s9_title: 'Fundo Virtual Borrado',
            s9_desc: 'Convidados desorganizados? Use IA em tempo real para desfocar o fundo ou aplicar imagens corporativas.',
            s10_title: 'Rotas Criptografadas',
            s10_desc: 'Conexões WebRTC Peer-to-Peer fortemente criptografadas. O que acontece na live, fica na live.',
            // Lobby
            tab_create: 'Criar Sala',
            tab_join: 'Entrar',
            create_title: 'CRIAR MINHA SALA',
            create_sub: 'Dê um nome e entre ao vivo.',
            label_project: 'Nome da Sala',
            ph_project: 'Ex: Meu-Podcast',
            err_room: 'Defina um nome para a sala',
            label_password: 'Senha (Opcional)',
            label_password_opt: '',
            label_screenname: 'Seu Nome',
            ph_name: 'Como você quer aparecer',
            err_name: 'Informe seu nome',
            btn_create: 'ENTRAR NA SALA',
            noauth_title: 'Acesso Necessário',
            noauth_desc: 'Para criar uma sala, você precisa estar logado.',
            btn_login: 'FAZER LOGIN',
            label_master_link: 'Link para Convidados',
            btn_enter_cc: 'ENTRAR NA SALA',
            // Sessão ativa
            active_session_title: 'VOCÊ TEM UMA SALA ATIVA',
            active_session_live: 'Ao vivo agora',
            active_session_waiting: 'Aguardando conexão',
            active_session_resume: 'RETOMAR SESSÃO',
            active_session_new: '+ Criar nova sala',
            // ── Host UI ───────────────────────────────────────────────────────────
            btn_open_dashboard: 'Painel ao Vivo',
            btn_invite: 'Convidar',
            btn_invite_tooltip: 'Copiar Link de Convite',
            // Layouts
            layout_auto_grid: 'Auto Grid',
            layout_dynamic_cards: 'Dynamic Cards',
            layout_cnn_split: 'CNN Split',
            layout_cnn_vertical: 'CNN Vertical',
            layout_portrait_cards: 'Portrait Cards',
            layout_highlight: 'Destaque',
            // Settings menu
            menu_lower_thirds: 'Letreiros & Lower Thirds',
            menu_sound: 'Som de Entrada',
            menu_labels: 'Exibir Labels',
            section_production: 'Produção',
            section_host_cam: 'Câmera Host',
            section_teleprompter: 'Teleprompter',
            section_chat: 'Chat de Produção',
            label_speed: 'Vel',
            label_size: 'Tam',
            label_margin: 'Margem',
            // Guest UI
            menu_mics: 'Microfones',
            menu_cams: 'Câmeras',
            btn_leave: 'Sair',
            btn_more: 'Mais',
            menu_share_screen: 'Compartilhar Tela',
            menu_qr_code: 'Câmera do Celular',
            menu_attach: 'Anexar Arquivo',
            menu_prefs: 'Preferências',
            // Virtual backgrounds
            vb_none: 'Nenhum',
            vb_blur: 'Desfoque',
            vb_fireflies: 'Partículas',
            vb_geometric: 'Geométrico',
            vb_waves: 'Ondas',
            vb_home: 'Home Office',
            vb_kitchen: 'Cozinha',
            vb_balcony: 'Varanda',
            // Session
            session_ended_host: 'O produtor encerrou a sessão.',
            session_ended_timeout: 'Conexão do produtor foi perdida.',
            session_ended_time_limit: 'O limite de 20 minutos do plano gratuito foi atingido. Assine o PRO para sessões ilimitadas.',
            host_disconnected: 'Produtor desconectado. Aguardando reconexão...',
            join_title: 'ACESSAR ESTÚDIO',
            join_sub: 'Você foi convidado. Insira as credenciais para transmitir seu áudio e vídeo em alta qualidade.',
            label_studio_id: 'ID do Estúdio (Sala)',
            ph_studio_id: 'Fornecido pelo diretor',
            err_join_room: 'Informe a sala',
            err_room_notfound: 'Sala não encontrada. Verifique o ID.',
            err_connection: 'Erro de conexão. Tente novamente.',
            label_tv_name: 'Seu Nome para a TV',
            ph_tv_name: 'Como o público verá você?',
            btn_join: 'ENTRAR AO VIVO',
            btn_loading_join: 'Verificando...',
            err_api: 'Erro ao criar sala. Verifique a conexão.',
            btn_logout: 'Sair',
            // Host navbar / controles
            btn_record: 'Gravar',
            label_room: 'SALA',
            label_room_active: 'SALA ATIVA',
            lbl_return: 'Retorno',
            title_return_audio: 'Dispositivo de Áudio de Retorno',
            title_cam_quality: 'Qualidade da câmera local',
            title_settings: 'Configurações da Produção',
            title_end_session: 'Encerrar Sessão',
            // Teleprompter
            label_show_to: 'Exibir para',
            label_all_guests: 'Todos os Convidados',
            ph_prompter: 'Cole o roteiro para os convidados aqui...',
            title_scroll: 'Rolar Texto',
            title_margin_h: 'Margem Horizontal',
            // Chat
            ph_chat: 'Mensagem para equipe...',
            // Fila de espera
            label_in_queue: 'Na Fila',
            title_approve: 'Aprovar',
            title_reject: 'Recusar',
            // QR Modal
            qr_desc: 'Escaneie o código com seu celular para adicioná-lo como câmera secundária (Multi-Cam).',
            qr_badge: 'Emparelhamento Silencioso',
        },
        en: {
            // ── Upgrade Modal ─────────────────────────────────────────────────────
            modal_unlock: 'Unlock all features.',
            modal_pro_feature: '"{{name}}" is an exclusive PRO feature.',
            modal_pro_feature_generic: 'This feature is exclusive to the PRO plan.',
            modal_footer: 'Cancel anytime · Secure payment via Stripe',
            btn_subscribe: 'Subscribe',
            btn_loading: 'Please wait...',
            // FREE vs PRO
            free_watermark: 'Lyncro watermark',
            free_720p: 'Up to 720p',
            free_20min: 'Calls up to 20 min',
            free_no_recording: 'No recording',
            free_no_teleprompter: 'No teleprompter',
            free_no_lower_thirds: 'No lower thirds',
            free_no_files: 'No file sharing in chat',
            pro_no_watermark: 'No watermark',
            pro_1080p: '1080p Full HD',
            pro_unlimited: 'Unlimited calls',
            pro_recording: 'Session recording',
            pro_teleprompter: 'Teleprompter',
            pro_lower_thirds: 'Lower thirds & overlays',
            pro_files: 'File sharing in chat',
            // Pricing labels
            period_monthly: 'Monthly',
            period_semiannual: 'Semiannual',
            period_annual: 'Annual',
            sub_monthly: '/mo',
            sub_semiannual: '/6mo',
            sub_annual: '/yr',
            badge_popular: 'Most popular',
            savings_16: 'Save 16%',
            savings_15: 'Save 15%',
            savings_4mo: '4 months free',
            // Gates
            plan_locked_suffix: '— Upgrade required',
            // Toast
            toast_pro: 'Welcome to PRO! Enjoy all features.',
            // Errors
            err_checkout: 'Payment error: ',
            err_portal: 'Portal error: ',
            // ── Landing Page ──────────────────────────────────────────────────────
            tagline: 'Minimalist Design. Maximum Performance',
            hero_line1: 'CONNECT.',
            hero_line2: 'CAPTURE. BROADCAST.',
            hero_sub: 'Connect with guests anywhere on the planet through a low-latency network. LYNCRO is the invisible bridge between your message and the rest of the world.',
            // Feature slides
            s1_title: 'Mobile First, Always',
            s1_desc: 'Invite people from anywhere. They join from their phone and you receive high-quality audio and video — no hassle.',
            s2_title: 'The Perfect Bridge (Clean Feed)',
            s2_desc: 'Pull pristine Clean Feed sources directly into your OBS Studio or vMix, with no call interfaces leaking on air.',
            s3_title: 'Studio Audio Quality',
            s3_desc: 'Disable aggressive cancellation. Transmit clean microphone audio as if everyone is in the same studio.',
            s4_title: 'Backstage Chat',
            s4_desc: 'Chat in real-time with your team and guests privately during the broadcast.',
            s5_title: 'Lower Thirds (GCs)',
            s5_desc: 'Inject animated name and title overlays directly into the visual feed of participants instantly.',
            s6_title: 'Multi-Cam Support',
            s6_desc: 'Switch smoothly between front or rear camera (mobile) and select capture cards (desktop).',
            s7_title: 'Full Mute Control',
            s7_desc: 'The director owns the board. Cut or release guest audio remotely.',
            s8_title: 'Media Drop / Files',
            s8_desc: 'Send scripts, rundowns, or images by dragging to the panel using WebRTC (peer-to-peer, no middleman).',
            s9_title: 'Blurred Virtual Background',
            s9_desc: 'Messy guests? Use real-time AI to blur the background or apply corporate images.',
            s10_title: 'Encrypted Routes',
            s10_desc: 'Strongly encrypted WebRTC Peer-to-Peer connections. What happens on the live, stays on the live.',
            // Lobby
            tab_create: 'Create Room',
            tab_join: 'Join',
            create_title: 'CREATE MY ROOM',
            create_sub: 'Give it a name and go live.',
            label_project: 'Room Name',
            ph_project: 'e.g. My-Podcast',
            err_room: 'Enter a room name',
            label_password: 'Password (Optional)',
            label_password_opt: '',
            label_screenname: 'Your Name',
            ph_name: 'How you want to appear',
            err_name: 'Enter your name',
            btn_create: 'ENTER ROOM',
            noauth_title: 'Login Required',
            noauth_desc: 'You need to be logged in to create a room.',
            btn_login: 'LOG IN',
            label_master_link: 'Guest Link',
            btn_enter_cc: 'ENTER ROOM',
            // Active session
            active_session_title: 'YOU HAVE AN ACTIVE ROOM',
            active_session_live: 'Live now',
            active_session_waiting: 'Waiting for connection',
            active_session_resume: 'RESUME SESSION',
            active_session_new: '+ Create new room',
            // ── Host UI ───────────────────────────────────────────────────────────
            btn_open_dashboard: 'Live Panel',
            btn_invite: 'Invite',
            btn_invite_tooltip: 'Copy Invite Link',
            // Layouts
            layout_auto_grid: 'Auto Grid',
            layout_dynamic_cards: 'Dynamic Cards',
            layout_cnn_split: 'CNN Split',
            layout_cnn_vertical: 'CNN Vertical',
            layout_portrait_cards: 'Portrait Cards',
            layout_highlight: 'Highlight',
            // Settings menu
            menu_lower_thirds: 'Overlays & Lower Thirds',
            menu_sound: 'Entry Sound',
            menu_labels: 'Show Labels',
            section_production: 'Production',
            section_host_cam: 'Host Camera',
            section_teleprompter: 'Teleprompter',
            section_chat: 'Production Chat',
            label_speed: 'Speed',
            label_size: 'Size',
            label_margin: 'Margin',
            // Guest UI
            menu_mics: 'Microphones',
            menu_cams: 'Cameras',
            btn_leave: 'Leave',
            btn_more: 'More',
            menu_share_screen: 'Share Screen',
            menu_qr_code: 'Mobile Camera',
            menu_attach: 'Attach File',
            menu_prefs: 'Preferences',
            // Virtual backgrounds
            vb_none: 'None',
            vb_blur: 'Blur',
            vb_fireflies: 'Particles',
            vb_geometric: 'Geometric',
            vb_waves: 'Waves',
            vb_home: 'Home Office',
            vb_kitchen: 'Kitchen',
            vb_balcony: 'Balcony',
            // Session
            session_ended_host: 'The producer ended the session.',
            session_ended_timeout: "Producer's connection was lost.",
            session_ended_time_limit: 'The 20-minute limit of the free plan was reached. Subscribe to PRO for unlimited sessions.',
            host_disconnected: 'Producer disconnected. Waiting for reconnection...',
            join_title: 'ACCESS STUDIO',
            join_sub: "You've been invited. Enter your credentials to stream your audio and video in high quality.",
            label_studio_id: 'Studio ID (Room)',
            ph_studio_id: 'Provided by the director',
            err_join_room: 'Enter the room ID',
            err_room_notfound: 'Room not found. Check the ID.',
            err_connection: 'Connection error. Please try again.',
            label_tv_name: 'Your TV Name',
            ph_tv_name: 'How will the audience see you?',
            btn_join: 'JOIN LIVE',
            btn_loading_join: 'Checking...',
            err_api: 'Error creating room. Check your connection.',
            btn_logout: 'Sign out',
            // Host navbar / controls
            btn_record: 'Record',
            label_room: 'ROOM',
            label_room_active: 'ACTIVE ROOM',
            lbl_return: 'Return',
            title_return_audio: 'Return Audio Device',
            title_cam_quality: 'Local camera quality',
            title_settings: 'Production Settings',
            title_end_session: 'End Session',
            // Teleprompter
            label_show_to: 'Show to',
            label_all_guests: 'All Guests',
            ph_prompter: 'Paste the script for guests here...',
            title_scroll: 'Scroll Text',
            title_margin_h: 'Horizontal Margin',
            // Chat
            ph_chat: 'Message to team...',
            // Waiting queue
            label_in_queue: 'In Queue',
            title_approve: 'Approve',
            title_reject: 'Reject',
            // QR Modal
            qr_desc: 'Scan the code with your phone to add it as a secondary camera (Multi-Cam).',
            qr_badge: 'Silent Pairing',
        },
    };

    // Detecta idioma salvo ou do navegador
    const _stored = localStorage.getItem('lyncro-lang');
    let _lang = _stored || (navigator.language && navigator.language.startsWith('pt') ? 'pt' : 'en');

    const _listeners = [];

    function _t(key, vars) {
        const dict = TRANSLATIONS[_lang] || TRANSLATIONS.pt;
        let val = dict[key];
        if (val === undefined) val = (TRANSLATIONS.pt[key] || key);
        if (vars && typeof val === 'string') {
            Object.keys(vars).forEach(k => { val = val.replace('{{' + k + '}}', vars[k]); });
        }
        return val;
    }

    function _applyAll() {
        // Atualiza elementos com data-i18n (textContent)
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const val = _t(el.getAttribute('data-i18n'));
            if (val) el.textContent = val;
        });
        // Atualiza placeholders
        document.querySelectorAll('[data-i18n-ph]').forEach(el => {
            const val = _t(el.getAttribute('data-i18n-ph'));
            if (val) el.placeholder = val;
        });
        // Atualiza titles (tooltips)
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const val = _t(el.getAttribute('data-i18n-title'));
            if (val) el.title = val;
        });
        // Atualiza aria-labels
        document.querySelectorAll('[data-i18n-aria]').forEach(el => {
            const val = _t(el.getAttribute('data-i18n-aria'));
            if (val) el.setAttribute('aria-label', val);
        });
        // Atualiza lang no <html>
        document.documentElement.lang = _lang === 'pt' ? 'pt-BR' : 'en';
        // Atualiza estilo dos botões de idioma
        document.querySelectorAll('[data-lang-btn]').forEach(btn => {
            const active = btn.dataset.langBtn === _lang;
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            btn.style.cssText = active
                ? 'padding:3px 9px;border-radius:7px;font-size:10px;font-weight:800;background:rgba(0,120,212,0.2);color:#0078d4;border:1px solid rgba(0,120,212,0.3);cursor:pointer;transition:all .15s;'
                : 'padding:3px 9px;border-radius:7px;font-size:10px;font-weight:700;background:transparent;color:#6b7280;border:1px solid transparent;cursor:pointer;transition:all .15s;';
        });
        // Remove modal de upgrade em cache para reconstrução com novo idioma
        const modal = document.getElementById('lyncro-upgrade-modal');
        if (modal) modal.remove();
    }

    window.LYNCRO_I18N = {
        getLang: () => _lang,
        t: _t,
        setLang(lang) {
            if (!TRANSLATIONS[lang]) return;
            _lang = lang;
            localStorage.setItem('lyncro-lang', lang);
            _applyAll();
            _listeners.forEach(fn => fn(lang));
        },
        onLangChange(fn) { _listeners.push(fn); },
        apply: _applyAll,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _applyAll);
    } else {
        _applyAll();
    }
})();
