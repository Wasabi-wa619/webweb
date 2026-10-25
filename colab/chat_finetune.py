"""公開されている小さなチャットモデルを、自分の「質問と答え」で追加学習 (LoRA) する。

ちいさなGPT工房の「質問: … / 答え: …」と同じ形の文章をそのまま使える。
一から作るモデルと違い、もとのモデルが日本語や一般常識をすでに知っているので、
教えていない質問にもそれらしく答えられる。そこに自分の知識や口調を足すのが LoRA。

    python chat_finetune.py my_qa.txt --model Qwen/Qwen2.5-1.5B-Instruct
"""

import argparse
import math
import random
import re

import torch

DEFAULT_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"
DEFAULT_SYSTEM = "あなたは親切なアシスタントです。日本語で簡潔に答えます。"


# ---------- データ ----------
def parse_qa(text):
    """「質問: …」「答え: …」の組を空行で区切った文章を (質問, 答え) のリストにする。
    答えは次の空行まで何行でもよい。「Q:」「A:」でも読める。"""
    pairs = []
    for block in re.split(r"\n\s*\n", text.strip()):
        m = re.match(r"\s*(?:質問|Q)\s*[:：]\s*(.+?)\n\s*(?:答え|A)\s*[:：]\s*(.+)", block, re.S)
        if m:
            pairs.append((m.group(1).strip(), m.group(2).strip()))
    return pairs


def _chat_text(tok, messages, add_generation_prompt):
    return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=add_generation_prompt)


def build_examples(tok, pairs, system=DEFAULT_SYSTEM, max_len=512):
    """答えの部分だけを学習するよう、質問側のラベルを -100 にする。"""
    examples = []
    for q, a in pairs:
        head = [{"role": "system", "content": system}, {"role": "user", "content": q}] if system else \
               [{"role": "user", "content": q}]
        prompt = _chat_text(tok, head, True)
        full = _chat_text(tok, head + [{"role": "assistant", "content": a}], False)
        if not full.startswith(prompt):
            raise ValueError("このモデルの会話テンプレートには対応していません")
        p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
        f_ids = tok(full, add_special_tokens=False)["input_ids"][:max_len]
        labels = [-100] * min(len(p_ids), len(f_ids)) + f_ids[len(p_ids):]
        examples.append((f_ids, labels))
    return examples


def _batches(examples, batch_size, pad_id, device):
    order = list(range(len(examples)))
    random.shuffle(order)
    for i in range(0, len(order), batch_size):
        chunk = [examples[j] for j in order[i:i + batch_size]]
        L = max(len(ids) for ids, _ in chunk)
        ids = torch.full((len(chunk), L), pad_id, dtype=torch.long)
        lab = torch.full((len(chunk), L), -100, dtype=torch.long)
        att = torch.zeros((len(chunk), L), dtype=torch.long)
        for k, (x, y) in enumerate(chunk):
            ids[k, :len(x)] = torch.tensor(x)
            lab[k, :len(y)] = torch.tensor(y)
            att[k, :len(x)] = 1
        yield ids.to(device), att.to(device), lab.to(device)


# ---------- モデル ----------
def load(model_name=DEFAULT_MODEL, device=None):
    from transformers import AutoModelForCausalLM, AutoTokenizer
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    tok = AutoTokenizer.from_pretrained(model_name)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    # T4 は bfloat16 が遅いので float16 で読む
    dtype = torch.float16 if device == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(model_name, dtype=dtype).to(device)
    return model, tok


def add_lora(model, r=16, alpha=32, dropout=0.05):
    from peft import LoraConfig, get_peft_model
    # 注意と MLP のすべての線形層に、小さな行列 (ランク r) を足して、そこだけ学習する
    cfg = LoraConfig(r=r, lora_alpha=alpha, lora_dropout=dropout, task_type="CAUSAL_LM",
                     target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, cfg)
    model.print_trainable_parameters()
    return model


def train(model, tok, pairs, system=DEFAULT_SYSTEM, epochs=3, batch_size=8, lr=2e-4, log=print):
    device = next(model.parameters()).device
    examples = build_examples(tok, pairs, system)
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
    total = epochs * math.ceil(len(examples) / batch_size)
    use_amp = device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    log(f"質問と答え {len(examples)} 組 / {epochs} 周 / {total} ステップ")
    model.train()
    step = 0
    for ep in range(epochs):
        losses = []
        for ids, att, lab in _batches(examples, batch_size, tok.pad_token_id, device):
            for g in opt.param_groups:  # コサインで下げる
                g["lr"] = lr * 0.5 * (1 + math.cos(math.pi * step / max(1, total)))
            with torch.autocast(device.type, dtype=torch.float16, enabled=use_amp):
                loss = model(input_ids=ids, attention_mask=att, labels=lab).loss
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            scaler.step(opt)
            scaler.update()
            losses.append(loss.item())
            step += 1
        log(f"{ep + 1} 周目  損失 {sum(losses) / len(losses):.3f}")
    model.eval()
    return model


@torch.no_grad()
def chat(model, tok, question, history=(), system=DEFAULT_SYSTEM, max_new_tokens=256, temperature=0.7):
    """history は [(質問, 答え), ...]。"""
    msgs = [{"role": "system", "content": system}] if system else []
    for q, a in history:
        msgs += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
    msgs.append({"role": "user", "content": question})
    enc = tok(_chat_text(tok, msgs, True), return_tensors="pt", add_special_tokens=False)
    enc = {k: v.to(next(model.parameters()).device) for k, v in enc.items()}
    out = model.generate(**enc, max_new_tokens=max_new_tokens, do_sample=temperature > 0,
                         temperature=temperature if temperature > 0 else None, top_p=0.9 if temperature > 0 else None,
                         pad_token_id=tok.pad_token_id)
    return tok.decode(out[0, enc["input_ids"].shape[1]:], skip_special_tokens=True).strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("qa", help="「質問: …」「答え: …」の文章 (UTF-8)")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--system", default=DEFAULT_SYSTEM)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--out", default="my_lora")
    a = ap.parse_args()
    with open(a.qa, encoding="utf-8") as f:
        pairs = parse_qa(f.read())
    model, tok = load(a.model)
    model = add_lora(model)
    train(model, tok, pairs, a.system, a.epochs, a.batch, a.lr)
    model.save_pretrained(a.out)
    tok.save_pretrained(a.out)
    print(f"{a.out} に保存しました")
    print(chat(model, tok, pairs[0][0], system=a.system))


if __name__ == "__main__":
    main()
