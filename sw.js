/* 格莉奇OS service worker：shell / asset 兩層快取。
   stage 1（install）：只安裝可開機的 app shell，小而快。
   stage 2（activate / message）：背景暖載入角色圖片到長效 asset cache。
   HTML 採 network-first、動態 JSON 採 stale-while-revalidate、資產採 cache-first。
   聊天歷史與使用者資料在 IndexedDB；跨域 AI / Giscus 請求不快取。 */

/* cache:start — scripts/update_sw_hashes.py 產生，勿手改 */
const SHELL_CACHE = 'glos-shell-4cb57d2b20c0';
const ASSET_CACHE = 'glos-assets-e4547950a416';
/* cache:end */
const KEEP = [SHELL_CACHE, ASSET_CACHE];
const MATCH = { ignoreSearch: true, ignoreVary: true };

const SHELL_FILES = [
/* shell:start */
  './', './index.html', './manifest.webmanifest', './posts.json', './wallpapers.json',
  './persona.json', './js/tags.js', './js/glitch-call.js',
  './images/icon-192.png', './images/icon-512.png', './images/glitch-logo.svg'
/* shell:end */
];
const PRIORITY_ASSETS = [
/* priority:start */
  './images/avatar.webp'
/* priority:end */
];
const WARM_ASSETS = [
/* warm:start */
  './images/wallpaper.webp', './images/wallpaper-day.webp', './images/wallpaper-night.webp',
  './images/pet-plain.webp', './images/pet.webp', './images/pet-blackhole.webp',
  './images/pet-happy.webp', './images/pet-thinking.webp',
  './images/pet-error.webp', './images/pet-sleep.webp',
  './images/sticker-01.png', './images/sticker-02.png', './images/sticker-03.png',
  './images/sticker-04.png', './images/sticker-05.png', './images/sticker-06.png',
  './images/sticker-07.png', './images/sticker-08.png', './images/sticker-09.png',
  './images/hole-01.png', './images/hole-02.png', './images/hole-03.png',
  './images/hole-04.png', './images/hole-05.png', './images/hole-06.png',
  './images/hole-07.png', './images/hole-08.png', './images/hole-09.png',
  './audio/intro-glitch.mp3', './audio/intro-blackhole.mp3'
/* warm:end */
];

const isAsset = (url) => /\/(?:images|audio)\//.test(url.pathname);
const isLiveData = (url) => /\/(?:posts|wallpapers)\.json$/.test(url.pathname);
const cacheable = (response) => !!response && response.ok && response.status !== 206;
const LOAD_TOTAL = PRIORITY_ASSETS.length + SHELL_FILES.length + WARM_ASSETS.length;

async function store(cacheName, request, response) {
  try {
    await (await caches.open(cacheName)).put(request, response);
    return true;
  } catch (_) {
    return false;
  }
}

async function reportProgress(stage, done, current, failed = 0) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type: 'cache-progress', stage, done, total: LOAD_TOTAL, current, failed }));
}

async function cacheOne(cacheName, path) {
  const cache = await caches.open(cacheName);
  if (await cache.match(path, MATCH)) return true;
  try {
    const response = await fetch(new Request(path, { cache: 'reload' }));
    return cacheable(response) ? store(cacheName, path, response) : false;
  } catch (_) {
    return false;
  }
}

let warming = null;
function warmAssets() {
  if (warming) return warming;
  warming = (async () => {
    let done = PRIORITY_ASSETS.length + SHELL_FILES.length, failed = 0;
    await reportProgress('assets', done, '準備離線資產');
    for (const path of WARM_ASSETS) {
      if (!await cacheOne(ASSET_CACHE, path)) failed += 1;
      done += 1;
      await reportProgress('assets', done, path, failed);
    }
  })().finally(() => { warming = null; });
  return warming;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    let done = 0, failed = 0;
    // 開機畫面第一個需要的是大頭照：明確先完成它，再處理其他 shell。
    for (const path of PRIORITY_ASSETS) {
      if (!await cacheOne(ASSET_CACHE, path)) failed += 1;
      done += 1;
      await reportProgress('priority', done, path, failed);
    }
    for (const path of SHELL_FILES) {
      if (!await cacheOne(SHELL_CACHE, path)) failed += 1;
      done += 1;
      await reportProgress('shell', done, path, failed);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // GitHub Pages 專案共用 origin；只能清自己的 glos-*，不可刪其他 repo 的 cache。
    await Promise.all(keys.filter((key) => key.startsWith('glos-') && !KEEP.includes(key)).map((key) => caches.delete(key)));
    await self.clients.claim();
    warmAssets().catch(() => {});
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'warm-assets') event.waitUntil(warmAssets());
});

async function rangedResponse(request, response) {
  const range = request.headers.get('range');
  if (!range) return response;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match) return response;
  const buffer = await response.arrayBuffer();
  const length = buffer.byteLength;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null && end !== null) {
    start = Math.max(0, length - end);
    end = length - 1;
  } else {
    start ??= 0;
    end = end === null ? length - 1 : Math.min(end, length - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= length) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${length}` } });
  }
  const headers = new Headers(response.headers);
  headers.set('accept-ranges', 'bytes');
  headers.set('content-range', `bytes ${start}-${end}/${length}`);
  headers.set('content-length', String(end - start + 1));
  return new Response(buffer.slice(start, end + 1), { status: 206, headers });
}

async function backfillAsset(url) {
  const cache = await caches.open(ASSET_CACHE);
  if (await cache.match(url, MATCH)) return;
  try {
    const full = await fetch(url, { cache: 'no-cache' });
    if (cacheable(full)) await store(ASSET_CACHE, url, full);
  } catch (_) {}
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const html = request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
  if (html) {
    event.respondWith((async () => {
      const shell = await caches.open(SHELL_CACHE);
      try {
        const response = await fetch(request);
        if (cacheable(response) && !url.search) await store(SHELL_CACHE, request, response.clone());
        return response;
      } catch (_) {
        return await shell.match(request, MATCH) || await shell.match('./index.html', MATCH) || Response.error();
      }
    })());
    return;
  }

  if (isLiveData(url)) {
    event.respondWith((async () => {
      const shell = await caches.open(SHELL_CACHE);
      const cached = await shell.match(request, MATCH);
      const refresh = (async () => {
        try {
          const response = await fetch(request);
          if (cacheable(response)) await store(SHELL_CACHE, request, response.clone());
          return response;
        } catch (_) {
          return null;
        }
      })();
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      return await refresh || Response.error();
    })());
    return;
  }

  const asset = isAsset(url);
  const cacheName = asset ? ASSET_CACHE : SHELL_CACHE;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request, MATCH);
    if (cached) return asset ? rangedResponse(request, cached) : cached;
    try {
      const response = await fetch(request);
      if (cacheable(response) && !url.search) await store(cacheName, request, response.clone());
      else if (asset && response.status === 206) event.waitUntil(backfillAsset(url.href));
      return response;
    } catch (_) {
      const fallback = await cache.match(request, MATCH);
      return fallback ? (asset ? rangedResponse(request, fallback) : fallback) : Response.error();
    }
  })());
});
