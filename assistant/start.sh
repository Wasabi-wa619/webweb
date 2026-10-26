#!/bin/sh
# Ollama が入っていれば裏で起動し、小さいモデルを取ってくる (初回は数分かかる)
mkdir -p "$HOME"
if command -v ollama >/dev/null 2>&1; then
  ollama serve >/tmp/ollama.log 2>&1 &
  (sleep 3 && ollama pull "${OLLAMA_MODEL:-qwen3:1.7b}" >>/tmp/ollama.log 2>&1) &
fi
exec node server.js
