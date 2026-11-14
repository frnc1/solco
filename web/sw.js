/* SOLCO — funzionamento offline (versione web). */
const CACHE = 'solco-v1.0.0';
const FILES = ['./', 'index.html', 'css/app.css', 'js/worklet.js', 'js/analysis.js', 'js/media.js', 'js/library.js', 'js/engine.js', 'js/midi.js', 'js/app.js',
  'fonts/inter-Regular.woff', 'fonts/inter-Medium.woff', 'fonts/inter-SemiBold.woff', 'fonts/inter-Bold.woff',
  'icons/icon-192.png', 'icons/icon-512.png', 'manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
