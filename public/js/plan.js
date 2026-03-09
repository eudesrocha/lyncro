/**
 * plan.js — Controle de plano (Freemium vs PRO) no front-end
 *
 * Expõe window.LYNCRO_PLAN com métodos para verificar o plano,
 * iniciar checkout e abrir o portal do cliente Stripe.
 *
 * Depende de window.LYNCRO_AUTH.getFreshSession() para obter o JWT.
 */

(function () {
    'use strict';

    // Estado interno
    let _plan = 'free';
    let _loaded = false;
    let _loadPromise = null;

    // ─── Helpers ────────────────────────────────────────────────────────────────

    async function _getToken() {
        if (window.LYNCRO_AUTH && typeof window.LYNCRO_AUTH.getFreshSession === 'function') {
            const session = await window.LYNCRO_AUTH.getFreshSession();
            return session?.access_token || null;
        }
        return null;
    }

    async function _apiFetch(path, options = {}) {
        const token = await _getToken();
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(path, { ...options, headers });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
    }

    // ─── API pública ─────────────────────────────────────────────────────────────

    const LYNCRO_PLAN = {

        /**
         * Carrega o plano do usuário a partir do servidor.
         * Chamado automaticamente ao detectar sessão ativa.
         */
        async load() {
            if (_loadPromise) return _loadPromise;
            _loadPromise = (async () => {
                try {
                    const token = await _getToken();
                    if (!token) { _plan = 'free'; _loaded = true; return; }

                    const data = await _apiFetch('/api/user/plan');
                    _plan = data.plan || 'free';
                    _loaded = true;
                    console.log(`[plan] Plano carregado: ${_plan}`);
                    LYNCRO_PLAN._applyGates();
                } catch (err) {
                    console.warn('[plan] Erro ao carregar plano:', err.message);
                    _plan = 'free';
                    _loaded = true;
                } finally {
                    _loadPromise = null;
                }
            })();
            return _loadPromise;
        },

        /** Retorna true se o usuário tem plano PRO */
        isPro() { return _plan === 'pro'; },

        /** Retorna true se o usuário está no plano gratuito */
        isFree() { return _plan === 'free'; },

        /** Retorna o plano como string ('free' | 'pro') */
        get() { return _plan; },

        /**
         * Verifica se o usuário tem acesso a um recurso PRO.
         * Se não tiver, exibe o modal de upgrade e retorna false.
         * @param {string} [featureName] Nome do recurso (para a mensagem)
         * @returns {boolean}
         */
        require(featureName) {
            if (LYNCRO_PLAN.isPro()) return true;
            LYNCRO_PLAN.showUpgradeModal(featureName);
            return false;
        },

        /**
         * Inicia o fluxo de checkout do Stripe.
         * @param {string} [planKey] Ex: 'brl_monthly', 'brl_annual', 'usd_monthly' etc.
         *                           Padrão: 'brl_monthly'
         */
        async startCheckout(planKey) {
            planKey = planKey || 'brl_monthly';
            const btn = document.querySelector(`[data-plan-key="${planKey}"] .plan-cta-btn`);
            try {
                if (btn) { btn.disabled = true; btn.textContent = 'Aguarde...'; }

                const data = await _apiFetch('/api/billing/create-checkout', {
                    method: 'POST',
                    body: JSON.stringify({ planKey }),
                });
                if (data.url) window.location.href = data.url;
            } catch (err) {
                console.error('[plan] Erro ao criar checkout:', err.message);
                alert('Erro ao iniciar pagamento: ' + err.message);
                if (btn) { btn.disabled = false; btn.textContent = 'Assinar'; }
            }
        },

        /**
         * Abre o portal do cliente Stripe (gerenciar/cancelar assinatura).
         */
        async openPortal() {
            try {
                const data = await _apiFetch('/api/billing/portal', { method: 'POST' });
                if (data.url) window.open(data.url, '_blank');
            } catch (err) {
                console.error('[plan] Erro ao abrir portal:', err.message);
                alert('Erro ao abrir portal: ' + err.message);
            }
        },

        /**
         * Exibe o modal de upgrade.
         * @param {string} [featureName] Nome do recurso bloqueado
         */
        showUpgradeModal(featureName) {
            let modal = document.getElementById('lyncro-upgrade-modal');
            if (!modal) {
                modal = _buildUpgradeModal();
                document.body.appendChild(modal);
            }
            const subtitle = modal.querySelector('#upgrade-modal-feature');
            if (subtitle) {
                subtitle.textContent = featureName
                    ? `"${featureName}" é um recurso exclusivo do plano PRO.`
                    : 'Este recurso é exclusivo do plano PRO.';
            }
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        },

        /** Fecha o modal de upgrade */
        closeUpgradeModal() {
            const modal = document.getElementById('lyncro-upgrade-modal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        },

        /**
         * Aplica gates de UI com base no plano atual.
         * Elementos com data-pro-feature ficam bloqueados para usuários free.
         */
        _applyGates() {
            document.querySelectorAll('[data-pro-feature]').forEach(el => {
                if (LYNCRO_PLAN.isPro()) {
                    el.removeAttribute('data-plan-locked');
                    el.title = el.getAttribute('data-original-title') || '';
                } else {
                    el.setAttribute('data-plan-locked', 'true');
                    if (!el.getAttribute('data-original-title')) {
                        el.setAttribute('data-original-title', el.title);
                    }
                    el.title = (el.getAttribute('data-pro-feature') || 'Recurso PRO') + ' — Upgrade necessário';
                }
            });

            // Badge PRO no header se aplicável
            const badge = document.getElementById('plan-badge');
            if (badge) {
                badge.textContent = _plan === 'pro' ? 'PRO' : 'FREE';
                badge.className = _plan === 'pro'
                    ? 'text-[9px] font-black px-1.5 py-0.5 rounded bg-win-accent text-white tracking-widest'
                    : 'text-[9px] font-black px-1.5 py-0.5 rounded bg-white/10 text-gray-400 tracking-widest';
            }
        },
    };

    // ─── Dados de preço por região ────────────────────────────────────────────────

    const PRICING = {
        brl: {
            label: '🇧🇷 BRL',
            plans: [
                {
                    key: 'brl_monthly',
                    period: 'Mensal',
                    price: 'R$ 59,90',
                    sub: '/mês',
                    badge: null,
                    savings: null,
                },
                {
                    key: 'brl_semiannual',
                    period: 'Semestral',
                    price: 'R$ 299,90',
                    sub: '/6 meses',
                    badge: null,
                    savings: 'Economia de 16%',
                },
                {
                    key: 'brl_annual',
                    period: 'Anual',
                    price: 'R$ 499,90',
                    sub: '/ano',
                    badge: 'Mais popular',
                    savings: '4 meses grátis',
                },
            ],
        },
        usd: {
            label: '🇺🇸 USD',
            plans: [
                { key: 'usd_monthly',    period: 'Monthly',     price: '$ 14.90', sub: '/mo',  badge: null,         savings: null },
                { key: 'usd_semiannual', period: 'Semiannual',  price: '$ 75.90', sub: '/6mo', badge: null,         savings: 'Save 15%' },
                { key: 'usd_annual',     period: 'Annual',      price: '$ 125.00',sub: '/yr',  badge: 'Most popular',savings: '4 months free' },
            ],
        },
        eur: {
            label: '🇪🇺 EUR',
            plans: [
                { key: 'eur_monthly',    period: 'Mensuel',     price: '€ 14,90', sub: '/mois',badge: null,         savings: null },
                { key: 'eur_semiannual', period: 'Semestriel',  price: '€ 75,90', sub: '/6mo', badge: null,         savings: 'Économie 15%' },
                { key: 'eur_annual',     period: 'Annuel',      price: '€ 125,00',sub: '/an',  badge: 'Populaire',  savings: '4 mois gratuits' },
            ],
        },
    };

    let _currentRegion = 'brl';

    function _renderPricingCards(region) {
        const { plans } = PRICING[region];
        return plans.map(p => `
            <div data-plan-key="${p.key}" class="upgrade-plan-card ${p.badge ? 'featured' : ''}">
                ${p.badge ? `<span class="plan-badge">${p.badge}</span>` : ''}
                <div class="plan-period">${p.period}</div>
                <div class="plan-price">${p.price}</div>
                <div class="plan-sub">${p.sub}</div>
                ${p.savings ? `<div class="plan-savings">${p.savings}</div>` : '<div style="height:16px;margin-bottom:8px;"></div>'}
                <button class="plan-cta-btn ${p.badge ? 'featured-btn' : ''}"
                        onclick="window.LYNCRO_PLAN.startCheckout('${p.key}')">
                    Assinar
                </button>
            </div>`).join('');
    }

    function _switchRegion(region) {
        _currentRegion = region;
        const container = document.getElementById('upgrade-pricing-cards');
        const tabs = document.querySelectorAll('[data-region-tab]');
        if (container) container.innerHTML = _renderPricingCards(region);
        tabs.forEach(t => {
            const active = t.dataset.regionTab === region;
            t.style.cssText = active
                ? 'flex:1;padding:5px 0;border-radius:7px;font-size:10px;font-weight:700;background:rgba(255,255,255,0.08);color:#efefef;border:1px solid rgba(255,255,255,0.1);cursor:pointer;transition:all .15s;'
                : 'flex:1;padding:5px 0;border-radius:7px;font-size:10px;font-weight:700;background:transparent;color:#6b7280;border:1px solid transparent;cursor:pointer;transition:all .15s;';
        });
    }

    // Expõe para uso inline no HTML gerado
    window._lyncroSwitchRegion = _switchRegion;

    // ─── Modal de upgrade (criado dinamicamente) ─────────────────────────────────

    function _buildUpgradeModal() {
        const el = document.createElement('div');
        el.id = 'lyncro-upgrade-modal';
        el.className = 'hidden fixed inset-0 z-[9999] items-center justify-center p-4';
        el.style.cssText = 'background: rgba(0,0,0,0.65); backdrop-filter: blur(6px);';

        el.innerHTML = `
            <div id="upgrade-modal-inner">
                <!-- Glow superior sutil -->
                <div style="position:absolute;inset:0;pointer-events:none;border-radius:20px;
                            background:radial-gradient(ellipse at 50% 0%, rgba(0,120,212,0.10) 0%, transparent 65%);"></div>

                <!-- Header -->
                <header style="display:flex;align-items:center;justify-content:space-between;
                               padding:18px 22px;border-bottom:1px solid rgba(255,255,255,0.05);
                               background:linear-gradient(to bottom,rgba(255,255,255,0.03),transparent);
                               flex-shrink:0;">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <div style="width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;
                                    background:linear-gradient(135deg,rgba(0,120,212,0.3),rgba(0,120,212,0.1));
                                    border:1px solid rgba(0,120,212,0.3);">
                            <i class="ph ph-crown" style="color:#0078d4;font-size:15px;"></i>
                        </div>
                        <div>
                            <div class="modal-title" style="display:flex;align-items:center;gap:8px;">
                                LYNCRO PRO
                                <span style="font-size:9px;font-weight:900;padding:2px 6px;border-radius:4px;
                                             background:rgba(0,120,212,0.2);color:#0078d4;letter-spacing:0.1em;border:1px solid rgba(0,120,212,0.3);">
                                    UPGRADE
                                </span>
                            </div>
                            <p id="upgrade-modal-feature"
                               style="font-size:11px;color:#6b7280;margin-top:1px;font-weight:500;">
                                Desbloqueie todos os recursos.
                            </p>
                        </div>
                    </div>
                    <button onclick="window.LYNCRO_PLAN.closeUpgradeModal()" class="modal-close">
                        <i class="ph ph-x" style="font-size:13px;"></i>
                    </button>
                </header>

                <!-- Body -->
                <div style="padding:18px 22px;overflow-y:auto;flex:1;">

                    <!-- Comparativo FREE vs PRO -->
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">

                        <!-- Coluna FREE -->
                        <div class="upgrade-tier-col">
                            <div class="upgrade-tier-header free-header">FREE</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> Marca d'água Lyncro</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> Até 720p</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> Chamadas até 20 min</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> Sem gravação</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> Sem teleprompter</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> Sem lower thirds</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> Sem arquivos no chat</div>
                        </div>

                        <!-- Coluna PRO -->
                        <div class="upgrade-tier-col pro-col">
                            <div class="upgrade-tier-header pro-header">PRO</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> Sem marca d'água</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> 1080p Full HD</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> Chamadas ilimitadas</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> Gravação de transmissão</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> Teleprompter</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> Lower thirds & letreiros</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> Arquivos no chat</div>
                        </div>

                    </div>

                    <!-- Divider -->
                    <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:14px;"></div>

                    <!-- Seletor de moeda -->
                    <div style="display:flex;gap:4px;background:rgba(0,0,0,0.3);padding:4px;border-radius:10px;margin-bottom:12px;">
                        ${Object.entries(PRICING).map(([key, val]) => `
                            <button data-region-tab="${key}"
                                    onclick="window._lyncroSwitchRegion('${key}')"
                                    style="${key === 'brl'
                                        ? 'flex:1;padding:5px 0;border-radius:7px;font-size:10px;font-weight:700;background:rgba(255,255,255,0.08);color:#efefef;border:1px solid rgba(255,255,255,0.1);cursor:pointer;transition:all .15s;'
                                        : 'flex:1;padding:5px 0;border-radius:7px;font-size:10px;font-weight:700;background:transparent;color:#6b7280;border:1px solid transparent;cursor:pointer;transition:all .15s;'}">
                                ${val.label}
                            </button>`).join('')}
                    </div>

                    <!-- Cards de preço -->
                    <div id="upgrade-pricing-cards" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;">
                        ${_renderPricingCards('brl')}
                    </div>

                    <p style="text-align:center;font-size:9px;color:#374151;letter-spacing:0.05em;">
                        Cancele a qualquer momento &middot; Pagamento seguro via Stripe
                    </p>
                </div>
            </div>

            <style>
                #upgrade-modal-inner {
                    position: relative;
                    width: 100%;
                    max-width: 460px;
                    background: rgba(16, 26, 34, 0.92);
                    backdrop-filter: blur(24px);
                    -webkit-backdrop-filter: blur(24px);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    border-radius: 20px;
                    box-shadow: 0 25px 60px rgba(0,0,0,0.7), inset 0 0 0 1px rgba(255,255,255,0.02);
                    max-height: calc(100vh - 2rem);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                [data-theme="light"] #upgrade-modal-inner {
                    background: rgba(255, 255, 255, 0.95);
                    border-color: rgba(0,0,0,0.07);
                    box-shadow: 0 25px 60px rgba(0,0,0,0.15);
                }
                #upgrade-modal-inner .modal-title {
                    font-size: 12px;
                    font-weight: 800;
                    text-transform: uppercase;
                    letter-spacing: 0.15em;
                    color: #efefef;
                }
                [data-theme="light"] #upgrade-modal-inner .modal-title { color: #111; }
                [data-theme="light"] #upgrade-modal-inner p,
                [data-theme="light"] #upgrade-modal-inner div { color: inherit; }
                #upgrade-modal-inner .modal-close {
                    background: rgba(255,255,255,0.05);
                    border: 1px solid rgba(255,255,255,0.1);
                    color: #9ca3af;
                    cursor: pointer;
                    width: 30px;
                    height: 30px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 9px;
                    transition: all 0.15s;
                    flex-shrink: 0;
                }
                #upgrade-modal-inner .modal-close:hover {
                    background: rgba(255,255,255,0.1);
                    color: #fff;
                }
                [data-theme="light"] #upgrade-modal-inner .modal-close {
                    background: rgba(0,0,0,0.04);
                    border-color: rgba(0,0,0,0.1);
                    color: #6b7280;
                }
                .upgrade-tier-col {
                    border-radius: 10px;
                    border: 1px solid rgba(255,255,255,0.07);
                    background: rgba(255,255,255,0.02);
                    overflow: hidden;
                }
                .upgrade-tier-col.pro-col {
                    border-color: rgba(0,120,212,0.3);
                    background: rgba(0,120,212,0.05);
                }
                [data-theme="light"] .upgrade-tier-col { border-color: rgba(0,0,0,0.08); background: rgba(0,0,0,0.02); }
                [data-theme="light"] .upgrade-tier-col.pro-col { border-color: rgba(0,120,212,0.25); background: rgba(0,120,212,0.04); }
                .upgrade-tier-header {
                    font-size: 9px;
                    font-weight: 900;
                    text-transform: uppercase;
                    letter-spacing: 0.15em;
                    text-align: center;
                    padding: 6px 4px;
                    border-bottom: 1px solid rgba(255,255,255,0.06);
                }
                .free-header { color: #6b7280; background: rgba(255,255,255,0.02); }
                .pro-header  { color: #0078d4; background: rgba(0,120,212,0.08); border-color: rgba(0,120,212,0.15); }
                [data-theme="light"] .free-header { color: #9ca3af; }
                [data-theme="light"] .pro-header  { color: #0078d4; background: rgba(0,120,212,0.06); }
                .upgrade-tier-row {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 10px;
                    font-weight: 500;
                    color: #d1d5db;
                    padding: 5px 8px;
                    border-bottom: 1px solid rgba(255,255,255,0.03);
                }
                .upgrade-tier-row:last-child { border-bottom: none; }
                .upgrade-tier-row.tier-dim { color: #4b5563; }
                [data-theme="light"] .upgrade-tier-row { color: #374151; }
                [data-theme="light"] .upgrade-tier-row.tier-dim { color: #9ca3af; }
                .upgrade-plan-card {
                    position: relative;
                    display: flex;
                    flex-direction: column;
                    border-radius: 12px;
                    border: 1px solid rgba(255,255,255,0.08);
                    background: rgba(255,255,255,0.03);
                    padding: 10px;
                    cursor: pointer;
                    transition: border-color .15s, background .15s;
                }
                .upgrade-plan-card:hover {
                    border-color: rgba(0,120,212,0.35);
                    background: rgba(0,120,212,0.05);
                }
                .upgrade-plan-card.featured {
                    border-color: rgba(0,120,212,0.4);
                    background: rgba(0,120,212,0.08);
                }
                [data-theme="light"] .upgrade-plan-card {
                    border-color: rgba(0,0,0,0.08);
                    background: rgba(0,0,0,0.02);
                }
                [data-theme="light"] .upgrade-plan-card.featured {
                    border-color: rgba(0,120,212,0.35);
                    background: rgba(0,120,212,0.06);
                }
                .upgrade-plan-card .plan-period {
                    font-size: 9px;
                    font-weight: 800;
                    text-transform: uppercase;
                    letter-spacing: 0.12em;
                    color: #6b7280;
                    margin-bottom: 4px;
                }
                .upgrade-plan-card .plan-price {
                    font-size: 17px;
                    font-weight: 900;
                    color: #efefef;
                    line-height: 1;
                }
                [data-theme="light"] .upgrade-plan-card .plan-price { color: #111; }
                .upgrade-plan-card .plan-sub {
                    font-size: 9px;
                    color: #6b7280;
                    margin-bottom: 8px;
                }
                .upgrade-plan-card .plan-savings {
                    font-size: 8px;
                    font-weight: 700;
                    color: #34d399;
                    background: rgba(52,211,153,0.1);
                    border: 1px solid rgba(52,211,153,0.2);
                    border-radius: 4px;
                    padding: 1px 5px;
                    display: inline-block;
                    margin-bottom: 8px;
                    letter-spacing: 0.04em;
                }
                .upgrade-plan-card .plan-badge {
                    position: absolute;
                    top: -8px;
                    left: 50%;
                    transform: translateX(-50%);
                    font-size: 8px;
                    font-weight: 900;
                    text-transform: uppercase;
                    letter-spacing: 0.1em;
                    color: #fff;
                    background: #0078d4;
                    border-radius: 4px;
                    padding: 2px 6px;
                    white-space: nowrap;
                }
                .plan-cta-btn {
                    width: 100%;
                    padding: 7px 0;
                    border-radius: 8px;
                    font-size: 10px;
                    font-weight: 800;
                    text-transform: uppercase;
                    letter-spacing: 0.08em;
                    color: #fff;
                    background: rgba(255,255,255,0.07);
                    border: 1px solid rgba(255,255,255,0.12);
                    cursor: pointer;
                    transition: all .15s;
                    margin-top: auto;
                }
                .plan-cta-btn:hover { background: rgba(0,120,212,0.25); border-color: rgba(0,120,212,0.5); }
                .plan-cta-btn.featured-btn {
                    background: #0078d4;
                    border-color: #0078d4;
                }
                .plan-cta-btn.featured-btn:hover { background: #0069bb; }
                [data-theme="light"] .plan-cta-btn { background: rgba(0,0,0,0.05); border-color: rgba(0,0,0,0.12); color: #374151; }
                [data-theme="light"] .plan-cta-btn.featured-btn { background: #0078d4; border-color: #0078d4; color: #fff; }
            </style>`;

        // Fecha ao clicar no backdrop
        el.addEventListener('click', (e) => {
            if (e.target === el) LYNCRO_PLAN.closeUpgradeModal();
        });

        return el;
    }

    // ─── Auto-load ao detectar sessão ────────────────────────────────────────────

    function _tryAutoLoad() {
        if (window.LYNCRO_AUTH) {
            LYNCRO_PLAN.load();
        } else {
            // Aguarda LYNCRO_AUTH ficar disponível
            window.addEventListener('lyncro:auth-ready', () => LYNCRO_PLAN.load(), { once: true });
        }
    }

    // Verifica parâmetro de checkout na URL
    function _handleCheckoutReturn() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('checkout') === 'success') {
            // Remove o parâmetro da URL sem recarregar a página
            params.delete('checkout');
            const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
            history.replaceState(null, '', newUrl);

            // Recarrega o plano do servidor (pode levar alguns segundos para o webhook processar)
            setTimeout(async () => {
                await LYNCRO_PLAN.load();
                if (LYNCRO_PLAN.isPro()) {
                    _showSuccessToast('Bem-vindo ao PRO! Aproveite todos os recursos.');
                }
            }, 2000);
        }
    }

    function _showSuccessToast(msg) {
        const toast = document.createElement('div');
        toast.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[9999] px-4 py-3 rounded-xl text-sm font-semibold text-white shadow-lg';
        toast.style.background = 'linear-gradient(90deg, #6d28d9, #0078d4)';
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
    }

    // Expõe globalmente
    window.LYNCRO_PLAN = LYNCRO_PLAN;

    // Inicia quando o DOM estiver pronto
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            _handleCheckoutReturn();
            _tryAutoLoad();
        });
    } else {
        _handleCheckoutReturn();
        _tryAutoLoad();
    }

})();
