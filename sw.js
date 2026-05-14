const VERSION = 'memoir-v1';

// Only cache the app shell — never photos, videos, or audio
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Data cache — short lived
const DATA_CACHE = 'memoir-data-v1';
const DATA_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── INSTALL: cache shell ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean old caches ────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== VERSION && k !== DATA_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH: serve shell from cache, data with TTL, media always fresh ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always fetch media fresh — never cache photos/video/audio
  // This is what keeps phone storage near zero
  if (isMediaFile(url.pathname)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // posts-index.json and music-index.json — short TTL cache
  if (isDataFile(url.pathname)) {
    event.respondWith(networkFirstWithTTL(event.request));
    return;
  }

  // GitHub API calls — always network
  if (url.hostname === 'api.github.com') {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell — cache first
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});

function isMediaFile(pathname) {
  return /\.(jpg|jpeg|png|gif|webp|mp4|mov|mp3|m4a|wav)$/i.test(pathname);
}

function isDataFile(pathname) {
  return pathname.includes('posts-index.json') ||
         pathname.includes('music-index.json');
}

async function networkFirstWithTTL(request) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    const fetched = cached.headers.get('sw-fetched-at');
    if (fetched && Date.now() - parseInt(fetched) < DATA_TTL_MS) {
      // Still fresh — return cached, revalidate in background
      fetch(request).then(fresh => {
        if (fresh.ok) putWithTimestamp(cache, request, fresh);
      }).catch(() => {});
      return cached;
    }
  }

  try {
    const fresh = await fetch(request);
    if (fresh.ok) await putWithTimestamp(cache, request, fresh.clone());
    return fresh;
  } catch {
    return cached || new Response('{"error":"offline"}', {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function putWithTimestamp(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set('sw-fetched-at', Date.now().toString());
  const body = await response.arrayBuffer();
  const stamped = new Response(body, { status: response.status, headers });
  await cache.put(request, stamped);
}
