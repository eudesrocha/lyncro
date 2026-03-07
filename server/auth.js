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

module.exports = { verifySupabaseToken };
