const CACHE_NAME = 'isabel-workstation-v64';
const INDEX = './index.html';

// 预缓存：index.html（单文件应用，JS/CSS 全部内联）+ 云同步模块 + PWA 资源。
// 新增 iw-sync.js 必须加入，否则手机端离线后云同步功能不可用。
const STATIC_ASSETS = [
  INDEX,
  './iw-sync.js?v=64',
  './manifest.json',
  './icon-192-purple.png',
  './icon-512-purple.png',
  './icon-180-purple.png',
  './favicon-purple.ico'
];

const OFFLINE_HTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>离线模式</title>'
  + '<style>body{font-family:-apple-system,"PingFang SC",sans-serif;display:flex;align-items:center;'
  + 'justify-content:center;height:100vh;margin:0;background:#faf5f7;color:#5a4a6a;text-align:center;padding:24px}'
  + 'h1{font-size:20px;margin:0 0 8px}p{font-size:14px;line-height:1.6;margin:0}</style></head>'
  + '<body><div><h1>📡 当前处于离线状态</h1>'
  + '<p>工作台还没有缓存过。<br>请联网后再打开一次，<br>之后断网也能正常使用。</p></div></body></html>';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(STATIC_ASSETS.map((url) =>
        cache.add(url).catch(() => null)
      ));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    })
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // 本机通道与数据接口一律走网络，绝不缓存
  if (url.pathname.indexOf('/api/') === 0) return;

  // iw-sync.js 等同步模块：网络优先，避免升级后被旧缓存卡住
  if (/iw-sync\.js$/.test(url.pathname)) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(INDEX, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(INDEX).then((cached) => {
          return cached || new Response(OFFLINE_HTML, {
            status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
