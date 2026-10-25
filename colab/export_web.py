"""LoRA で追加学習したモデルを、ブラウザで動く形 (ONNX、4 ビット) にして Hugging Face に置く。

ONNX への変換 (optimum-onnx) は transformers 4.57 でしか動かないので、
Colab では別の Python 環境で実行する (chat_finetune.ipynb の手順を参照)。

    python export_web.py my_lora --base Qwen/Qwen2.5-0.5B-Instruct --out web_model
    python export_web.py my_lora --base ... --out web_model --repo あなたの名前/my-chat --space あなたの名前/my-chat-app
"""

import argparse
import json
import pathlib
import shutil
import tempfile


def merge(lora_dir, base, out_dir):
    """もとのモデルに LoRA の行列を足し込んで、ふつうのモデルとして保存する。"""
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer
    model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.float32)
    model = PeftModel.from_pretrained(model, lora_dir).merge_and_unload()
    model.save_pretrained(out_dir)
    # トークナイザは LoRA で変わらない。学習側の新しい transformers が保存したものは
    # この環境 (4.57) で読めないことがあるので、もとのモデルのものを使う
    AutoTokenizer.from_pretrained(base).save_pretrained(out_dir)


def to_onnx_q4(merged_dir, out_dir, block_size=32):
    """transformers.js が読める並び (onnx/model_q4.onnx と設定ファイル) で書き出す。"""
    import logging

    import onnx
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
    logging.getLogger("onnxruntime.quantization").setLevel(logging.WARNING)
    from optimum.exporters.onnx import main_export

    out = pathlib.Path(out_dir)
    (out / "onnx").mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        main_export(merged_dir, output=tmp, task="text-generation-with-past", device="cpu")
        # 行列の掛け算の重みを 4 ビットにする (大きさがおよそ 1/6 になる)
        q = MatMulNBitsQuantizer(onnx.load(f"{tmp}/model.onnx"), block_size=block_size, is_symmetric=True)
        q.process()
        model = q.model.model
        big = model.ByteSize() > 2_000_000_000  # 2GB を超えると重みを別ファイルにする必要がある
        onnx.save_model(model, str(out / "onnx" / "model_q4.onnx"), save_as_external_data=big,
                        all_tensors_to_one_file=True, location="model_q4.onnx_data")
        for name in ("config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
                     "special_tokens_map.json", "vocab.json", "merges.txt", "added_tokens.json"):
            for src in (pathlib.Path(tmp) / name, pathlib.Path(merged_dir) / name):
                if src.exists():
                    shutil.copy(src, out / name)
                    break

    # 会話テンプレートが別ファイル (chat_template.jinja) に保存されていることがあるので、
    # transformers.js が読む tokenizer_config.json に入れておく
    cfg_path = out / "tokenizer_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    jinja = pathlib.Path(merged_dir) / "chat_template.jinja"
    if not cfg.get("chat_template") and jinja.exists():
        cfg["chat_template"] = jinja.read_text(encoding="utf-8")
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    if not cfg.get("chat_template"):
        raise RuntimeError("会話テンプレートが見つかりません")
    if big:
        print("注意: 2GB を超えたので model_q4.onnx_data に重みを分けました。ブラウザでは重くなります")
    return out


def upload(out_dir, repo, space=None, app_dir=None, system=None, token=None):
    """モデルを公開リポジトリに、チャット画面を静的な Space に置く。"""
    from huggingface_hub import HfApi
    api = HfApi(token=token)
    api.create_repo(repo, exist_ok=True)
    api.upload_folder(repo_id=repo, folder_path=str(out_dir), commit_message="ブラウザ用のモデル (ONNX q4)")
    print(f"モデル: https://huggingface.co/{repo}")
    if not space:
        return
    app = pathlib.Path(app_dir)
    with tempfile.TemporaryDirectory() as tmp:
        for f in ("index.html", "worker.js"):
            shutil.copy(app / f, pathlib.Path(tmp) / f)
        # このモデルと口調を最初から使うようにする
        (pathlib.Path(tmp) / "config.js").write_text(
            "window.CHAT_CONFIG = " + json.dumps({"model": repo, "system": system or ""}, ensure_ascii=False) + ";\n",
            encoding="utf-8")
        (pathlib.Path(tmp) / "README.md").write_text(
            f"---\ntitle: {space.split('/')[-1]}\nemoji: 💬\nsdk: static\npinned: false\n---\n\n"
            f"ブラウザの中で動くチャット。モデル: [{repo}](https://huggingface.co/{repo})\n", encoding="utf-8")
        api.create_repo(space, repo_type="space", space_sdk="static", exist_ok=True)
        api.upload_folder(repo_id=space, repo_type="space", folder_path=tmp, commit_message="チャット画面")
    owner, name = space.split("/")
    print(f"チャット画面: https://huggingface.co/spaces/{space}")
    print(f"(直接開く: https://{owner.lower()}-{name.lower().replace('_', '-').replace('.', '-')}.static.hf.space)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lora", help="chat_finetune.py で保存した LoRA のフォルダ")
    ap.add_argument("--base", required=True, help="追加学習のもとにしたモデル")
    ap.add_argument("--out", default="web_model")
    ap.add_argument("--repo", help="モデルを置く Hugging Face のリポジトリ (例: あなたの名前/my-chat)")
    ap.add_argument("--space", help="チャット画面を置く Space (例: あなたの名前/my-chat-app)")
    ap.add_argument("--app", default=str(pathlib.Path(__file__).resolve().parent.parent / "chat"),
                    help="チャット画面のフォルダ (index.html と worker.js)")
    ap.add_argument("--system", default="", help="チャット画面で最初から使うキャラクター・口調の指示")
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as merged:
        print("LoRA を足し込んでいます…")
        merge(a.lora, a.base, merged)
        print("ONNX に変換して 4 ビットにしています…")
        to_onnx_q4(merged, a.out)
    size = sum(p.stat().st_size for p in pathlib.Path(a.out).rglob("*") if p.is_file())
    print(f"{a.out} に書き出しました ({size / 1e6:.0f} MB)")
    if a.repo:
        upload(a.out, a.repo, a.space, a.app, a.system)


if __name__ == "__main__":
    main()
