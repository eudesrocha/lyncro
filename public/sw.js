const CACHE_NAME = 'sv-guest-v6';
const urlsToCache = [
    '/guest.html',
    '/css/tailwind.css',
    '/js/webrtc.js',
    '/js/guest.js',
    '/js/virtual-background.js',
    '/img/bg-office.png',
    '/img/bg-studio.png',
    'https://unpkg.com/@phosphor-icons/web'
];

self.addEventListener('install', event => {
    self.skipWaiting(); // Forçar ativação imediata da nova versão
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
});

self.addEventListener('activate', event => {
    // Limpar caches antigos ao ativar nova versão
    event.waitUntil(
        caches.keys().then(cacheNames =>
            Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            )
        ).then(() => self.clients.claim()) // Assume controle imediatamente
    );
});

self.addEventListener('fetch', event => {
    // Estratégia Network-First: sempre buscar do servidor primeiro
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Atualizar o cache com a resposta fresca
                if (response.ok) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Só usa cache se rede falhar (offline fallback)
                return caches.match(event.request);
            })
    );
});
