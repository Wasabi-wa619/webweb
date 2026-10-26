// Ollama (ローカルで動く無料の LLM) とのやりとり

export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

/**
 * /api/chat をストリーミングで呼び出す。
 * 本文が届くたびに onText を呼び、最後にアシスタントのメッセージ全体を返す。
 */
export async function chat({ model, messages, tools, think, numCtx, onText, signal }) {
  const body = { model, messages, tools, stream: true, options: { num_ctx: numCtx } };
  if (think !== undefined) body.think = think;

  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new Error(`Ollama に接続できません (${OLLAMA_URL})。Ollama が起動しているか確認してください: ${err.message}`);
  }
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404) throw new Error(`モデル "${model}" が見つかりません。\`ollama pull ${model}\` を実行してください。`);
    throw new Error(`Ollama エラー ${res.status}: ${text}`);
  }

  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  const decoder = new TextDecoder();
  let buf = '';

  const handleLine = (line) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(`Ollama エラー: ${chunk.error}`);
    const m = chunk.message || {};
    if (m.content) {
      message.content += m.content;
      onText?.(m.content);
    }
    if (m.tool_calls) toolCalls.push(...m.tool_calls);
  };

  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handleLine(buf + decoder.decode());

  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

/** 入っているモデルの一覧 */
export async function listModels() {
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error(`Ollama エラー ${res.status}`);
  const { models = [] } = await res.json();
  return models.map((m) => m.name);
}
