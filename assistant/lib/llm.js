// OpenAI 互換の Chat Completions API を話す最小のクライアント。
// Gemini / Groq / OpenRouter / Ollama はどれもこの形式に対応しているので、
// 「provider:model」の並び (チェーン) を前から順に試し、だめなら次に回す。
// "type": "anthropic" のプロバイダーだけは Claude の API で話す (lib/claude.js)。

import { claudeChat, ClaudeFailure } from './claude.js';

const COOLDOWN_MS = 60_000;
const cooldowns = new Map(); // "provider:model" -> 使えるようになる時刻

export function parseEntry(entry) {
  const i = entry.indexOf(':');
  if (i < 0) throw new Error(`"provider:model" の形で書いてください: ${entry}`);
  return { provider: entry.slice(0, i), model: entry.slice(i + 1) };
}

// チェーンのうち、API キーがそろっていてクールダウン中でないものを返す
export function usableEntries(config, chain, now = Date.now()) {
  return chain.filter((entry) => {
    const { provider } = parseEntry(entry);
    const p = config.providers[provider];
    if (!p) return false;
    if (p.apiKeyEnv && !process.env[p.apiKeyEnv]) return false;
    return (cooldowns.get(entry) ?? 0) <= now;
  });
}

export class LlmError extends Error {}

export async function chat(config, chain, { messages, tools, role, signal, fetchImpl = fetch, claudeSdk }) {
  const entries = usableEntries(config, chain);
  if (!entries.length) {
    throw new LlmError('使えるAIがありません。APIキーの設定 (または Ollama の起動) を確認してください。');
  }
  const failures = [];
  for (const entry of entries) {
    const { provider, model } = parseEntry(entry);
    const p = config.providers[provider];
    if (p.type === 'anthropic') {
      try {
        const result = await claudeChat({
          apiKey: process.env[p.apiKeyEnv], model, messages, tools, signal, sdk: claudeSdk,
          effort: config.effort?.[role],
        });
        return { message: result.message, used: `${provider}:${result.model}` };
      } catch (err) {
        if (signal?.aborted || !(err instanceof ClaudeFailure)) throw err;
        if (err.rateLimited) cooldowns.set(entry, Date.now() + COOLDOWN_MS);
        failures.push(`${entry}: ${err.message}`);
        continue;
      }
    }
    const headers = { 'content-type': 'application/json' };
    if (p.apiKeyEnv) headers.authorization = `Bearer ${process.env[p.apiKeyEnv]}`;
    // Claude 用に残している _claude は、ほかの AI には送らない
    const body = { model, messages: messages.map(({ _claude, ...m }) => m) };
    if (tools?.length) body.tools = tools;
    let res;
    try {
      res = await fetchImpl(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      failures.push(`${entry}: ${err.message}`);
      continue;
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      // 回数制限にかかったものはしばらく使わない
      if (res.status === 429) cooldowns.set(entry, Date.now() + COOLDOWN_MS);
      failures.push(`${entry}: HTTP ${res.status} ${text}`);
      continue;
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) {
      failures.push(`${entry}: 応答が空でした`);
      continue;
    }
    // 履歴には API に送り返せる項目だけを残す (reasoning などは捨てる)
    const message = { role: 'assistant', content: msg.content ?? '' };
    if (msg.tool_calls?.length) message.tool_calls = msg.tool_calls.map((c, i) => ({
        id: c.id || `call_${Date.now().toString(36)}_${i}`, // id を返さないサーバーもある
        type: 'function',
        function: { name: c.function.name, arguments: c.function.arguments || '{}' },
      }));
    return { message, used: `${provider}:${data.model || model}` };
  }
  throw new LlmError(`すべてのAIで失敗しました:\n${failures.join('\n')}`);
}

export function resetCooldowns() {
  cooldowns.clear();
}
