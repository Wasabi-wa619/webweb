# マイAI (assistant)

自分専用の AI アシスタントです。クラウド (Hugging Face Spaces の無料枠) で動き、Chromebook のブラウザから使います。

- **キャラクター付きの会話**: 性格や話し方を自由に決められます。覚えておいてほしいことは、AI が長期記憶に書き足します
- **ネット検索**: 検索してページを読み、出典つきで答えます (検索に API キーは不要)
- **コーディング**: クラウド上の作業フォルダでファイルを書き、実行して確かめます
- **Chrome の操作**: クラウド上の Chrome でサイトを開き、クリックや入力をします。スクリーンショットはチャット画面に出ます
- **複数の AI を組み合わせる**: Claude → Gemini → Groq → OpenRouter → ローカル AI の順に試し、使えないときは自動で次に切り替えます

> 操作するのはクラウド上にある別の Chrome です。Chromebook そのものや、Chromebook で開いている Chrome は操作しません。

## はじめかた (10 分)

### 1. Space を作る

1. https://huggingface.co で無料アカウントを作ってログインします
2. https://huggingface.co/new-space を開き、次のように選んで「Create Space」を押します
   - **Space name**: 好きな名前 (例: `my-ai`)
   - **Select the Space SDK**: **Docker** →「Blank」
   - **Space hardware**: CPU basic (無料)
   - **Private** を選ぶ

### 2. ファイルを 1 つだけ作る

1. できた Space の「Files」タブ →「+ Add file」→「Create a new file」を押します
2. ファイル名に `Dockerfile` と入れます
3. 中身に、[`hf-space/Dockerfile`](hf-space/Dockerfile) の内容をまるごとコピーして貼り付けます (GitHub で開いて、右上のコピーボタンを押すと楽です)
4. 下の「Commit new file to main」を押します

これで、プログラム本体は GitHub から自動で取ってきます。

### 3. パスワードと AI のキーを登録する

Space の「Settings」→「Variables and secrets」→「New secret」で、次を登録します。

