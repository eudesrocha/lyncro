module.exports = {
    darkMode: 'class',
    content: ["./public/**/*.{html,js}"],
    theme: {
        extend: {
            colors: {
                'win-bg': '#1c1c1c',
                'win-card': '#2b2b2b',
                'win-surface': '#323232',
                'win-accent': '#0078d4',
                'win-border': '#2a2a2a',
            },
            borderRadius: {
                'win': '4px',
            },
            fontFamily: {
                'segoe-black': ['Inter', '"Segoe UI Black"', '"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif'],
                'segoe': ['Inter', '"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif'],
                'logo': ['"Outfit"', 'sans-serif'],
            }
        }
    },
    plugins: [],
}
