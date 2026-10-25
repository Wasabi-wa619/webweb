"""ちいさな GPT (文字単位) を PyTorch で一から組み立てて学習する。

ブラウザ版 (gpt.js) とまったく同じ構造・同じ重みの名前なので、
ここで学習して書き出した JSON をブラウザ版に読み込んで遊べる。

    python tiny_gpt.py input.txt               # 学習して tiny_gpt.json を書き出す
    python tiny_gpt.py input.txt --steps 200   # 設定は --help を参照
"""

import argparse
import base64
import json
import math
import time

import torch
import torch.nn as nn
import torch.nn.functional as F


# ---------- 文字トークナイザ ----------
class CharTokenizer:
    def __init__(self, chars):
        self.chars = list(chars)
        self.index = {c: i for i, c in enumerate(self.chars)}

    @classmethod
    def from_text(cls, text):
        # JS 側と並び順を揃えるため、UTF-16 の並びでソートする
        return cls(sorted(set(text), key=lambda c: c.encode("utf-16-be")))

    def encode(self, text):
        return [self.index[c] for c in text if c in self.index]

    def decode(self, ids):
        return "".join(self.chars[i] for i in ids)


# ---------- モデル ----------
def param_shapes(cfg):
    C, V = cfg["nEmbd"], cfg["vocabSize"]
    shapes = {"wte": (V, C), "wpe": (cfg["blockSize"], C)}
    for i in range(cfg["nLayer"]):
        p = f"h{i}."
        shapes.update({
            p + "ln1_g": (C,), p + "ln1_b": (C,),
            p + "attn_w": (C, 3 * C), p + "attn_b": (3 * C,),
            p + "proj_w": (C, C), p + "proj_b": (C,),
            p + "ln2_g": (C,), p + "ln2_b": (C,),
            p + "fc_w": (C, 4 * C), p + "fc_b": (4 * C,),
            p + "fc2_w": (4 * C, C), p + "fc2_b": (C,),
        })
    shapes["lnf_g"] = (C,)
    shapes["lnf_b"] = (C,)
    shapes["head_w"] = (C, V)
    return shapes


class GPT(nn.Module):
    """行列は「入力 @ W」の向き ([入力次元, 出力次元]) で持つ (ブラウザ版と同じ)。"""

    def __init__(self, cfg):
        super().__init__()
        assert cfg["nEmbd"] % cfg["nHead"] == 0, "埋め込み次元はヘッド数で割り切れる必要があります"
        self.cfg = cfg
        resid_std = 0.02 / math.sqrt(2 * cfg["nLayer"])
        self.params = nn.ParameterDict()
        for name, shape in param_shapes(cfg).items():
            if name.endswith("_g"):
                t = torch.ones(shape)
            elif name.endswith("_b"):
                t = torch.zeros(shape)
            else:
                std = resid_std if ("proj_w" in name or "fc2_w" in name) else 0.02
                t = torch.randn(shape) * std
            # ParameterDict のキーに "." は使えないので置き換える
            self.params[name.replace(".", "_")] = nn.Parameter(t)
        T = cfg["blockSize"]
        self.register_buffer("mask", torch.tril(torch.ones(T, T, dtype=torch.bool)), persistent=False)

    def p(self, name):
        return self.params[name.replace(".", "_")]

    def forward(self, idx, targets=None):
        cfg, p = self.cfg, self.p
        B, T = idx.shape
        C, H = cfg["nEmbd"], cfg["nHead"]
        hs = C // H

        def ln(x, g, b):
            return F.layer_norm(x, (C,), p(g), p(b), eps=1e-5)

        x = p("wte")[idx] + p("wpe")[:T]
        for i in range(cfg["nLayer"]):
            l = f"h{i}."
            qkv = ln(x, l + "ln1_g", l + "ln1_b") @ p(l + "attn_w") + p(l + "attn_b")
            q, k, v = (t.view(B, T, H, hs).transpose(1, 2) for t in qkv.split(C, dim=-1))
            att = (q @ k.transpose(-2, -1)) / math.sqrt(hs)
            att = att.masked_fill(~self.mask[:T, :T], float("-inf")).softmax(-1)
            y = (att @ v).transpose(1, 2).reshape(B, T, C)
            x = x + y @ p(l + "proj_w") + p(l + "proj_b")
            h = F.gelu(ln(x, l + "ln2_g", l + "ln2_b") @ p(l + "fc_w") + p(l + "fc_b"), approximate="tanh")
            x = x + h @ p(l + "fc2_w") + p(l + "fc2_b")
        logits = ln(x, "lnf_g", "lnf_b") @ p("head_w")
        if targets is None:
            return logits
        return logits, F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1))

    @torch.no_grad()
    def generate(self, ids, n, temperature=0.8, top_k=0):
        x = torch.tensor([ids], dtype=torch.long, device=self.mask.device)
        for _ in range(n):
            logits = self(x[:, -self.cfg["blockSize"]:])[:, -1] / max(temperature, 1e-3)
            if top_k:
                kth = torch.topk(logits, min(top_k, logits.size(-1))).values[:, -1:]
                logits = logits.masked_fill(logits < kth, float("-inf"))
            nxt = torch.multinomial(logits.softmax(-1), 1)
            x = torch.cat([x, nxt], dim=1)
        return x[0].tolist()


