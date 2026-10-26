---
title: My AI
emoji: 🤖
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# マイAI (assistant)

無料の AI を組み合わせて動く、自分専用のアシスタントです。クラウド (Hugging Face Spaces の無料枠) で動かし、Chromebook のブラウザから使います。

- **キャラクター付きの会話**: 性格や話し方は `character.md` で決めます。覚えておいてほしいことは AI が長期記憶 (`data/memory.md`) に書き足します
- **ネット検索**: DuckDuckGo で検索し、ページを読んで答えます (API キーは不要です)
- **コーディング**: クラウド上の作業フォルダでファイルを書き、Python や Node.js で実行して確かめます
- **Chrome の操作**: クラウド上の Chrome (ヘッドレス Chromium) でサイトを開き、クリックや入力をします。スクリーンショットはチャット画面に表示されます
- **複数の AI を組み合わせる**: Gemini → Groq → OpenRouter → ローカル AI (Ollama) の順に試し、回数制限にかかったら自動で次に切り替えます。会話の途中で、コーディングが得意な AI に相談させることもできます

> あなたの Chromebook そのものや、Chromebook で開いている Chrome は操作しません。AI が操作するのは、クラウド上にある別の Chrome です。

## 1. 無料の API キーを用意する

どれか 1 つあれば動きます。複数あると、回数制限にかかったときに切り替えられます。

| サービス | キーの取得先 | 環境変数 |
| --- | --- | --- |
| Google Gemini | https://aistudio.google.com/apikey | `GEMINI_API_KEY` |
| Groq | https://console.groq.com/keys | `GROQ_API_KEY` |
| OpenRouter | https://openrouter.ai/keys | `OPENROUTER_API_KEY` |

- 無料枠の回数や使えるモデルはよく変わります。使えなくなったら `config.json` のモデル名を書き換えてください
- Gemini の無料枠で送った内容は、Google のサービス改善に使われます。秘密の情報は送らないでください

## 2. Hugging Face Spaces で動かす (無料)

1. https://huggingface.co で無料アカウントを作ります
2. 右上の「New」→「Space」で Space を作ります。**SDK は「Docker」→「Blank」**、ハードウェアは「CPU basic (無料)」、公開範囲は「Private」がおすすめです
3. Space の「Files」タブの「Contribute」→「Upload files」で、この `assistant` フォルダの中身 (`README.md`、`Dockerfile`、`server.js`、`lib/`、`public/` など) をそのままアップロードします。GitHub の「Code」→「Download ZIP」で取り出せます
4. 「Settings」→「Variables and secrets」で **Secrets** を追加します
   - `APP_PASSWORD`: チャット画面に入るためのパスワード (**必ず設定してください**。AI がコマンドを実行できるので、誰でも入れる状態にしないこと)
   - 手順 1 で取った API キー (`GEMINI_API_KEY` など)
5. ビルドが終わると「App」タブに画面が出ます。`https://<ユーザー名>-<Space名>.hf.space` を Chromebook のブラウザで直接開き、パスワードでログインします

無料枠の注意:

- 48 時間使わないとスリープします。開けば数十秒〜数分で起きます
- 再起動すると、会話の履歴・長期記憶・作業フォルダは消えます (保存し続けるには有料の永続ストレージが必要です)。消したくない内容は、`character.md` や `config.json` に書いてアップロードし直してください

## 3. 設定を変える

`config.example.json` をコピーして `config.json` を作ると、そちらが使われます (Space の Secrets に `CONFIG_JSON` として中身を入れても構いません)。

```json
{
  "providers": {
    "gemini": { "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai", "apiKeyEnv": "GEMINI_API_KEY" }
  },
  "roles": {
    "main":  ["gemini:gemini-2.5-flash", "groq:openai/gpt-oss-120b", "openrouter:openrouter/free", "ollama:qwen3:1.7b"],
    "coder": ["groq:openai/gpt-oss-120b", "gemini:gemini-2.5-flash"]
  }
}
```

- `providers`: OpenAI 互換の API ならなんでも追加できます (`baseUrl` と、キーを入れる環境変数の名前 `apiKeyEnv`)
- `roles`: 「`provider:モデル名`」を並べた、AI の組み合わせです。前から順に試し、失敗 (回数制限・エラー・つながらない) したら次に回します
  - 画面右上で、どの組み合わせで答えるかを選べます (`main` = ふだんの会話、`coder` = コーディング向け)
  - 会話中の AI は `ask_ai` ツールで、ほかの組み合わせ (`coder` や `fast`) に相談できます
- `maxSteps`: 1 回の返事で AI がツールを使ってよい回数の上限

## 4. ローカル AI (Ollama) を使う

どの API も使えないときの最後の手段として、Ollama で動く小さなモデルに切り替わるようにしてあります。

- **Space の中で動かす**: `Dockerfile` の `ARG WITH_OLLAMA=0` を `1` に書き換えてアップロードします。起動時に `qwen3:1.7b` (約 1.4GB) を取ってきます (別のモデルは Secrets/Variables の `OLLAMA_MODEL` で指定)。無料の CPU なので返事はかなり遅くなります
- **Chromebook の Linux で動かす**: 下の「Chromebook で動かす」と一緒に `curl -fsSL https://ollama.com/install.sh | sh` → `ollama pull qwen3:1.7b` を実行します

## 5. Chromebook で動かす (クラウドを使わない場合)

「設定」→「詳細設定」→「デベロッパー」→「Linux 開発環境」をオンにして、ターミナルで次を実行します。

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -   # Node.js 22 を入れる
sudo apt install -y nodejs
cd assistant
npm install
npx playwright install --with-deps chromium
export GEMINI_API_KEY=...        # 持っているキーを設定
npm start                        # http://localhost:7860
```

`APP_PASSWORD` を設定しない場合は、そのマシンからだけ接続できます (`127.0.0.1` で待ち受けます)。

## 仕組み

```
Chromebook のブラウザ ──(パスワード)──▶ server.js ──▶ lib/agent.js (会話とツールのくり返し)
                                                     ├─▶ lib/llm.js   Gemini → Groq → OpenRouter → Ollama
                                                     └─▶ lib/tools.js 検索・ページ取得 (lib/web.js)
                                                                      Chrome 操作 (lib/browser.js)
                                                                      作業フォルダのファイル・コマンド
```

| ファイル | 役割 |
| --- | --- |
| `character.md` | キャラクター設定 (書き換えると性格が変わる) |
| `config.example.json` | 使う AI と組み合わせの設定 |
| `lib/llm.js` | OpenAI 互換 API を順に試すクライアント。429 (回数制限) の AI は 1 分間使わない |
| `lib/agent.js` | 会話の履歴 (`data/conversation-main.json`) と、AI がツールを使い終わるまでのくり返し |
| `lib/tools.js` | AI が使えるツールの定義と実行。ファイル操作は作業フォルダ (`workspace/`) の中だけ |
| `lib/browser.js` | Playwright で Chromium を操作。操作できる要素に番号を振って AI に渡す |
| `lib/web.js` | DuckDuckGo 検索と、ページ本文の取り出し (検索できないときは Chrome で Bing を開く) |

`npm test` でテストを実行できます。

## 安全のために

- `run_command` は、クラウドのコンテナの中で何でも実行できます。コンテナそのものが砂場 (サンドボックス) です。**`APP_PASSWORD` は必ず設定してください**
- 購入・送金・投稿・削除などの取り消せない操作の前には、ユーザーに確認するよう AI に指示していますが、無料のモデルは指示を守らないこともあります。大事なアカウントでのログインは AI にさせないでください
