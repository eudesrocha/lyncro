const SUPABASE_URL = "https://wcdmvhxixqqnsqudshru.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjZG12aHhpeHFxbnNxdWRzaHJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDE2NjAsImV4cCI6MjA4ODM3NzY2MH0.7UTJVJGEvb09Isrto7FX4gDyr41TdA-ZwLO-Mv92VZw";

/**
 * Inicializa o cliente Supabase de forma segura.
 * Tenta usar o script carregado estaticamente no HTML.
 */
function initSupabase() {
    if (typeof supabase === 'undefined') {
        console.error("Erro: Script do Supabase não foi carregado corretamente.");
        return null;
    }

    // Evita múltiplas inicializações
    if (window.supabaseClient) return window.supabaseClient;

    try {
        window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log("Supabase inicializado com sucesso.");
        return window.supabaseClient;
    } catch (error) {
        console.error("Erro ao inicializar Supabase:", error);
        return null;
    }
}

// Inicialização imediata se o script já estiver lá
document.addEventListener('DOMContentLoaded', () => {
    initSupabase();
});

async function signInWithEmail(email) {
    const supabase = initSupabase();
    if (!supabase) return { error: { message: "Supabase não disponível" } };

    const { data, error } = await supabase.auth.signInWithOtp({
        email: email,
        options: {
            emailRedirectTo: window.location.origin,
        },
    });
    return { data, error };
}

async function signInWithGoogle() {
    const supabase = initSupabase();
    if (!supabase) return { error: { message: "Supabase não disponível" } };

    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: window.location.origin,
        },
    });
    return { data, error };
}

async function signOut() {
    const supabase = initSupabase();
    if (!supabase) return;
    await supabase.auth.signOut();
    window.location.reload();
}

async function getSession() {
    const supabase = initSupabase();
    if (!supabase) return { data: { session: null } };
    return await supabase.auth.getSession();
}
