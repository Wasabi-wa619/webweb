# Hugging Face Spaces (Docker) 用。Chrome (Chromium) 入りの公式 Playwright イメージを使う
FROM mcr.microsoft.com/playwright:v1.64.1-noble

# ローカルAI (Ollama) も入れる場合は、Space の Variables で WITH_OLLAMA=1 にする
ARG WITH_OLLAMA=0
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip git curl zstd \
 && if [ "$WITH_OLLAMA" = "1" ]; then curl -fsSL https://ollama.com/install.sh | sh; fi \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

# Spaces はユーザー ID 1000 で動かすので、書き込む場所をその人のものにしておく
RUN mkdir -p /app/data /app/workspace && chown -R 1000:1000 /app
USER 1000
ENV HOME=/app/data/home \
    OLLAMA_MODELS=/app/data/ollama \
    PORT=7860 \
    TZ=Asia/Tokyo

EXPOSE 7860
CMD ["sh", "start.sh"]
