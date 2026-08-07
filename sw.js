/* Service worker do Smart Coliseu — gerado por build.js */
const CACHE = 'smart-coliseu-v1786083244289';

/* casca do app: o que precisa estar em cache pra abrir sem internet */
const CASCA = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './vendor/react.js',
  './vendor/react-dom.js',
  './vendor/tailwind.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  /* Cacheia um por um de proposito. O addAll() e atomico: se UM arquivo
     falhar, ele descarta o cache inteiro em silencio e o app nunca abre
     offline. Assim um item problematico nao derruba os outros, e o erro
     aparece no console em vez de sumir. */
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(
      CASCA.map((url) => c.add(url).catch((err) => {
        console.warn('[sw] nao consegui cachear', url, err);
      }))
    ))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* NUNCA cachear a API: os dados do treino tem que vir sempre frescos,
     senao o app mostra treino velho depois de sincronizar. */
  if (url.pathname.startsWith('/storage') || url.pathname.startsWith('/auth')) return;
  if (url.origin !== self.location.origin) return;

  /* HTML: rede primeiro (pega atualizacao na hora), cache como reserva.
     Sem internet, tenta em cadeia: a propria URL pedida, depois index.html,
     depois a raiz. Isso importa porque a mesma pagina pode estar guardada
     sob chaves diferentes ("/" quando o usuario abre o site, "/index.html"
     quando veio do pre-cache) — procurar so uma delas deixaria o app sem
     abrir offline mesmo tendo o arquivo guardado. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { const c = r.clone(); caches.open(CACHE).then((k) => k.put(req, c)); return r; })
        .catch(() => caches.match(req)
          .then((r) => r || caches.match('./index.html'))
          .then((r) => r || caches.match('./'))
        )
    );
    return;
  }

  /* resto (js, css, icones): cache primeiro, que e o que deixa rapido */
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      const c = r.clone();
      caches.open(CACHE).then((k) => k.put(req, c));
      return r;
    }))
  );
});
