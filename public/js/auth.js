// Configurações do Supabase
const SUPABASE_URL = "https://wcdmvhxixqqnsqudshru.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjZG12aHhpeHFxbnNxdWRzaHJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDE2NjAsImV4cCI6MjA4ODM3NzY2MH0.7UTJVJGEvb09Isrto7FX4gDyr41TdA-ZwLO-Mv92VZw";

// O script do Supabase DEVE ser carregado via <script> tag ANTES deste arquivo.
// Exemplo no HTML:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="js/auth.js"></script>

let supabaseClient = null;

function initSupabase() {
    if (supabaseClient) return supabaseClient;

    if (typeof supabase === 'undefined' || !supabase.createClient) {
        console.error("[Auth] Supabase SDK não encontrado. Verifique se o <script> do CDN está no HTML.");
        return null;
    }

    try {
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log("[Auth] Supabase inicializado com sucesso.");
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
        window.dispatchEvent(new CustomEvent('supabase-ready', { detail: { session } }));
    } catch (err) {
        console.error("[Auth] Erro ao verificar sessão:", err);
        window.dispatchEvent(new CustomEvent('supabase-ready', { detail: { session: null } }));
    }
});

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
        window.location.href = 'index.html';
    },

    async getSession() {
        const client = initSupabase();
        if (!client) return null;
        const { data: { session } } = await client.auth.getSession();
        return session;
    }
};
