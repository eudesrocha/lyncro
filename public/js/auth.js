// Configurações do Supabase extraídas da imagem enviada pelo usuário
const SUPABASE_URL = "https://wcdmvhxixqqnsqudshru.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjZG12aHhpeHFxbnNxdWRzaHJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDE2NjAsImV4cCI6MjA4ODM3NzY2MH0.7UTJVJGEvb09Isrto7FX4gDyr41TdA-ZwLO-Mv92VZw";

// Importante: sb_publishable é a chave recomendada para novos projetos.
// Se precisar da Anon Key (legacy), o usuário pode trocar depois, 
// mas usaremos a publishable conforme a interface moderna do Supabase.

// Carregar o cliente Supabase do CDN
const script = document.createElement('script');
script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
document.head.appendChild(script);

let supabase;

script.onload = () => {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    checkSession();
};

async function checkSession() {
    const { data: { session } } = await supabase.auth.getSession();
    window.dispatchEvent(new CustomEvent('supabase-ready', { detail: { session } }));
}

window.LYNCRO_AUTH = {
    async loginWithEmail(email) {
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
                emailRedirectTo: window.location.origin,
            },
        });
        if (error) throw error;
        return true;
    },

    async loginWithGoogle() {
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin,
            },
        });
        if (error) throw error;
    },

    async logout() {
        await supabase.auth.signOut();
        window.location.href = 'index.html';
    },

    async getSession() {
        const { data: { session } } = await supabase.auth.getSession();
        return session;
    }
};
