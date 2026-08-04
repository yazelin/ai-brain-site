/* 格莉奇OS service worker：兩階段載入。
   stage 1（install）：快取 app shell（index.html + manifest + 圖示），讓離線能開機。
   stage 2（fetch）：資產（桌布/貼圖/貼文圖）走 stale-while-revalidate 快取；API 不快取。
   聊天歷史與桌布選擇存在 IndexedDB（前端管理），不在這裡處理。 */

const SHELL = ['./', './index.html', './manifest.webmanifest', './posts.json',
  'images/icon-192.png', 'images/icon-512.png', 'images/glitch-logo.svg'];
const ASSET_RE = /^images\/|posts\.json$/;
const V = 'glos-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（giscus/worker）不快取
  const isShell = SHELL.includes(url.pathname.replace(/^\//, '')) || url.pathname === '/' || url.pathname.endsWith('/index.html');
  if (isShell) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
    return;
  }
  if (ASSET_RE.test(url.pathname)) {
    // stale-while-revalidate
    e.respondWith(caches.open(V).then((c) => c.match(req).then((cached) => {
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || net;
    })));
  }
});