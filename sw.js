/* sw.js — offline app shell, background rate checks, notification clicks. */
importScripts('fx-core.js');

var SHELL = 'eur-inr-shell-v3';
var SHELL_FILES = [
  './', 'index.html', 'fx-core.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon.svg'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return Promise.all(SHELL_FILES.map(function (f) { return c.add(f).catch(function () {}); }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    var names = await caches.keys();
    // Only prune old shell caches. 'fx-data' holds rates + settings and must survive.
    await Promise.all(names
      .filter(function (n) { return n.indexOf('eur-inr-shell-') === 0 && n !== SHELL; })
      .map(function (n) { return caches.delete(n); }));
    await self.clients.claim();
  })());
});

function fetchWithTimeout(req, ms) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, ms);
  return fetch(req, { signal: ctl.signal }).finally(function () { clearTimeout(t); });
}

// Same-origin files: network first (so updates arrive), cache when offline or slow.
async function networkFirst(req) {
  var cache = await caches.open(SHELL);
  try {
    var res = await fetchWithTimeout(req, 5000);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    var hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      var shell = (await cache.match('index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    throw err;
  }
}

// Google Fonts: serve from cache, refresh in the background.
async function staleWhileRevalidate(req) {
  var cache = await caches.open(SHELL);
  var hit = await cache.match(req);
  var net = fetch(req).then(function (res) {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(function () { return hit; });
  return hit || net;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(staleWhileRevalidate(req));
  }
  // Rate API and Supabase requests go straight to the network.
});

self.addEventListener('periodicsync', function (e) {
  if (e.tag === 'fx-check') e.waitUntil(FX.backgroundCheck());
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil((async function () {
    var all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var i = 0; i < all.length; i++) {
      if ('focus' in all[i]) return all[i].focus();
    }
    return self.clients.openWindow(self.registration.scope);
  })());
});