| Name | Value |
| --- | --- |
| `APP_PASSWORD` | チャット画面に入るためのパスワード (自分で決める) |
| `ANTHROPIC_API_KEY` | Claude のキー (使う間だけ。下を参照) |
| `GEMINI_API_KEY` | Gemini の無料キー (https://aistudio.google.com/apikey) |

AI のキーはどれか 1 つあれば動きます。Groq (`GROQ_API_KEY`, https://console.groq.com/keys) や OpenRouter (`OPENROUTER_API_KEY`, https://openrouter.ai/keys) の無料キーも足せます。

### 4. 開く

ビルドが終わると (初回は 5〜10 分)、`https://<ユーザー名>-my-ai.hf.space` で開けます。パスワードでログインすれば使えます。

忘れていた設定は画面が教えてくれます。パスワードがないときは登録のしかた、AI のキーがないときはキーの取り先が出ます。

## Claude を使う (しばらくの間)

`ANTHROPIC_API_KEY` を登録している間は、Claude (`claude-opus-5-5`) がいちばん先に答えます。

- キーは https://console.anthropic.com/settings/keys で作ります。**Claude の API は有料**です。使った分だけ課金されます (入力 100 万トークンあたり $4、出力 $20)。Console の「Billing」で上限額を決めておくと安心です
- やめるときは、Secrets から `ANTHROPIC_API_KEY` を消すだけです。自動で無料の AI に切り替わります。残高がなくなったときや回数制限のときも、次の AI に切り替わります
- 安くしたいときは、`config.json` で `claude-opus-5-5` を `claude-sonnet-5-5` (約半額) や `claude-haiku-5-5` (さらに安い) に変えられます
- Claude が回答を断ったときは、まずサーバー側で別の Claude モデルに回し (`fallbacks: "default"`)、それでもだめなら次の AI に回します

## キャラクターを変える

Space の「Settings」→「Variables and secrets」→「New variable」で、Name を `CHARACTER`、Value にキャラクター設定を書きます (例は [`character.md`](character.md))。保存すると再起動し、画面右上の「新しい会話」から反映されます。

## 設定を変える (使う AI の順番など)

[`config.example.json`](config.example.json) の中身をコピーして書き換え、Space の Secrets に `CONFIG_JSON` として登録します。

- `providers`: AI の接続先です。OpenAI 互換の API ならなんでも足せます (`baseUrl` とキーの名前 `apiKeyEnv`)。`"type": "anthropic"` は Claude です
- `roles`: 「`接続先:モデル名`」を並べた AI の組み合わせです。前から順に試し、失敗 (回数制限・エラー・つながらない) したら次に回します
  - 画面右上で、どの組み合わせで答えるかを選べます (`main` = ふだんの会話、`coder` = コーディング向け)
  - 会話中の AI は `ask_ai` ツールで、ほかの組み合わせに相談できます
- `effort`: Claude がどれだけ深く考えるか (`low` / `medium` / `high`)。組み合わせごとに決めます
- `maxSteps`: 1 回の返事で AI がツールを使ってよい回数の上限

無料枠の回数や使えるモデルはよく変わります。動かなくなったら、ここでモデル名を書き換えてください。Gemini の無料枠で送った内容は Google のサービス改善に使われるので、秘密の情報は送らないでください。

## 知っておくこと

- 48 時間使わないとスリープします。開けば数十秒〜数分で起きます
- 再起動すると、会話の履歴・長期記憶・作業フォルダは消えます。残したい好みは `CHARACTER` に書いておくと確実です
- 新しい版に更新するときは、Space の「Settings」→「Factory rebuild」を押します

## ローカル AI (Ollama)

どの AI も使えないときの最後の手段です。

- **Space の中で動かす**: Space の `Dockerfile` の `ARG WITH_OLLAMA=0` を `1` に書き換えます。起動時に `qwen3:1.7b` (約 1.4GB) を取ってきます。無料の CPU なので返事はかなり遅くなります
- **Chromebook で動かす**: 下の手順と一緒に `curl -fsSL https://ollama.com/install.sh | sh` → `ollama pull qwen3:1.7b` を実行します

## Chromebook の中で動かす (クラウドを使わない場合)

「設定」→「詳細設定」→「デベロッパー」→「Linux 開発環境」をオンにして、ターミナルで次を実行します。

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -   # Node.js 22 を入れる
sudo apt install -y nodejs git
git clone -b claude/busy-gates-q72fde https://github.com/Wasabi-wa619/webweb.git
cd webweb/assistant
npm install
npx playwright install --with-deps chromium
export GEMINI_API_KEY=...        # 持っているキーを設定
npm start                        # http://localhost:7860
```

`APP_PASSWORD` を設定しない場合は、そのマシンからだけ接続できます。

## 仕組み

```
ブラウザ ──(パスワード)──▶ server.js ──▶ lib/agent.js (会話とツールのくり返し)
                                       ├─▶ lib/llm.js    Claude → Gemini → Groq → OpenRouter → Ollama
                                       └─▶ lib/tools.js  検索・ページ取得 (lib/web.js)
                                                         Chrome 操作 (lib/browser.js)
                                                         作業フォルダのファイル・コマンド
```

| ファイル | 役割 |
| --- | --- |
| `hf-space/Dockerfile` | Space に置く 1 ファイル。GitHub から本体を取ってきて組み立てる |
| `character.md` | キャラクター設定の例 (`CHARACTER` がなければこれを使う) |
| `config.example.json` | 使う AI と組み合わせの設定 |
| `lib/llm.js` | AI を順に試すクライアント。回数制限にかかった AI は 1 分間休ませる |
| `lib/claude.js` | Claude との変換。Claude が考えた跡 (thinking) は変えずに送り返す |
| `lib/agent.js` | 会話の履歴と、AI がツールを使い終わるまでのくり返し。履歴は後ろに足すだけにして、Claude のキャッシュが効くようにしている |
| `lib/tools.js` | AI が使えるツール。ファイル操作は作業フォルダ (`workspace/`) の中だけ |
| `lib/browser.js` | Playwright で Chromium を操作。操作できる要素に番号を振って AI に渡す |
| `lib/web.js` | DuckDuckGo 検索とページ本文の取り出し (検索できないときは Chrome で Bing を開く) |
| `Dockerfile` | このフォルダから直接組み立てる場合の Dockerfile |

`npm test` でテストを実行できます。

## 安全のために

- AI はクラウドのコンテナの中でどんなコマンドでも実行できます。**`APP_PASSWORD` は必ず設定してください** (設定するまで画面は使えません)
- 購入・送金・投稿・削除などの取り消せない操作の前には、ユーザーに確認するよう AI に指示していますが、無料のモデルは指示を守らないこともあります。大事なアカウントでのログインは AI にさせないでください
