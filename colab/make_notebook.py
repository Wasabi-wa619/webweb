"""colab/ の .py を埋め込んだ Colab ノートブック (tiny_gpt.ipynb, chat_finetune.ipynb) を作り直す。

    python colab/make_notebook.py
"""
import json
import pathlib

here = pathlib.Path(__file__).parent
src = (here / "tiny_gpt.py").read_text(encoding="utf-8")
sample = (here.parent / "sample.txt").read_text(encoding="utf-8")
chat_src = (here / "chat_finetune.py").read_text(encoding="utf-8")
sample_qa = (here.parent / "sample_qa.txt").read_text(encoding="utf-8")


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(True)}


def code(text):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
            "source": text.strip("\n").splitlines(True)}


cells = [
    md("""
# ちいさな GPT を Colab の GPU で育てる

ブラウザ版「ちいさなGPT工房」と同じモデルを、Google Colab の無料 GPU で大きく学習します。

1. メニューの **ランタイム → ランタイムのタイプを変更** で **T4 GPU** を選ぶ
2. 上のセルから順に実行する (▶ ボタン、または Shift+Enter)
3. 最後のセルで `tiny_gpt.json` がダウンロードされる。ブラウザ版の「JSON を読み込む」で開ける
"""),
    code("""
import torch
print("GPU:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "なし (ランタイムのタイプを T4 GPU にしてください)")
"""),
    md("## 1. モデルのコード\n\nブラウザ版の `gpt.js` と同じ構造です。中身を読むと、GPT のしくみがひととおりわかります。"),
    code("%%writefile tiny_gpt.py\n" + src),
    md("""
## 2. 学習に使う文章

例の文章を書き出します。自分の文章を使うときは、次のセルで `.txt` (UTF-8) をアップロードしてください。
数十万字以上あると、文らしい文章を書くようになります。
"""),
    code("with open('input.txt', 'w', encoding='utf-8') as f:\n    f.write(" + json.dumps(sample, ensure_ascii=False) + ")\nprint('例の文章を input.txt に書き出しました')"),
    code("""
# 自分の文章を使うときだけ実行する
from google.colab import files
up = files.upload()
name = next(iter(up))
with open('input.txt', 'wb') as f:
    f.write(up[name])
print(name, 'を input.txt にしました')
"""),
    md("""
## 3. 学習

設定の目安 (T4 GPU):

| 大きさ | layers | heads | embd | block | だいたいの時間 |
|---|---|---|---|---|---|
| 小 | 4 | 4 | 128 | 128 | 数分 |
| 中 | 6 | 8 | 256 | 256 | 10〜20 分 |
| 大 | 8 | 8 | 384 | 256 | 30 分〜 |

文章が少ないのにモデルを大きくすると、丸暗記 (val だけが上がる) になります。そのときは steps を減らすか、文章を増やしてください。
ブラウザで動かすなら「中」くらいまでが快適です。
"""),
    code("""
from tiny_gpt import train
text = open('input.txt', encoding='utf-8').read()
model, tok = train(text, n_layer=6, n_head=8, n_embd=256, block_size=256,
                   batch_size=64, steps=3000, lr=1e-3, out='tiny_gpt.json')
"""),
    md("## 4. 文章を書かせる"),
    code("""
prompt = 'ある日、'
ids = tok.encode(prompt) or tok.encode(text[:1])
print(tok.decode(model.generate(ids, 300, temperature=0.8, top_k=20)))
"""),
    md("## 5. ダウンロード\n\nブラウザ版の「JSON を読み込む」で開けます。"),
    code("from google.colab import files\nfiles.download('tiny_gpt.json')"),
]


