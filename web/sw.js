// Vesper (Holler) service worker: push notifications, notification taps, and the static shell served
// straight from cache (then refreshed in the background) so the app opens instantly. The server
// stamps __BUILD__ with the release id, so every deploy installs a fresh shell. API calls, original
// files and the event stream are never cached. Picture previews (/files/<id>/p, 11-06) are kept in their own
// cache across releases, and a push with pictures fetches their previews before he taps it. A document's pages
// and thumbnail (/files/<id>/pg/<n>, /t, 11-10) are kept the same way, so a meeting prep he has opened, or one a
// notification brought, reads without the Mac.
const CACHE = 'holler-shell-__BUILD__';
const MEDIA = 'vesper-previews-v1';
const MEDIA_MAX = 700;
const PREVIEW = /^\/files\/[a-f0-9]{32}\/(p|t|pg\/\d{1,3})$/;

// Cache-first: a preview never changes (each picture has its own id). Oldest ones go past MEDIA_MAX.
async function preview(url) {
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(url);
  if (hit) return hit;
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.ok) {
    await cache.put(url, res.clone());
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - MEDIA_MAX))) await cache.delete(k);
  }
  return res;
}
const SHELL = [
  '/', '/index.html', '/app.css', '/app.js',
  '/js/util.js', '/js/md.js', '/js/api.js', '/js/store.js', '/js/avatar.js', '/js/list.js',
  '/js/thread.js', '/js/composer.js', '/js/gestures.js', '/js/push.js', '/js/details.js', '/js/marks.js', '/js/runs.js', '/js/routine.js', '/js/links.js', '/js/viewport.js', '/js/later.js', '/js/sheet.js', '/js/activity.js', '/js/system.js', '/js/docs.js', '/js/work.js',
  '/icons/apps/instagram.svg', '/icons/apps/facebook.svg', '/icons/apps/meta.svg', '/icons/apps/gmail.svg',
  '/icons/apps/google.svg', '/icons/apps/google-calendar.svg', '/icons/apps/stripe.svg',
  '/icons/apps/google-ads.svg', '/icons/apps/google-maps.svg', '/icons/apps/square.svg', '/icons/apps/zillow.svg',
  '/icons/apps/canva.svg', '/icons/apps/claude.svg', '/icons/apps/openai.svg',
  ...['headset', 'antenna', 'flower', 'glasses', 'cap'].flatMap((b) => ['', '-busy', '-perk', '-sleep'].map((m) => `/icons/agents/${b}${m}.webp`)),
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-180.png', '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key !== MEDIA) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (PREVIEW.test(url.pathname)) { event.respondWith(preview(url.pathname).catch(() => fetch(req))); return; }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/') || url.pathname.startsWith('/bot/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? '/index.html' : req;
    const hit = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => {});
      return res;
    });
    if (hit) { event.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  })());
});

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { body: event.data ? event.data.text() : '' }; }
  const chatId = p.chat_id || null;
  // The message it was about rides along, so the app opens on that message (?m= when the app has to start fresh).
  const msgId = Number.isFinite(Number(p.message_id)) && p.message_id != null ? Number(p.message_id) : null;
  const base = p.url || (chatId ? `/#/chat/${encodeURIComponent(chatId)}` : '/');
  const url = msgId != null && /^\/#\/chat\/[^?]+$/.test(base) ? `${base}?m=${msgId}` : base;
  // A card carries its own tag ("card-<id>"), so it never quietly replaces the chat's last notification.
  const shown = self.registration.showNotification(p.title || 'Vesper', {
    body: p.body || '',
    tag: p.tag || chatId || 'holler',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    timestamp: Date.now(),
    data: { url, chat_id: p.route ? null : chatId, route: p.route || null, message_id: msgId },
  });
  const badge = Number.isFinite(p.badge) && self.navigator?.setAppBadge ? self.navigator.setAppBadge(p.badge).catch(() => {}) : null;
  // The message's pictures: fetched now, so they are already on the phone when he opens it.
  const pics = Array.isArray(p.images) ? p.images.filter((u) => PREVIEW.test(String(u))).slice(0, 16) : [];
  const warm = pics.length ? Promise.all(pics.map((u) => preview(u).catch(() => null))) : null;
  event.waitUntil(Promise.all([shown, badge, warm]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = '/', chat_id: chatId = null, route = null, message_id: messageId = null } = event.notification.data || {};
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (client) {
      await client.focus();
      if (chatId) client.postMessage({ type: 'open-chat', chat_id: chatId, message_id: messageId });
      else if (route) client.postMessage({ type: 'open-route', route });
      else if ('navigate' in client) await client.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
