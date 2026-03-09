// Verificação de tokens JWT do Supabase via REST API
// Não requer dependências extras — usa fetch nativo do Node 18+

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

/**
 * Verifica um token JWT do Supabase e retorna o usuário ou null.
 * Faz uma requisição ao endpoint /auth/v1/user usando o token como Bearer.
 */
async function verifySupabaseToken(token) {
    if (!token) return null;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        console.warn('[Auth] SUPABASE_URL ou SUPABASE_ANON_KEY não configurados. Pulando verificação JWT.');
        return null;
    }

    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'apikey': SUPABASE_ANON_KEY
            }
        });

        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.error('[Auth] Erro ao verificar token Supabase:', err.message);
        return null;
    }
}

/**
 * Retorna o plano ('free' | 'pro') de um usuário a partir do userId.
 * Usa SUPABASE_SERVICE_ROLE_KEY (server-side only).
 * Retorna 'free' em caso de erro ou variáveis não configuradas.
 */
async function getUserPlan(userId) {
    if (!userId) return 'free';
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return 'free'; // dev mode: sem restrição

    try {
        const res = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=plan,plan_expires_at&limit=1`, {
            headers: {
                'apikey': key,
                'Authorization': `Bearer ${key}`,
                'Accept': 'application/json'
            }
        });
        if (!res.ok) return 'free';
        const rows = await res.json();
        if (!rows || rows.length === 0) return 'free';
        const { plan, plan_expires_at } = rows[0];
        if (plan === 'pro' && plan_expires_at && new Date(plan_expires_at) < new Date()) {
            return 'free'; // plano expirado
        }
        return plan === 'pro' ? 'pro' : 'free';
    } catch (err) {
        console.error('[Auth] getUserPlan error:', err.message);
        return 'free';
    }
}

module.exports = { verifySupabaseToken, getUserPlan };
