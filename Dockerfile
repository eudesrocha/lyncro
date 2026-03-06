# Usar a imagem oficial do Node.js
FROM node:20-slim

# Definir o diretório de trabalho
WORKDIR /app

# Copiar os arquivos de dependências
COPY package*.json ./

# Instalar dependências (incluindo devDependencies se necessário para build, mas aqui é JS puro)
# Usamos --omit=dev para economizar espaço se não precisarmos de nada do dev
RUN npm install --omit=dev

# Copiar o restante do código
COPY . .

# Expor a porta que o servidor vai rodar
EXPOSE 3000

# Variável de ambiente padrão
ENV PORT=3000
ENV NODE_ENV=production

# Comando para iniciar o servidor
CMD ["node", "server/index.js"]
