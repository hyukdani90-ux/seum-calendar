// 오프라인에서도 열리도록 하는 서비스 워커.
// 화면 파일은 항상 인터넷에서 새로 받고(새 버전이 바로 보이게), 안 될 때만 저장본을 쓴다.
// 버전을 올리면 예전 저장본은 모두 지워진다.
const CACHE = 'seum-v3';
// 경로는 sw.js 위치 기준 (GitHub Pages처럼 하위 폴더에 올려도 동작)
const CORE = [
  './', 'index.html', 'race.html', 'config.js', 'holidays.js',
  'assets/runner.svg', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
];
// 다른 주소지만 화면에 꼭 필요한 것 (글꼴·스타일)
const SHARED_HOSTS = ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 체크 기록(구글 시트)은 저장하지 않고 항상 인터넷으로
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          // 응답 본문은 한 번만 읽을 수 있으므로 화면에 넘기기 전에 복사해 둔다
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true })
          .then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
    );
  } else if (SHARED_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
