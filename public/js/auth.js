// Configurações do Supabase
const SUPABASE_URL = "https://wcdmvhxixqqnsqudshru.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjZG12aHhpeHFxbnNxdWRzaHJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDE2NjAsImV4cCI6MjA4ODM3NzY2MH0.7UTJVJGEvb09Isrto7FX4gDyr41TdA-ZwLO-Mv92VZw";

// O script do Supabase DEVE ser carregado via <script> tag ANTES deste arquivo.
// Exemplo no HTML:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="js/auth.js"></script>

let supabaseClient = null;
let _currentSession = null; // Sessão mantida em memória pelo listener

function initSupabase() {
    if (supabaseClient) return supabaseClient;

    if (typeof supabase === 'undefined' || !supabase.createClient) {
        console.error("[Auth] Supabase SDK não encontrado. Verifique se o <script> do CDN está no HTML.");
        return null;
    }

    try {
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log("[Auth] Supabase inicializado com sucesso.");

        // Listener de mudança de estado de autenticação.
        // Mantém a sessão sempre atualizada em memória, inclusive após
        // TOKEN_REFRESHED (refresh automático do SDK ~a cada 1h).
        supabaseClient.auth.onAuthStateChange((event, session) => {
            _currentSession = session;
            console.log(`[Auth] Estado alterado: ${event}`, session ? `(expira em ${Math.round((session.expires_at * 1000 - Date.now()) / 60000)}min)` : '(sem sessão)');
        });

        return supabaseClient;
    } catch (err) {
        console.error("[Auth] Erro ao criar client:", err);
        return null;
    }
}

// Inicializar assim que o DOM estiver pronto e verificar sessão
document.addEventListener('DOMContentLoaded', async () => {
    const client = initSupabase();
    if (!client) return;

    try {
        const { data: { session } } = await client.auth.getSession();
        _currentSession = session;
        window.dispatchEvent(new CustomEvent('supabase-ready', { detail: { session } }));
    } catch (err) {
        console.error("[Auth] Erro ao verificar sessão:", err);
        window.dispatchEvent(new CustomEvent('supabase-ready', { detail: { session: null } }));
    }
});

/**
 * Retorna uma sessão com token garantidamente válido.
 * Se o token expira em menos de 5 minutos, força um refresh antes de retornar.
 * Isso evita que reconexões WebSocket enviem tokens expirados.
 */
async function getFreshSession() {
    const client = initSupabase();
    if (!client) return null;

    try {
        // Primeiro tenta pegar a sessão atual do SDK
        const { data: { session } } = await client.auth.getSession();
        if (!session) return null;

        // Verificar se o token está prestes a expirar (dentro de 5 minutos)
        const expiresAt = session.expires_at * 1000; // converter para ms
        const timeUntilExpiry = expiresAt - Date.now();
        const FIVE_MINUTES = 5 * 60 * 1000;

        if (timeUntilExpiry < FIVE_MINUTES) {
            console.log(`[Auth] Token expira em ${Math.round(timeUntilExpiry / 1000)}s. Forçando refresh...`);
            const { data, error } = await client.auth.refreshSession();
            if (error) {
                console.error("[Auth] Falha ao renovar sessão:", error.message);
                return null; // Sessão realmente expirada, precisa re-login
            }
            _currentSession = data.session;
            console.log("[Auth] Token renovado com sucesso.");
            return data.session;
        }

        _currentSession = session;
        return session;
    } catch (err) {
        console.error("[Auth] Erro ao obter sessão fresca:", err);
        return null;
    }
}

// API pública para login/logout
window.LYNCRO_AUTH = {
    async loginWithEmail(email) {
        const client = initSupabase();
        if (!client) throw new Error("Supabase não está pronto. Recarregue a página.");

        const { error } = await client.auth.signInWithOtp({
            email,
            options: {
                emailRedirectTo: window.location.origin,
            },
        });
        if (error) throw error;
        return true;
    },

    async loginWithGoogle() {
        const client = initSupabase();
        if (!client) throw new Error("Supabase não está pronto. Recarregue a página.");

        const { error } = await client.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin,
            },
        });
        if (error) throw error;
    },

    async logout() {
        const client = initSupabase();
        if (client) await client.auth.signOut();
        _currentSession = null;
        window.location.href = 'index.html';
    },

    // Retorna a sessão atual (pode ter token expirado — use getFreshSession para garantia)
    async getSession() {
        const client = initSupabase();
        if (!client) return null;
        const { data: { session } } = await client.auth.getSession();
        return session;
    },

    // Retorna sessão com token garantidamente válido (faz refresh se necessário)
    getFreshSession
};
