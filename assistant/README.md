# マイAI (assistant)

自分専用の AI アシスタントです。クラウド (GitHub Codespaces の無料枠) で動き、Chromebook のブラウザから使います。

- **キャラクター付きの会話**: 性格や話し方を自由に決められます。覚えておいてほしいことは、AI が長期記憶に書き足します
- **ネット検索**: 検索してページを読み、出典つきで答えます (検索に API キーは不要)
- **コーディング**: クラウド上の作業フォルダでファイルを書き、実行して確かめます
- **Chrome の操作**: クラウド上の Chrome でサイトを開き、クリックや入力をします。スクリーンショットはチャット画面に出ます
- **複数の AI を組み合わせる**: Claude → Gemini → Groq → OpenRouter → ローカル AI の順に試し、使えないときは自動で次に切り替えます

> 操作するのはクラウド上にある別の Chrome です。Chromebook そのものや、Chromebook で開いている Chrome は操作しません。

## はじめかた (無料・5 分)

GitHub Codespaces (GitHub が用意してくれるクラウドのパソコン) で動かします。無料のアカウントで、月に約 60 時間まで無料です。クレジットカードは要りません。無料分を使い切ると止まるだけで、勝手に課金されることはありません。

1. GitHub にログインした状態で、次のリンクを開きます
   **https://codespaces.new/Wasabi-wa619/webweb/tree/claude/busy-gates-q72fde?quickstart=1**
2. 「Create new codespace」を押します。おすすめのシークレット (API キー) を入れる欄が出るので、持っているキーを入れます。空のままでも構いません
   - `GEMINI_API_KEY`: Gemini の無料キー (https://aistudio.google.com/apikey)
   - `ANTHROPIC_API_KEY`: Claude のキー (有料。下を参照)
   - `APP_PASSWORD`: チャット画面のパスワード。空なら自動で作り、`assistant/data/password.txt` に保存します
3. 初回は準備に 3〜5 分かかります。終わるとチャット画面が新しいタブで開きます。開かないときは、下の「ポート」タブの `7860` (マイAI) の地球儀マークを押します
4. パスワードを入れてログインします。自動で作った場合は、Codespace のエディターで `assistant/data/password.txt` を開くと書いてあります

### 「HTTP ERROR 401」と出たとき

チャットのポートは最初「非公開 (Private)」で、GitHub が「本人か」を確かめています。ブラウザがその確認をできないと 401 になります。次の順に試してください。

1. Codespace の画面の下にある「ポート」タブで、`7860` の行の地球儀マーク (ブラウザーで開く) を押して開き直す
2. チャットを開くブラウザで、github.com にログインしているか確かめる (シークレットウィンドウや別のプロフィールでは 401 になります)
3. それでもだめなら、「ポート」タブで `7860` の行を右クリック →「ポートの表示範囲」→「Public」にする。URL を知っている人なら誰でもログイン画面までは開けるようになるので、パスワードは推測されにくいものにしてください (自動で作ったものなら大丈夫です)

2 回目からは、同じリンク (または https://github.com/codespaces) を開くと、前回の Codespace の続きから始まります。会話の履歴や長期記憶もそのまま残っています。

知っておくこと:

- 30 分操作がないと、Codespace は自動で止まります (無料の時間を節約するため)。https://github.com/settings/codespaces の「Default idle timeout」で最大 240 分まで延ばせます
- キーを後から足すときは、https://github.com/settings/codespaces の「Secrets」→「New secret」で登録し、「Repository access」で `Wasabi-wa619/webweb` を選びます。そのあと Codespace を停止して開き直します
- 使った時間は https://github.com/settings/billing で確認できます

## Claude を使う (しばらくの間)

`ANTHROPIC_API_KEY` を登録している間は、Claude (`claude-opus-5-5`) がいちばん先に答えます。

- キーは https://console.anthropic.com/settings/keys で作ります。**Claude の API は有料**です。使った分だけ課金されます (入力 100 万トークンあたり $4、出力 $20)。Console の「Billing」で上限額を決めておくと安心です
- やめるときは、https://github.com/settings/codespaces の「Secrets」から `ANTHROPIC_API_KEY` を消して、Codespace を開き直すだけです。自動で無料の AI に切り替わります。残高がなくなったときや回数制限のときも、次の AI に切り替わります
- 安くしたいときは、`config.json` で `claude-opus-5-5` を `claude-sonnet-5-5` (約半額) や `claude-haiku-5-5` (さらに安い) に変えられます
- Claude が回答を断ったときは、まずサーバー側で別の Claude モデルに回し (`fallbacks: "default"`)、それでもだめなら次の AI に回します

## キャラクターを変える

Codespace の画面 (エディター) の左のファイル一覧で `assistant/character.md` を開き、書き換えて保存します。チャット画面右上の「新しい会話」から反映されます。

環境変数 `CHARACTER` にキャラクター設定を入れた場合は、そちらが優先されます。

## 設定を変える (使う AI の順番など)

Codespace のエディターで `assistant/config.example.json` を右クリック →「コピー」→「貼り付け」し、できたファイルの名前を `config.json` に変えて書き換えます。反映するには、ターミナルで `pkill -f "node server.js"; cd /workspaces/webweb/assistant && npm start` を実行します (環境変数 `CONFIG_JSON` に中身を入れても構いません)。

- `providers`: AI の接続先です。OpenAI 互換の API ならなんでも足せます (`baseUrl` とキーの名前 `apiKeyEnv`)。`"type": "anthropic"` は Claude です
- `roles`: 「`接続先:モデル名`」を並べた AI の組み合わせです。前から順に試し、失敗 (回数制限・エラー・つながらない) したら次に回します
  - 画面右上で、どの組み合わせで答えるかを選べます (`main` = ふだんの会話、`coder` = コーディング向け)
  - 会話中の AI は `ask_ai` ツールで、ほかの組み合わせに相談できます
- `effort`: Claude がどれだけ深く考えるか (`low` / `medium` / `high`)。組み合わせごとに決めます
- `maxSteps`: 1 回の返事で AI がツールを使ってよい回数の上限

無料枠の回数や使えるモデルはよく変わります。動かなくなったら、ここでモデル名を書き換えてください。Gemini の無料枠で送った内容は Google のサービス改善に使われるので、秘密の情報は送らないでください。

## ローカル AI (Ollama)

どの AI も使えないときの最後の手段です。

Codespace (または Chromebook の Linux) のターミナルで次を実行すると、`qwen3:1.7b` (約 1.4GB) が使えるようになります。無料の CPU なので、返事はかなり遅くなります。

```sh
curl -fsSL https://ollama.com/install.sh | sh
ollama serve > /tmp/ollama.log 2>&1 &
ollama pull qwen3:1.7b
```

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
| `../.devcontainer/devcontainer.json` | Codespaces の設定。準備 (インストール) と、起動したらチャットを立ち上げるところまで |
| `hf-space/Dockerfile` | Hugging Face Spaces (有料の PRO プラン) で動かす場合に Space へ置く 1 ファイル |
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

- AI はクラウドのコンテナの中でどんなコマンドでも実行できます。Codespaces ではパスワードが必ずかかります。ほかの場所でインターネットに公開するときは、**`APP_PASSWORD` を必ず設定してください**
- 購入・送金・投稿・削除などの取り消せない操作の前には、ユーザーに確認するよう AI に指示していますが、無料のモデルは指示を守らないこともあります。大事なアカウントでのログインは AI にさせないでください
