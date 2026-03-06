(function () {
    function applyTheme() {
        const theme = localStorage.getItem('theme') || 'auto';
        const html = document.documentElement;

        if (theme === 'dark') {
            html.classList.add('dark');
        } else if (theme === 'light') {
            html.classList.remove('dark');
        } else {
            // Auto
            if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                html.classList.add('dark');
            } else {
                html.classList.remove('dark');
            }
        }
    }

    applyTheme();

    // Ouvir mudanças na preferência do sistema se estiver em modo auto
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (localStorage.getItem('theme') === 'auto' || !localStorage.getItem('theme')) {
            applyTheme();
        }
    });

    // Expor para uso global se necessário
    window.LYNCRO_THEME = {
        applyTheme: applyTheme,
        setTheme: function (newTheme) {
            localStorage.setItem('theme', newTheme);
            applyTheme();
        }
    };
})();
