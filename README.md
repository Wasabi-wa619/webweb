# webweb

JavaScript に対応した Web プロキシです。Node.js だけで動き、依存パッケージはありません。

```sh
npm start             # http://localhost:8080
PORT=3000 npm start   # ポート変更
npm test              # テスト
```

ブラウザで `http://localhost:8080/` を開き、URL か検索ワードを入力します。
`http://localhost:8080/p/https://example.com/` のように、URL を直接指定することもできます。

## 仕組み

**サーバー側** (`server.js`, `lib/`)
- HTML: `href` / `src` / `srcset` / `action` / `style` / `<style>` / meta refresh などの URL を `/p/<URL>` に書き換えます
- CSS: `url()` と `@import` を書き換えます
- `Content-Security-Policy`、`X-Frame-Options`、`integrity` 属性など、プロキシ経由だと邪魔になるものを取り除きます
- リダイレクト (`Location`) を書き換えます
- クッキーはサーバー側でセッションごとに保存し、送り先のドメインやパスに合うものだけを送ります
- Shift_JIS や EUC-JP のページは UTF-8 に変換します
- WebSocket は `/__px/ws` で中継します
- `/api/...` のようにルートから始まるパスへのリクエストは、Referer を見て元のサイトへ振り分けます

**クライアント側** (`public/client.js`。プロキシしたページの `<head>` の先頭に挿入されます)
- `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `Worker` / `sendBeacon` を経由させます
- `history.pushState` と `replaceState`、`window.open` を経由させます
- `location.href = ...` による移動は Navigation API で横取りします (Chromium 系のブラウザのみ)
- `img.src` や `a.href` などのプロパティ、`setAttribute`、`innerHTML`、`insertAdjacentHTML` を書き換えます
- `document.cookie` をサーバー側のクッキーと同期します
- `postMessage` と `MessageEvent.origin` のオリジンを補正します

## 制限

- JavaScript のコードそのものは書き換えていません。そのため `location.hostname` や `location.pathname` を読むと、プロキシの URL が返ります。SPA のルーティングなど、これに頼っているサイトは正しく動かない場合があります
- すべてのサイトがプロキシと同じオリジンで動くため、`localStorage` はサイト間で共有されます
- Service Worker は無効にしています
- 動かないことが多いもの: Google ログインなどの OAuth、CAPTCHA、DRM 付きの動画
- クッキーのセッションはメモリ上にしかないため、再起動すると消えます

## セキュリティ

`localhost` やプライベート IP へのアクセスは、初期状態ではブロックしています (SSRF 対策)。
許可するには `ALLOW_PRIVATE=1` を指定します。
認証の機能はないので、インターネットに公開するときはリバースプロキシなどでアクセスを制限してください。
