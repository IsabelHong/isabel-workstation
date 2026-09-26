/* Isabel Work Station Service Worker v82
 * 策略：网络优先 + 失败回退缓存；iw-sync.js 始终走网络（确保同步逻辑即时更新）。
 * 与 v81 策略一致，仅更新缓存名 / 资源版本号（强制打破旧版缓存）。
 * v82 变更：修复移动端弹窗「保存记录」按钮被主题切换条遮挡（切换条让位 + 底部避让 + 吸底行动区）。
 */
const CACHE = 'isabel-workstation-v82';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-180-purple.png',
  './icon-192-purple.png',
  './icon-512-purple.png',
  './iw-sync.js?v=82',
  './sw-v82.js'
];

const OFFLINE_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Isabel 工作台 · 离线</title></head>'
  + '<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;'
  + 'font-family:system-ui,-apple-system,\'PingFang SC\',sans-serif;background:#283040;color:#f0eee7">'
  + '<div style="text-align:center;padding:24px">'
  + '<div style="font-size:42px">📴</div>'
  + '<h1 style="font-size:18px;margin:12px 0 6px">当前处于离线状态</h1>'
  + '<p style="font-size:13px;color:#bcb6ab;margin:0 0 18px;line-height:1.6">'
  + '网络连上后重新加载即可继续使用，你的数据都存在本机，不会丢失。</p>'
  + '<button onclick="location.reload()" style="border:0;border-radius:999px;padding:10px 22px;'
  + 'background:#e3c68c;color:#283040;font-size:14px;font-weight:700">重新加载</button>'
  + '</div></body></html>';

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.all(ASSETS.map(u => cache.add(u).catch(() => {})))
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => { if (k !== CACHE) return caches.delete(k); })))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('iw-sync.js')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  event.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
      return res;
    }).catch(() =>
      caches.match(req)
        .then(r => r || caches.match('./index.html'))
        .then(r => r || offlineResponse())
    )
  );
});
