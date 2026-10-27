# Hugging Face Spaces にこの 1 ファイルだけ置けば動きます。
# 中身 (プログラム本体) は GitHub から取ってきます。
# GitHub 側を更新したら、Space の Settings →「Factory rebuild」で最新になります。
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ARG REPO=Wasabi-wa619/webweb
ARG BRANCH=claude/busy-gates-q72fde
# ローカルAI (Ollama) も Space の中で動かすなら 1 にする (返事はかなり遅くなります)
ARG WITH_OLLAMA=0

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip git curl zstd \
 && if [ "$WITH_OLLAMA" = "1" ]; then curl -fsSL https://ollama.com/install.sh | sh; fi \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${BRANCH}" "https://github.com/${REPO}.git" /tmp/src \
 && mv /tmp/src/assistant /app && rm -rf /tmp/src

WORKDIR /app
RUN npm install --omit=dev && mkdir -p data workspace && chown -R 1000:1000 /app
USER 1000
ENV HOME=/app/data/home OLLAMA_MODELS=/app/data/ollama PORT=7860 TZ=Asia/Tokyo
EXPOSE 7860
CMD ["sh", "start.sh"]
