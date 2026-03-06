module.exports = {
    content: ["./public/**/*.{html,js}"],
    theme: {
        extend: {
            colors: {
                'win-bg': '#1c1c1c',      // Fundo principal
                'win-card': '#2b2b2b',    // Cards de vídeo
                'win-surface': '#323232', // Botões e inputs
                'win-accent': '#0078d4',  // Azul padrão Windows
                'win-border': 'rgba(255, 255, 255, 0.08)',
            },
            borderRadius: {
                'win': '4px', // O segredo para não ficar "arredondado demais"
            }
        }
    },
    plugins: [],
}
