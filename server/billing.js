'use strict';

/**
 * billing.js — Stripe + Supabase subscription routes
 *
 * IMPORTANT: This router must be registered in index.js BEFORE app.use(express.json())
 * so that POST /api/billing/webhook receives the raw body for signature verification.
 */

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Lazy-init Stripe so the server still boots if STRIPE_SECRET_KEY is not set
let _stripe = null;
function getStripe() {
    if (!_stripe) {
        if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY não configurado');
        _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    }
    return _stripe;
}

// Supabase admin client (service role — server-side only, never exposed to the browser)
function getSupabaseAdmin() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurado');
    }
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─── Helper: extrai o usuário autenticado do JWT enviado pelo front-end ──────
async function getAuthUser(req) {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token) return null;

    const supabase = getSupabaseAdmin();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
}

// ─── Helper: atualiza o perfil no Supabase ────────────────────────────────────
async function updateProfile(userId, fields) {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
        .from('profiles')
        .update(fields)
        .eq('id', userId);
    if (error) throw error;
}

// ─── Helper: obtém o perfil do usuário ───────────────────────────────────────
async function getProfile(userId) {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
        .from('profiles')
        .select('plan, stripe_customer_id, stripe_subscription_id, plan_expires_at')
        .eq('id', userId)
        .single();
    if (error) throw error;
    return data;
}

// ─── Helper: obtém ou cria Stripe Customer para o usuário ────────────────────
async function getOrCreateStripeCustomer(user, profile) {
    const stripe = getStripe();

    if (profile.stripe_customer_id) {
        return profile.stripe_customer_id;
    }

    const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
    });

    await updateProfile(user.id, { stripe_customer_id: customer.id });
    return customer.id;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROTAS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/user/plan
