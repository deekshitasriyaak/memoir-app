const VERSION = 'memoir-v5';

// Only cache static assets — NEVER cache index.html so updates are instant
const SHELL_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

const DATA_CACHE = 'memoir-data-v1';
const DATA_TTL_MS = 5 * 60 * 1000;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

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

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Core app files — always network-first so updates are instant
  if (url.pathname === '/' || url.pathname === '/index.html' ||
      url.pathname === '/app.js' || url.pathname === '/styles.css') {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // Always fetch media fresh
  if (isMediaFile(url.pathname)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Data files — short TTL cache
  if (isDataFile(url.pathname)) {
    event.respondWith(networkFirstWithTTL(event.request));
    return;
  }

  // GitHub API calls — always network
  if (url.hostname === 'api.github.com') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Other shell assets — cache first
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});

function isMediaFile(pathname) {
  return /\.(jpg|jpeg|png|gif|webp|mp4|mov|mp3|m4a|wav)$/i.test(pathname);
}

function isDataFile(pathname) {
  return pathname.includes('posts-index.json') || pathname.includes('music-index.json');
}

async function networkFirstWithTTL(request) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    const fetched = cached.headers.get('sw-fetched-at');
    if (fetched && Date.now() - parseInt(fetched) < DATA_TTL_MS) {
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
