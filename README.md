# webweb

> 無料の AI で動く自分専用アシスタント (会話・検索・コーディング・Chrome 操作) は [`assistant/`](assistant/README.md) にあります。

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
- `location` / `window.location` / `document.location` の**読み取り**も、対象サイトの値を返します (下記参照)

### location の読み取り (SPA 対策)

多くの SPA ルーターは `location.pathname` などを読んで画面を切り替えます。そのままだとプロキシ側のパス (`/p/https://...`) が見えてしまうため、サーバー側で対象の `<script>` を `with(window.__pxScope){ ... }` で包み、コード中の裸の `location` ・ `window.location` ・ `document.location` ・ `document.URL` ・ `document.domain` が**本来のサイトの値**を返すようにしています。

- 対象はクラシックなスクリプト (インライン・外部の両方) です。`location` / `top` / `parent` を参照し、`import` / `export` を含まないものだけを包みます。関数宣言や `var` はこれまでどおりグローバルに残ります。
- `SCRIPT_SCOPE=0` で無効化できます。

## 制限

ブラウザだけで動くプロキシの構造上、どうしても残る制限です。

- **ES モジュール (`type="module"`) 内の `location` 読み取り**は補正できません。モジュールは `with` で包めない (構文エラーになる) ため、モジュールだけで書かれた SPA ルーターは現在パスを誤認することがあります。ページ移動そのもの (`location.href =`、`assign` / `replace`、`pushState` など) はモジュールでも書き換わります
- Service Worker は無効にしています (単一オリジンのプロキシでは、サイトごとにスコープを分けて安全に動かせないため)
- OAuth ログイン (別オリジンのポップアップやリダイレクトを伴うもの)、CAPTCHA、DRM 付きの動画は、プロキシ経由であることが検知される / 別オリジンが必要なため、動かないことがあります。これらを回避 (検知のすり抜けや保護の解除) する機能は入れていません

## セキュリティ

`localhost` やプライベート IP へのアクセスは、初期状態ではブロックしています (SSRF 対策)。
許可するには `ALLOW_PRIVATE=1` を指定します。
認証の機能はないので、インターネットに公開するときはリバースプロキシなどでアクセスを制限してください。
