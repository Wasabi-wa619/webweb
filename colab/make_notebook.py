"""tiny_gpt.py を埋め込んだ Colab ノートブック (tiny_gpt.ipynb) を作り直す。

    python colab/make_notebook.py
"""
import json
import pathlib

here = pathlib.Path(__file__).parent
src = (here / "tiny_gpt.py").read_text(encoding="utf-8")
sample = (here.parent / "sample.txt").read_text(encoding="utf-8")


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

nb = {
    "cells": cells,
    "metadata": {
        "accelerator": "GPU",
        "colab": {"provenance": [], "gpuType": "T4"},
        "kernelspec": {"display_name": "Python 3", "name": "python3"},
        "language_info": {"name": "python"},
    },
    "nbformat": 4,
    "nbformat_minor": 0,
}
(here / "tiny_gpt.ipynb").write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print("colab/tiny_gpt.ipynb を書き出しました")
