/**
 * plan.js — Controle de plano (Freemium vs PRO) no front-end
 *
 * Expõe window.LYNCRO_PLAN com métodos para verificar o plano,
 * iniciar checkout e abrir o portal do cliente Stripe.
 *
 * Depende de window.LYNCRO_AUTH.getFreshSession() para obter o JWT.
 * Depende de window.LYNCRO_I18N.t() para tradução de strings.
 */

(function () {
    'use strict';

    // Helper de tradução — delega ao i18n se disponível
    function _t(key, vars) {
        if (window.LYNCRO_I18N && typeof window.LYNCRO_I18N.t === 'function') {
            return window.LYNCRO_I18N.t(key, vars);
        }
        // Fallback PT básico
        const PT = {
            modal_unlock: 'Desbloqueie todos os recursos.',
            modal_pro_feature: '"{{name}}" é um recurso exclusivo do plano PRO.',
            modal_pro_feature_generic: 'Este recurso é exclusivo do plano PRO.',
            modal_footer: 'Cancele a qualquer momento · Pagamento seguro via Stripe',
            btn_subscribe: 'Assinar', btn_loading: 'Aguarde...',
            free_watermark: "Marca d'água Lyncro", free_720p: 'Até 720p',
            free_20min: 'Chamadas até 20 min', free_no_recording: 'Sem gravação',
            free_no_teleprompter: 'Sem teleprompter', free_no_lower_thirds: 'Sem lower thirds',
            free_no_files: 'Sem arquivos no chat', pro_no_watermark: "Sem marca d'água",
            pro_1080p: '1080p Full HD', pro_unlimited: 'Chamadas ilimitadas',
            pro_recording: 'Gravação de transmissão', pro_teleprompter: 'Teleprompter',
            pro_lower_thirds: 'Lower thirds & letreiros', pro_files: 'Arquivos no chat',
            period_monthly: 'Mensal', period_semiannual: 'Semestral', period_annual: 'Anual',
            sub_monthly: '/mês', sub_semiannual: '/6 meses', sub_annual: '/ano',
            badge_popular: 'Mais popular', savings_16: 'Economia de 16%',
            savings_15: 'Economia de 15%', savings_4mo: '4 meses grátis',
            plan_locked_suffix: '— Upgrade necessário',
            toast_pro: 'Bem-vindo ao PRO! Aproveite todos os recursos.',
            err_checkout: 'Erro ao iniciar pagamento: ', err_portal: 'Erro ao abrir portal: ',
        };
        let val = PT[key] || key;
        if (vars && typeof val === 'string') {
            Object.keys(vars).forEach(k => { val = val.replace('{{' + k + '}}', vars[k]); });
        }
        return val;
    }

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

        isPro() { return _plan === 'pro'; },
        isFree() { return _plan === 'free'; },
        get() { return _plan; },

        require(featureName) {
            if (LYNCRO_PLAN.isPro()) return true;
            LYNCRO_PLAN.showUpgradeModal(featureName);
            return false;
        },

        async startCheckout(planKey) {
            planKey = planKey || 'brl_monthly';
            const btn = document.querySelector(`[data-plan-key="${planKey}"] .plan-cta-btn`);
            try {
                if (btn) { btn.disabled = true; btn.textContent = _t('btn_loading'); }

                const data = await _apiFetch('/api/billing/create-checkout', {
                    method: 'POST',
                    body: JSON.stringify({ planKey }),
                });
                if (data.url) window.location.href = data.url;
            } catch (err) {
                console.error('[plan] Erro ao criar checkout:', err.message);
                alert(_t('err_checkout') + err.message);
                if (btn) { btn.disabled = false; btn.textContent = _t('btn_subscribe'); }
            }
        },

        async openPortal() {
            try {
                const data = await _apiFetch('/api/billing/portal', { method: 'POST' });
                if (data.url) window.open(data.url, '_blank');
            } catch (err) {
                console.error('[plan] Erro ao abrir portal:', err.message);
                alert(_t('err_portal') + err.message);
            }
        },

        showUpgradeModal(featureName) {
            let modal = document.getElementById('lyncro-upgrade-modal');
            if (!modal) {
                modal = _buildUpgradeModal();
                document.body.appendChild(modal);
            }
            const subtitle = modal.querySelector('#upgrade-modal-feature');
            if (subtitle) {
                subtitle.textContent = featureName
                    ? _t('modal_pro_feature', { name: featureName })
                    : _t('modal_pro_feature_generic');
            }
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        },

        closeUpgradeModal() {
            const modal = document.getElementById('lyncro-upgrade-modal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        },

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
                    el.title = (el.getAttribute('data-pro-feature') || 'PRO') + ' ' + _t('plan_locked_suffix');
                }
            });

            const badge = document.getElementById('plan-badge');
            if (badge) {
                badge.textContent = _plan === 'pro' ? 'PRO' : 'FREE';
                badge.className = _plan === 'pro'
                    ? 'text-[9px] font-black px-1.5 py-0.5 rounded bg-win-accent tracking-widest'
                    : 'text-[9px] font-black px-1.5 py-0.5 rounded bg-white/10 tracking-widest';
                // Force white text on PRO regardless of light/dark mode
                badge.style.color = _plan === 'pro' ? '#ffffff' : '';
            }
        },
    };

    // ─── Dados de preço por região (labels usam chaves i18n) ─────────────────────

    const PRICING = {
        brl: {
            label: '🇧🇷 BRL',
            plans: [
                {
                    key: 'brl_monthly',
                    periodKey: 'period_monthly',
                    price: 'R$ 59,90',
                    subKey: 'sub_monthly',
                    badgeKey: null,
                    savingsKey: null,
                },
                {
                    key: 'brl_semiannual',
                    periodKey: 'period_semiannual',
                    price: 'R$ 299,90',
                    subKey: 'sub_semiannual',
                    badgeKey: null,
                    savingsKey: 'savings_16',
                },
                {
                    key: 'brl_annual',
                    periodKey: 'period_annual',
                    price: 'R$ 499,90',
                    subKey: 'sub_annual',
                    badgeKey: 'badge_popular',
                    savingsKey: 'savings_4mo',
                },
            ],
        },
        usd: {
            label: '🇺🇸 USD',
            plans: [
                { key: 'usd_monthly',    periodKey: 'period_monthly',    price: '$ 14.90',  subKey: 'sub_monthly',    badgeKey: null,           savingsKey: null },
                { key: 'usd_semiannual', periodKey: 'period_semiannual', price: '$ 75.90',  subKey: 'sub_semiannual', badgeKey: null,           savingsKey: 'savings_15' },
                { key: 'usd_annual',     periodKey: 'period_annual',     price: '$ 125.00', subKey: 'sub_annual',     badgeKey: 'badge_popular', savingsKey: 'savings_4mo' },
            ],
        },
        eur: {
            label: '🇪🇺 EUR',
            plans: [
                { key: 'eur_monthly',    periodKey: 'period_monthly',    price: '€ 14,90',  subKey: 'sub_monthly',    badgeKey: null,           savingsKey: null },
                { key: 'eur_semiannual', periodKey: 'period_semiannual', price: '€ 75,90',  subKey: 'sub_semiannual', badgeKey: null,           savingsKey: 'savings_15' },
                { key: 'eur_annual',     periodKey: 'period_annual',     price: '€ 125,00', subKey: 'sub_annual',     badgeKey: 'badge_popular', savingsKey: 'savings_4mo' },
            ],
        },
    };

    let _currentRegion = 'brl';

    function _renderPricingCards(region) {
        const { plans } = PRICING[region];
        return plans.map(p => {
            const period   = _t(p.periodKey);
            const sub      = _t(p.subKey);
            const badge    = p.badgeKey   ? _t(p.badgeKey)   : null;
            const savings  = p.savingsKey ? _t(p.savingsKey) : null;
            return `
            <div data-plan-key="${p.key}" class="upgrade-plan-card ${badge ? 'featured' : ''}">
                ${badge ? `<span class="plan-badge">${badge}</span>` : ''}
                <div class="plan-period">${period}</div>
                <div class="plan-price">${p.price}</div>
                <div class="plan-sub">${sub}</div>
                ${savings ? `<div class="plan-savings">${savings}</div>` : '<div style="height:16px;margin-bottom:8px;"></div>'}
                <button class="plan-cta-btn ${badge ? 'featured-btn' : ''}"
                        onclick="window.LYNCRO_PLAN.startCheckout('${p.key}')">
                    ${_t('btn_subscribe')}
                </button>
            </div>`;
        }).join('');
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

    window._lyncroSwitchRegion = _switchRegion;

    // ─── Modal de upgrade ─────────────────────────────────────────────────────────

    function _buildUpgradeModal() {
        const el = document.createElement('div');
        el.id = 'lyncro-upgrade-modal';
        el.className = 'hidden fixed inset-0 z-[9999] items-center justify-center p-4';
        el.style.cssText = 'background: rgba(0,0,0,0.65); backdrop-filter: blur(6px);';

        // Região padrão: BRL para PT, USD para EN
        const defaultRegion = (window.LYNCRO_I18N && window.LYNCRO_I18N.getLang() === 'en') ? 'usd' : 'brl';
        _currentRegion = defaultRegion;

        el.innerHTML = `
            <div id="upgrade-modal-inner">
                <div style="position:absolute;inset:0;pointer-events:none;border-radius:20px;
                            background:radial-gradient(ellipse at 50% 0%, rgba(0,120,212,0.10) 0%, transparent 65%);"></div>

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
                                ${_t('modal_unlock')}
                            </p>
                        </div>
                    </div>
                    <button onclick="window.LYNCRO_PLAN.closeUpgradeModal()" class="modal-close">
                        <i class="ph ph-x" style="font-size:13px;"></i>
                    </button>
                </header>

                <div style="padding:18px 22px;overflow-y:auto;flex:1;">

                    <!-- FREE vs PRO -->
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">

                        <div class="upgrade-tier-col">
                            <div class="upgrade-tier-header free-header">FREE</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> ${_t('free_watermark')}</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> ${_t('free_720p')}</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> ${_t('free_20min')}</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> ${_t('free_no_recording')}</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> ${_t('free_no_teleprompter')}</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> ${_t('free_no_lower_thirds')}</div>
                            <div class="upgrade-tier-row tier-dim"><i class="ph ph-x-circle" style="color:#6b7280;"></i> ${_t('free_no_files')}</div>
                        </div>

                        <div class="upgrade-tier-col pro-col">
                            <div class="upgrade-tier-header pro-header">PRO</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> ${_t('pro_no_watermark')}</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> ${_t('pro_1080p')}</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> ${_t('pro_unlimited')}</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> ${_t('pro_recording')}</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> ${_t('pro_teleprompter')}</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> ${_t('pro_lower_thirds')}</div>
                            <div class="upgrade-tier-row"><i class="ph ph-check-circle" style="color:#34d399;"></i> ${_t('pro_files')}</div>
                        </div>

                    </div>

                    <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:14px;"></div>

                    <!-- Seletor de moeda -->
                    <div style="display:flex;gap:4px;background:rgba(0,0,0,0.3);padding:4px;border-radius:10px;margin-bottom:12px;">
                        ${Object.entries(PRICING).map(([key, val]) => `
                            <button data-region-tab="${key}"
                                    onclick="window._lyncroSwitchRegion('${key}')"
                                    style="${key === defaultRegion
                                        ? 'flex:1;padding:5px 0;border-radius:7px;font-size:10px;font-weight:700;background:rgba(255,255,255,0.08);color:#efefef;border:1px solid rgba(255,255,255,0.1);cursor:pointer;transition:all .15s;'
                                        : 'flex:1;padding:5px 0;border-radius:7px;font-size:10px;font-weight:700;background:transparent;color:#6b7280;border:1px solid transparent;cursor:pointer;transition:all .15s;'}">
                                ${val.label}
                            </button>`).join('')}
                    </div>

                    <!-- Cards de preço -->
                    <div id="upgrade-pricing-cards" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;">
                        ${_renderPricingCards(defaultRegion)}
                    </div>

                    <p style="text-align:center;font-size:9px;color:#374151;letter-spacing:0.05em;">
                        ${_t('modal_footer')}
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
                #upgrade-modal-inner .modal-close:hover { background: rgba(255,255,255,0.1); color: #fff; }
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
                .upgrade-plan-card:hover { border-color: rgba(0,120,212,0.35); background: rgba(0,120,212,0.05); }
                .upgrade-plan-card.featured { border-color: rgba(0,120,212,0.4); background: rgba(0,120,212,0.08); }
                [data-theme="light"] .upgrade-plan-card { border-color: rgba(0,0,0,0.08); background: rgba(0,0,0,0.02); }
                [data-theme="light"] .upgrade-plan-card.featured { border-color: rgba(0,120,212,0.35); background: rgba(0,120,212,0.06); }
                .upgrade-plan-card .plan-period {
                    font-size: 9px; font-weight: 800; text-transform: uppercase;
                    letter-spacing: 0.12em; color: #6b7280; margin-bottom: 4px;
                }
                .upgrade-plan-card .plan-price { font-size: 17px; font-weight: 900; color: #efefef; line-height: 1; }
                [data-theme="light"] .upgrade-plan-card .plan-price { color: #111; }
                .upgrade-plan-card .plan-sub { font-size: 9px; color: #6b7280; margin-bottom: 8px; }
                .upgrade-plan-card .plan-savings {
                    font-size: 8px; font-weight: 700; color: #34d399;
                    background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.2);
                    border-radius: 4px; padding: 1px 5px; display: inline-block;
                    margin-bottom: 8px; letter-spacing: 0.04em;
                }
                .upgrade-plan-card .plan-badge {
                    position: absolute; top: -8px; left: 50%; transform: translateX(-50%);
                    font-size: 8px; font-weight: 900; text-transform: uppercase;
                    letter-spacing: 0.1em; color: #fff; background: #0078d4;
                    border-radius: 4px; padding: 2px 6px; white-space: nowrap;
                }
                .plan-cta-btn {
                    width: 100%; padding: 7px 0; border-radius: 8px;
                    font-size: 10px; font-weight: 800; text-transform: uppercase;
                    letter-spacing: 0.08em; color: #fff;
                    background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12);
                    cursor: pointer; transition: all .15s; margin-top: auto;
                }
                .plan-cta-btn:hover { background: rgba(0,120,212,0.25); border-color: rgba(0,120,212,0.5); }
                .plan-cta-btn.featured-btn { background: #0078d4; border-color: #0078d4; }
                .plan-cta-btn.featured-btn:hover { background: #0069bb; }
                [data-theme="light"] .plan-cta-btn { background: rgba(0,0,0,0.05); border-color: rgba(0,0,0,0.12); color: #374151; }
                [data-theme="light"] .plan-cta-btn.featured-btn { background: #0078d4; border-color: #0078d4; color: #fff; }
            </style>`;

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
            window.addEventListener('lyncro:auth-ready', () => LYNCRO_PLAN.load(), { once: true });
        }
    }

    function _handleCheckoutReturn() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('checkout') === 'success') {
            params.delete('checkout');
            const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
            history.replaceState(null, '', newUrl);

            setTimeout(async () => {
                await LYNCRO_PLAN.load();
                if (LYNCRO_PLAN.isPro()) {
                    _showSuccessToast(_t('toast_pro'));
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

    window.LYNCRO_PLAN = LYNCRO_PLAN;

    // Reconstrói modal quando idioma muda
    if (window.LYNCRO_I18N) {
        window.LYNCRO_I18N.onLangChange(() => {
            const modal = document.getElementById('lyncro-upgrade-modal');
            if (modal) modal.remove();
        });
    }

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