// Retorna o plano atual do usuário autenticado
router.get('/api/user/plan', async (req, res) => {
    try {
        const user = await getAuthUser(req);
        if (!user) return res.status(401).json({ error: 'Não autenticado' });

        const profile = await getProfile(user.id);

        // Verifica se o plano expirou
        let plan = profile.plan || 'free';
        if (plan === 'pro' && profile.plan_expires_at) {
            if (new Date(profile.plan_expires_at) < new Date()) {
                plan = 'free';
                await updateProfile(user.id, { plan: 'free' });
            }
        }

        res.json({
            plan,
            stripe_subscription_id: profile.stripe_subscription_id || null,
            plan_expires_at: profile.plan_expires_at || null,
        });
    } catch (err) {
        console.error('[billing] GET /api/user/plan error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Mapa de planKey → nome da env var do Price ID
const PRICE_ENV_MAP = {
    brl_monthly:     'STRIPE_PRICE_PRO_BRL_MONTHLY',
    brl_semiannual:  'STRIPE_PRICE_PRO_BRL_SEMIANNUAL',
    brl_annual:      'STRIPE_PRICE_PRO_BRL_ANNUAL',
    usd_monthly:     'STRIPE_PRICE_PRO_USD_MONTHLY',
    usd_semiannual:  'STRIPE_PRICE_PRO_USD_SEMIANNUAL',
    usd_annual:      'STRIPE_PRICE_PRO_USD_ANNUAL',
    eur_monthly:     'STRIPE_PRICE_PRO_EUR_MONTHLY',
    eur_semiannual:  'STRIPE_PRICE_PRO_EUR_SEMIANNUAL',
    eur_annual:      'STRIPE_PRICE_PRO_EUR_ANNUAL',
    // fallback genérico (legado)
    default:         'STRIPE_PRICE_PRO',
};

function resolvePriceId(planKey) {
    const envVar = PRICE_ENV_MAP[planKey] || PRICE_ENV_MAP['default'];
    const priceId = process.env[envVar] || process.env.STRIPE_PRICE_PRO;
    if (!priceId) throw new Error(`Price ID não configurado para plano "${planKey}" (env: ${envVar})`);
    return priceId;
}

// POST /api/billing/create-checkout
// Cria uma sessão do Stripe Checkout (modo subscription)
// Body: { planKey: 'brl_monthly' | 'brl_semiannual' | 'brl_annual' | 'usd_*' | 'eur_*' }
router.post('/api/billing/create-checkout', express.json(), async (req, res) => {
    try {
        const user = await getAuthUser(req);
        if (!user) return res.status(401).json({ error: 'Não autenticado' });

        const planKey = req.body?.planKey || 'default';
        if (!PRICE_ENV_MAP[planKey]) {
            return res.status(400).json({ error: `planKey inválido: ${planKey}` });
        }

        const priceId = resolvePriceId(planKey);
        const profile = await getProfile(user.id);
        const customerId = await getOrCreateStripeCustomer(user, profile);
        const stripe = getStripe();

        const origin = req.headers.origin || process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${origin}/?checkout=success`,
            cancel_url:  `${origin}/?checkout=cancelled`,
            client_reference_id: user.id,
            subscription_data: {
                metadata: { supabase_user_id: user.id },
            },
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('[billing] POST /api/billing/create-checkout error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/billing/portal
// Cria uma sessão do Stripe Customer Portal (gerenciar/cancelar assinatura)
router.post('/api/billing/portal', express.json(), async (req, res) => {
    try {
        const user = await getAuthUser(req);
        if (!user) return res.status(401).json({ error: 'Não autenticado' });

        const profile = await getProfile(user.id);
        if (!profile.stripe_customer_id) {
            return res.status(400).json({ error: 'Nenhuma assinatura encontrada' });
        }

        const stripe = getStripe();
        const origin = req.headers.origin || process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

        const session = await stripe.billingPortal.sessions.create({
            customer: profile.stripe_customer_id,
            return_url: origin,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('[billing] POST /api/billing/portal error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/billing/webhook
// Recebe eventos do Stripe (DEVE usar express.raw para verificação de assinatura)
router.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        console.error('[billing] STRIPE_WEBHOOK_SECRET não configurado');
        return res.status(500).send('Webhook secret não configurado');
    }

    let event;
    try {
        const stripe = getStripe();
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('[billing] Webhook signature inválida:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`[billing] Webhook recebido: ${event.type}`);

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const userId = session.client_reference_id || session.subscription_data?.metadata?.supabase_user_id;
                if (!userId) { console.warn('[billing] checkout.session.completed sem user ID'); break; }

                const stripe = getStripe();
                const subscription = await stripe.subscriptions.retrieve(session.subscription);
                const expiresAt = new Date(subscription.current_period_end * 1000).toISOString();

                await updateProfile(userId, {
                    plan: 'pro',
                    stripe_subscription_id: subscription.id,
                    plan_expires_at: expiresAt,
                });
                console.log(`[billing] Usuário ${userId} agora é PRO até ${expiresAt}`);
                break;
            }

            case 'customer.subscription.updated': {
                const sub = event.data.object;
                const userId = sub.metadata?.supabase_user_id;
                if (!userId) { console.warn('[billing] subscription.updated sem user ID'); break; }

                const isActive = ['active', 'trialing'].includes(sub.status);
                const expiresAt = new Date(sub.current_period_end * 1000).toISOString();

                await updateProfile(userId, {
                    plan: isActive ? 'pro' : 'free',
                    stripe_subscription_id: sub.id,
                    plan_expires_at: isActive ? expiresAt : null,
                });
                console.log(`[billing] Assinatura ${sub.id} atualizada: status=${sub.status}`);
                break;
            }

            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const userId = sub.metadata?.supabase_user_id;
                if (!userId) { console.warn('[billing] subscription.deleted sem user ID'); break; }

                await updateProfile(userId, {
                    plan: 'free',
                    stripe_subscription_id: null,
                    plan_expires_at: null,
                });
                console.log(`[billing] Assinatura ${sub.id} cancelada — usuário ${userId} voltou ao free`);
                break;
            }

            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                // Apenas loga — o Stripe vai tentar novamente; se falhar definitivamente,
                // dispara customer.subscription.deleted
                console.warn(`[billing] Pagamento falhou: invoice ${invoice.id} customer ${invoice.customer}`);
                break;
            }

            default:
                // Ignora eventos não tratados
                break;
        }
    } catch (err) {
        console.error(`[billing] Erro processando evento ${event.type}:`, err.message);
        // Retorna 200 mesmo assim para evitar reenvios desnecessários do Stripe
    }

    res.json({ received: true });
});

module.exports = router;
