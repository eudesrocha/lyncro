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
            <div data-plan-key="${p.key}"
                 class="relative flex flex-col rounded-xl border p-3.5 cursor-pointer transition-all
                        ${p.badge ? 'border-purple-500/60 bg-purple-900/20' : 'border-white/10 bg-white/5 hover:border-white/20'}">
                ${p.badge ? `<span class="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-gradient-to-r from-purple-600 to-blue-500 text-white whitespace-nowrap">${p.badge}</span>` : ''}
                <div class="flex items-center justify-between mb-1">
                    <span class="text-[10px] font-bold uppercase tracking-widest text-gray-400">${p.period}</span>
                    ${p.savings ? `<span class="text-[9px] font-bold text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded-full">${p.savings}</span>` : ''}
                </div>
                <div class="flex items-baseline gap-0.5 mb-3">
                    <span class="text-xl font-black text-white">${p.price}</span>
                    <span class="text-[10px] text-gray-500">${p.sub}</span>
                </div>
                <button class="plan-cta-btn w-full py-2 rounded-lg text-[11px] font-bold text-white transition-all
                               ${p.badge ? 'bg-gradient-to-r from-purple-600 to-blue-500 hover:opacity-90' : 'bg-white/10 hover:bg-white/20'}"
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
            t.className = active
                ? 'px-3 py-1 rounded-lg text-[10px] font-bold bg-white/15 text-white transition-all'
                : 'px-3 py-1 rounded-lg text-[10px] font-bold text-gray-500 hover:text-white transition-all';
        });
    }

    // Expõe para uso inline no HTML gerado
    window._lyncroSwitchRegion = _switchRegion;

    // ─── Modal de upgrade (criado dinamicamente) ─────────────────────────────────

    function _buildUpgradeModal() {
        const el = document.createElement('div');
        el.id = 'lyncro-upgrade-modal';
        el.className = 'hidden fixed inset-0 z-[9999] items-center justify-center bg-black/70 backdrop-blur-sm p-4';
        el.innerHTML = `
            <div class="relative w-full max-w-md rounded-2xl border border-white/10 overflow-hidden shadow-2xl"
                 style="background: linear-gradient(160deg, #0e0e1c 0%, #140d2e 100%);">
                <!-- Glow decorativo -->
                <div class="absolute inset-0 pointer-events-none"
                     style="background: radial-gradient(ellipse at 50% 0%, rgba(109,40,217,0.3) 0%, transparent 65%);"></div>

                <div class="relative p-5">
                    <!-- Header -->
                    <div class="flex items-start justify-between mb-4">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                                 style="background: linear-gradient(135deg, #6d28d9, #0078d4);">
                                <i class="ph ph-crown text-lg text-white"></i>
                            </div>
                            <div>
                                <h2 class="text-base font-black text-white leading-tight">Lyncro PRO</h2>
                                <p id="upgrade-modal-feature" class="text-[11px] text-gray-400 leading-tight">
                                    Desbloqueie todos os recursos.
                                </p>
                            </div>
                        </div>
                        <button onclick="window.LYNCRO_PLAN.closeUpgradeModal()"
                                class="text-gray-600 hover:text-white transition-colors p-1 -mr-1 -mt-1">
                            <i class="ph ph-x text-base"></i>
                        </button>
                    </div>

                    <!-- Benefícios (compacto) -->
                    <div class="grid grid-cols-2 gap-1.5 mb-4">
                        <div class="flex items-center gap-1.5 text-[10px] text-gray-300"><i class="ph ph-record text-red-400 shrink-0"></i> Gravação de transmissão</div>
                        <div class="flex items-center gap-1.5 text-[10px] text-gray-300"><i class="ph ph-layout text-purple-400 shrink-0"></i> Layouts CNN & Premium</div>
                        <div class="flex items-center gap-1.5 text-[10px] text-gray-300"><i class="ph ph-users text-blue-400 shrink-0"></i> Até 10 participantes</div>
                        <div class="flex items-center gap-1.5 text-[10px] text-gray-300"><i class="ph ph-text-aa text-green-400 shrink-0"></i> Lower Thirds avançados</div>
                    </div>

                    <!-- Seletor de moeda -->
                    <div class="flex items-center gap-1 mb-3 bg-black/30 p-1 rounded-xl">
                        ${Object.entries(PRICING).map(([key, val]) => `
                            <button data-region-tab="${key}"
                                    onclick="window._lyncroSwitchRegion('${key}')"
                                    class="${key === 'brl' ? 'px-3 py-1 rounded-lg text-[10px] font-bold bg-white/15 text-white transition-all' : 'px-3 py-1 rounded-lg text-[10px] font-bold text-gray-500 hover:text-white transition-all'}">
                                ${val.label}
                            </button>`).join('')}
                    </div>

                    <!-- Cards de preço -->
                    <div id="upgrade-pricing-cards" class="grid grid-cols-3 gap-2 mb-3">
                        ${_renderPricingCards('brl')}
                    </div>

                    <p class="text-center text-[9px] text-gray-600">
                        Cancele a qualquer momento · Pagamento seguro via Stripe
                    </p>
                </div>
            </div>`;

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
