/**
 * Lyncro — Sistema de Temas
 * Gerencia dark/light mode com persistência via localStorage.
 * Adicione o inline anti-flash snippet no <head> de cada página ANTES deste arquivo.
 */
(function () {
    const STORAGE_KEY = 'lyncro-theme';
    const DEFAULT_THEME = 'dark';

    function getStored() {
        try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
    }

    function store(theme) {
        try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
    }

    function apply(theme) {
        const resolved = (theme === 'light' || theme === 'dark') ? theme : DEFAULT_THEME;
        document.documentElement.setAttribute('data-theme', resolved);
        store(resolved);
        updateIcons(resolved);
    }

    function get() {
        return document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
    }

    function toggle() {
        apply(get() === 'dark' ? 'light' : 'dark');
    }

    function updateIcons(theme) {
        document.querySelectorAll('[data-theme-icon]').forEach(el => {
            el.setAttribute('data-theme-icon', theme);
            // Phosphor icons: swap between ph-sun and ph-moon
            const icon = el.querySelector('i');
            if (icon) {
                if (theme === 'dark') {
                    icon.className = icon.className.replace('ph-sun', 'ph-moon');
                    if (!icon.className.includes('ph-moon')) {
                        icon.className = icon.className.replace(/ph-\S+/, 'ph-moon');
                    }
                } else {
                    icon.className = icon.className.replace('ph-moon', 'ph-sun');
                    if (!icon.className.includes('ph-sun')) {
                        icon.className = icon.className.replace(/ph-\S+/, 'ph-sun');
                    }
                }
            }
        });
    }

    // Apply on DOMContentLoaded to update icons after DOM is ready
    document.addEventListener('DOMContentLoaded', function () {
        const current = get();
        updateIcons(current);

        // Wire up all toggle buttons
        document.querySelectorAll('[data-action="toggle-theme"]').forEach(btn => {
            btn.addEventListener('click', toggle);
        });
    });

    window.LYNCRO_THEME = { apply, get, toggle };
})();