# ---------- 保存形式 (ブラウザ版と共通の JSON) ----------
def save_json(model, tok, path):
    weights = {}
    for name in param_shapes(model.cfg):
        arr = model.p(name).detach().float().cpu().contiguous().numpy()
        weights[name] = base64.b64encode(arr.astype("<f4").tobytes()).decode()
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"format": "tiny-gpt-v1", "config": model.cfg, "vocab": tok.chars, "weights": weights},
                  f, ensure_ascii=False)


def load_json(path):
    import numpy as np
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    model = GPT(data["config"])
    for name, shape in param_shapes(data["config"]).items():
        arr = np.frombuffer(base64.b64decode(data["weights"][name]), dtype="<f4").reshape(shape)
        model.p(name).data.copy_(torch.from_numpy(arr.copy()))
    return model, CharTokenizer(data["vocab"])


# ---------- 学習 ----------
def train(text, n_layer=6, n_head=8, n_embd=256, block_size=256, batch_size=64,
          steps=3000, lr=1e-3, eval_every=250, device=None, out="tiny_gpt.json", log=print):
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    tok = CharTokenizer.from_text(text)
    data = torch.tensor(tok.encode(text), dtype=torch.long)
    n = int(len(data) * 0.9)
    train_data, val_data = data[:n], data[n:]
    if len(val_data) <= block_size + 1:
        val_data = train_data
    block_size = min(block_size, len(train_data) - 1)

    cfg = dict(vocabSize=len(tok.chars), nLayer=n_layer, nHead=n_head, nEmbd=n_embd, blockSize=block_size)
    model = GPT(cfg).to(device)
    log(f"文字数 {len(data):,} / 語彙 {len(tok.chars):,} / パラメータ {sum(p.numel() for p in model.parameters()):,} / {device}")

    def get_batch(split):
        d = train_data if split == "train" else val_data
        ix = torch.randint(len(d) - block_size, (batch_size,))
        x = torch.stack([d[i:i + block_size] for i in ix])
        y = torch.stack([d[i + 1:i + block_size + 1] for i in ix])
        return x.to(device), y.to(device)

    @torch.no_grad()
    def estimate():
        model.eval()
        out = {}
        for split in ("train", "val"):
            out[split] = sum(model(*get_batch(split))[1].item() for _ in range(10)) / 10
        model.train()
        return out

    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    warmup = max(1, steps // 20)
    t0 = time.time()
    for step in range(steps + 1):
        # 最初は徐々に上げ、あとはコサインで下げる
        scale = step / warmup if step < warmup else 0.5 * (1 + math.cos(math.pi * (step - warmup) / max(1, steps - warmup)))
        for g in opt.param_groups:
            g["lr"] = lr * max(scale, 0.1)
        if step % eval_every == 0 or step == steps:
            l = estimate()
            log(f"step {step:5d}  train {l['train']:.3f}  val {l['val']:.3f}  ({time.time() - t0:.0f}s)")
        if step == steps:
            break
        _, loss = model(*get_batch("train"))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()

    model.eval()
    if out:
        save_json(model, tok, out)
        log(f"{out} に保存しました")
    return model, tok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("text", help="学習に使うテキストファイル (UTF-8)")
    ap.add_argument("--layers", type=int, default=6)
    ap.add_argument("--heads", type=int, default=8)
    ap.add_argument("--embd", type=int, default=256)
    ap.add_argument("--block", type=int, default=256, help="一度に読む文字数")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--out", default="tiny_gpt.json")
    ap.add_argument("--prompt", default="", help="学習後に続きを書かせる書き出し")
    a = ap.parse_args()
    with open(a.text, encoding="utf-8") as f:
        text = f.read()
    model, tok = train(text, a.layers, a.heads, a.embd, a.block, a.batch, a.steps, a.lr, out=a.out)
    start = tok.encode(a.prompt) or [tok.encode(text)[0]]
    print(tok.decode(model.generate(start, 300)))


if __name__ == "__main__":
    main()