chat_cells = [
    md("""
# 自分のチャットボットを作る (LoRA で追加学習)

日本語をすでに話せる公開モデル (Qwen2.5-Instruct) に、自分の「質問と答え」を追加で覚えさせます。
一から作るちいさなGPTと違って、教えていない質問にもそれらしく答えられます。そこに自分の知識・口調・キャラクターを足すのが目的です。

1. メニューの **ランタイム → ランタイムのタイプを変更** で **T4 GPU** を選ぶ
2. 上のセルから順に実行する (▶ ボタン、または Shift+Enter)
3. 途中のセルで、ブラウザから話しかけられるチャット画面の URL が出ます
"""),
    code("""
!pip install -q "transformers>=4.56" peft accelerate
import torch
print("GPU:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "なし (ランタイムのタイプを T4 GPU にしてください)")
"""),
    md("## 1. 追加学習のコード"),
    code("%%writefile chat_finetune.py\n" + chat_src),
    md("""
## 2. 質問と答えのデータ

ちいさなGPT工房と同じ形です。「質問: …」「答え: …」を空行で区切って並べます。答えは何行でもかまいません。

```
質問: あなたはだれですか。
答え: わたしは山の郵便局で育った、小さな言語モデルです。

質問: 局長はだれですか。
答え: 局長は、ねこです。
```

まずは例のデータを書き出します。自分のデータを使うときは、その次のセルでアップロードしてください。
目安は 50〜数千組です。同じことを聞く言い方を何通りか入れておくと、覚えがよくなります。
"""),
    code("with open('my_qa.txt', 'w', encoding='utf-8') as f:\n    f.write(" + json.dumps(sample_qa, ensure_ascii=False) + ")\nprint('例のデータを my_qa.txt に書き出しました')"),
    code("""
# 自分のデータを使うときだけ実行する
from google.colab import files
up = files.upload()
name = next(iter(up))
with open('my_qa.txt', 'wb') as f:
    f.write(up[name])
print(name, 'を my_qa.txt にしました')
"""),
    md("""
## 3. 設定

- `MODEL`: もとにするモデル。T4 なら `Qwen/Qwen2.5-1.5B-Instruct` がおすすめ。速さ優先なら `Qwen/Qwen2.5-0.5B-Instruct`、日本語の上手さ優先なら `Qwen/Qwen2.5-3B-Instruct` (遅く、メモリもぎりぎり)
- `SYSTEM`: キャラクターや口調の指示。学習のときも会話のときも同じものを使います
- `EPOCHS`: データを何周読むか。組が少ない (〜100) なら 10 前後、数千あるなら 2〜3
"""),
    code("""
MODEL = 'Qwen/Qwen2.5-1.5B-Instruct'
SYSTEM = 'あなたは山の郵便局で育った「ちいさなGPT」です。やさしい口調で、短く答えます。'
EPOCHS = 10

import chat_finetune as cf
pairs = cf.parse_qa(open('my_qa.txt', encoding='utf-8').read())
print(len(pairs), '組を読みました。例:', pairs[0])
model, tok = cf.load(MODEL)
"""),
    md("## 4. 学習の前に聞いてみる\n\nもとのモデルは、あなたのデータの中身を知りません。学習の後と比べてみてください。"),
    code("""
for q in [pairs[0][0], '局長はだれですか。']:
    print('質問:', q)
    print('答え:', cf.chat(model, tok, q, system=SYSTEM), '\\n')
"""),
    md("## 5. 追加学習 (LoRA)\n\nもとの重みは動かさず、各層に足した小さな行列だけを学習します。1.5B のモデルでも、学習する重みは全体の 1% ほどです。"),
    code("""
model = cf.add_lora(model)
model = cf.train(model, tok, pairs, system=SYSTEM, epochs=EPOCHS, batch_size=8, lr=2e-4)
"""),
    md("## 6. 学習の後に聞いてみる\n\n教えた質問と、教えていない質問の両方を試してみましょう。"),
    code("""
for q in [pairs[0][0], '局長はだれですか。', '郵便局の一年を教えて。', '日本でいちばん高い山は?']:
    print('質問:', q)
    print('答え:', cf.chat(model, tok, q, system=SYSTEM), '\\n')
"""),
    md("""
## 7. チャット画面で話す

実行すると `https://….gradio.live` の URL が出ます。開くと ChatGPT のような画面で話しかけられます (72 時間有効。URL を知っている人は誰でも使えるので、人に見せたくないときは共有しないでください)。
止めるときはセルの ■ を押します。
"""),
    code("""
!pip install -q gradio
import gradio as gr

def to_pairs(history):
    # Gradio のバージョンによって履歴の形がちがうので、(質問, 答え) の組にそろえる
    pairs_, q = [], None
    for h in history:
        if isinstance(h, dict):
            text = h.get('content')
            text = text if isinstance(text, str) else str(text)
            if h.get('role') == 'user':
                q = text
            elif h.get('role') == 'assistant' and q is not None:
                pairs_.append((q, text)); q = None
        else:
            pairs_.append((h[0], h[1]))
    return pairs_[-5:]

def reply(message, history):
    return cf.chat(model, tok, message, history=to_pairs(history), system=SYSTEM)

gr.ChatInterface(reply, title='ちいさなGPT').launch(share=True, debug=True)
"""),
    md("""
## 8. 保存とダウンロード

`my_lora.zip` には、足した小さな行列 (数十 MB) だけが入っています。あとで使うときは、もとのモデルに重ねて読み込みます。

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
base = AutoModelForCausalLM.from_pretrained('Qwen/Qwen2.5-1.5B-Instruct', dtype='auto').to('cuda')
model = PeftModel.from_pretrained(base, 'my_lora')
tok = AutoTokenizer.from_pretrained('my_lora')
```
"""),
    code("""
model.save_pretrained('my_lora')
tok.save_pretrained('my_lora')
!zip -qr my_lora.zip my_lora
from google.colab import files
files.download('my_lora.zip')
"""),
]


def write(name, cells_):
    nb = {
        "cells": cells_,
        "metadata": {
            "accelerator": "GPU",
            "colab": {"provenance": [], "gpuType": "T4"},
            "kernelspec": {"display_name": "Python 3", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 0,
    }
    (here / name).write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"colab/{name} を書き出しました")


write("tiny_gpt.ipynb", cells)
write("chat_finetune.ipynb", chat_cells)
