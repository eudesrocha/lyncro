const CACHE_NAME = 'sv-guest-v2';
const urlsToCache = [
    '/guest.html',
    '/css/shared.css',
    '/js/webrtc.js',
    '/js/guest.js',
    'https://cdn.tailwindcss.com',
    'https://unpkg.com/@phosphor-icons/web'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
    );
});
