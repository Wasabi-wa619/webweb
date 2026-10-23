# webweb

JavaScript に対応した Web プロキシです。Node.js だけで動き、依存パッケージはありません。

```sh
npm start                        # http://localhost:8080
PORT=3000 npm start              # ポート変更
SESSION_STORE=/path/to/db.json npm start  # クッキーの保存先
npm test                         # テスト
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
- 有効期限のあるクッキーはディスクに保存し、再起動後もセッションを維持します (`SESSION_STORE` で保存先を指定)
- Shift_JIS や EUC-JP のページは UTF-8 に変換します
- WebSocket は `/__px/ws` で中継します
- `/api/...` のようにルートから始まるパスへのリクエストは、Referer を見て元のサイトへ振り分けます

**クライアント側** (`public/client.js`。プロキシしたページの `<head>` の先頭に挿入されます)
- `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `Worker` / `sendBeacon` を経由させます
- `history.pushState` と `replaceState`、`location.assign` / `location.replace`、`window.open` を経由させます
- `location.href = ...` による移動は Navigation API で横取りします (Chromium 系のブラウザのみ)
- `img.src` や `a.href` などのプロパティ、`setAttribute`、`innerHTML`、`insertAdjacentHTML` を書き換えます
- `document.cookie` をサーバー側のクッキーと同期します
- `localStorage` / `sessionStorage` は対象サイトのオリジンごとに名前空間を分け、サイト間で混ざらないようにします
- `postMessage` と `MessageEvent.origin` のオリジンを補正します

## 制限

ブラウザだけで動くプロキシの構造上、どうしても残る制限です。

- ページ内の JavaScript が `location.pathname` や `location.hostname` を**読み取る**と、プロキシ側の値 (`/p/https://...`) が返ります。ページ移動 (`location.href =`、`assign`、`replace`、`pushState` など) は書き換えますが、JavaScript のコード自体は書き換えないため、現在パスを読んで動く一部の SPA ルーターは正しく動かないことがあります
- Service Worker は無効にしています (単一オリジンのプロキシでは、サイトごとにスコープを分けて安全に動かせないため)
- 仕組み上どうしても動かないもの: Google ログインなどの OAuth、CAPTCHA、DRM 付きの動画 (プロキシ経由であることが検知されたり、別オリジンのポップアップが必要なため)

## セキュリティ

`localhost` やプライベート IP へのアクセスは、初期状態ではブロックしています (SSRF 対策)。
許可するには `ALLOW_PRIVATE=1` を指定します。
認証の機能はないので、インターネットに公開するときはリバースプロキシなどでアクセスを制限してください。
