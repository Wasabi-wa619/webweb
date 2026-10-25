// チャット画面の初期設定。colab/export_web.py で Space に置くと、自分のモデルに書き換わる。
// model: Hugging Face のリポジトリ名 (onnx/model_q4.onnx を含むもの)
// system: キャラクターや口調の指示 (空なら画面の既定)
window.CHAT_CONFIG = { model: 'onnx-community/Qwen2.5-0.5B-Instruct', system: '' };
