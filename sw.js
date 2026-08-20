/* TerrainSketch Service Worker — v0.26
 *
 * 目的: 圏外の現場でもアプリが起動すること。これが唯一かつ最重要の役割。
 *
 * 設計方針
 *   - cache-first。踏査中にネットワークの機嫌でアプリが立ち上がらない事態を避ける。
 *     本体は 2.5MB の単一 HTML なので、版内で中身が変わることはない。
 *   - キャッシュ名に版番号を含める（terrainsketch-v0.26）。版を上げると install で
 *     新キャッシュを作り、activate で旧キャッシュを消す。
 *   - skipWaiting は呼ばない。踏査の途中でアプリが入れ替わるのが一番危険なので、
 *     新版は待機させ、全ウィンドウを閉じた次回起動で有効にする。
 *   - 本体（index.html）のキャッシュ失敗は install を失敗させる。
 *     「登録は成功したがオフラインでは起動しない」という無言の失敗を作らないため。
 *
 * ES5 で書く（本体と同じ理由: 古い iPad Safari 互換）。Promise は SW の前提なので可。
 */
'use strict';

var VER   = '0.80';                        // ← 本体 APPVER と一致させること（build.py が検証）
var CACHE = 'terrainsketch-v' + VER;

var CORE_REQUIRED = './index.html';        // これが取れなければ install を失敗させる
var CORE_OPTIONAL = [                      // 取れなくても致命的でないもの
  './',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// --------------------------------------------------------------- install
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // cache:'reload' で HTTP キャッシュを迂回する。GitHub Pages の CDN が
      // 旧版を返している間に新版のキャッシュを作ってしまうのを防ぐ。
      return c.add(new Request(CORE_REQUIRED, { cache: 'reload' })).then(function () {
        return Promise.all(CORE_OPTIONAL.map(function (u) {
          return c.add(new Request(u, { cache: 'reload' }))['catch'](function () {
            return null;   // 任意ファイルの欠落は許容
          });
        }));
      });
    })
  );
});

// --------------------------------------------------------------- activate
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // 自分以外の terrainsketch-* を掃除する。無関係な origin のキャッシュは触らない。
        if (k !== CACHE && k.indexOf('terrainsketch-') === 0) return caches['delete'](k);
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// --------------------------------------------------------------- fetch
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   // 他オリジンは素通し

  // Cloudflare Access（や同種の入口認証）の通信は絶対に横取りしない。v0.53
  //
  // なぜ必要か: Access のログインは別ホスト（<team>.cloudflareaccess.com）で行われ、
  // 認証後に **同一オリジンの /cdn-cgi/access/callback へナビゲーションで戻ってくる**。
  // 下のナビゲーション処理はキャッシュした本体を無条件に返すので、この戻りを
  // 横取りしてしまい、**認証クッキーが発行されないままアプリが開く**。
  // その場では動いているように見えるのに、更新も再認証も永久にできなくなる。
  // 初回訪問時は SW が未登録なので気づけず、期限切れの再認証で初めて壊れる種類の事故。
  if (url.pathname.indexOf('/cdn-cgi/') === 0) return;

  // 起動（ナビゲーション）は必ず本体を返す。?query 付きで開かれても本体に落とす。
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.open(CACHE).then(function (c) {
        return c.match(CORE_REQUIRED).then(function (hit) {
          if (hit) return hit;
          return fetch(req)['catch'](function () {
            return new Response(
              '<meta charset="utf-8"><body style="font:16px/1.6 sans-serif;padding:24px;' +
              'background:#0e1216;color:#e6edf3">' +
              '<h2>オフラインです</h2><p>アプリ本体がまだ端末に保存されていません。' +
              '電波の届く場所で一度開いてから、共有メニューの「ホーム画面に追加」を' +
              '実行してください。</p></body>',
              { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
          });
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); })['catch'](function () {});
        }
        return res;
      });
    })
  );
});

// --------------------------------------------------------------- message
// 将来「今すぐ更新」ボタンを付ける場合の口。既定では誰も呼ばない。
self.addEventListener('message', function (e) {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'VERSION' && e.source) e.source.postMessage({ version: VER, cache: CACHE });
});
