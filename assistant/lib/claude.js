// Claude (Anthropic API) とのやり取り。
// 会話の履歴は OpenAI 形式で持っているので、送るときに Claude の形式へ変換する。
// Claude が返した内容 (考えた跡の thinking ブロックを含む) は _claude にそのまま残し、
// 次に Claude へ送るときはそれを変えずに返す。

import Anthropic from '@anthropic-ai/sdk';

const MAX_TOKENS = 64_000;
const BETAS = [
  'server-side-fallback-2026-07-01', // 断られたとき、サーバー側で別の Claude に回す
  'thinking-binding-controls-2026-08-01', // 履歴を絞ったときに古い thinking を捨てられるようにする
];

const clients = new Map();

function client(apiKey) {
  if (!clients.has(apiKey)) clients.set(apiKey, new Anthropic({ apiKey, maxRetries: 1 }));
  return clients.get(apiKey);
}

// Claude の tool_use id は英数字・_・- だけ。他の AI が付けた id はそれに合わせる
export function toolId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function parseInput(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// OpenAI 形式のツール定義と履歴を、Claude の形式にする
export function toClaudeTools(tools = []) {
  return tools.map(({ function: f }) => ({
    name: f.name,
    description: f.description,
    input_schema: f.parameters,
    eager_input_streaming: true,
  }));
}

export function toClaudeMessages(messages) {
  const out = [];
  let toolResults = null; // 続けて来た tool の結果は 1 つの user メッセージにまとめる
  const flush = () => {
    if (toolResults) out.push({ role: 'user', content: toolResults });
    toolResults = null;
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      toolResults ??= [];
      toolResults.push({ type: 'tool_result', tool_use_id: toolId(m.tool_call_id), content: m.content || '(空)' });
      continue;
    }
    flush();
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m._claude) {
        out.push({ role: 'assistant', content: m._claude });
        continue;
      }
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls || []) {
        content.push({ type: 'tool_use', id: toolId(c.id), name: c.function.name, input: parseInput(c.function.arguments) });
      }
      if (content.length) out.push({ role: 'assistant', content });
    }
  }
  flush();
  return out;
}

// Claude の返事を、履歴に入れる OpenAI 形式にする
export function fromClaudeMessage(content) {
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const message = { role: 'assistant', content: text, _claude: content };
  const calls = content.filter((b) => b.type === 'tool_use');
  if (calls.length) {
    message.tool_calls = calls.map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  }
  return message;
}

// 失敗の種類。llm.js がこれを見て、次の AI に回すか決める
export class ClaudeFailure extends Error {
  constructor(message, { rateLimited = false } = {}) {
    super(message);
    this.rateLimited = rateLimited;
  }
}

export async function claudeChat({ apiKey, model, messages, tools, effort, signal, sdk = client(apiKey) }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const params = {
    model,
    max_tokens: MAX_TOKENS,
    system: system || undefined,
    messages: toClaudeMessages(messages.filter((m) => m.role !== 'system')),
    thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    output_config: { effort: effort || 'medium' },
    cache_control: { type: 'ephemeral' }, // 同じ前置きの再送を安くする
    fallbacks: 'default',
    betas: BETAS,
  };
  if (tools?.length) params.tools = toClaudeTools(tools);

  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await sdk.beta.messages.stream(params, { signal }).finalMessage();
      break;
    } catch (err) {
      if (signal?.aborted) throw err;
      const detail = err.error?.error?.message ?? err.message; // API が返した説明だけを取り出す
      if (err instanceof Anthropic.RateLimitError) throw new ClaudeFailure(`回数制限 (HTTP 429): ${detail}`, { rateLimited: true });
      if (err instanceof Anthropic.AuthenticationError) throw new ClaudeFailure(`API キーが正しくありません (HTTP 401): ${detail}`);
      if (err instanceof Anthropic.APIError) throw new ClaudeFailure(`HTTP ${err.status ?? '?'}: ${detail}`);
      // ツールの引数が JSON として読めなかったときだけ、やり直す
      if (attempt >= 2) throw new ClaudeFailure(`ツールの引数が読めませんでした: ${err.message}`);
    }
  }

  if (response.stop_reason === 'refusal') {
    throw new ClaudeFailure(`回答を断られました (${response.stop_details?.category ?? '理由不明'})`);
  }
  if (response.stop_reason === 'max_tokens' && response.content.some((b) => b.type === 'tool_use')) {
    throw new ClaudeFailure('出力が長すぎて、ツールの引数が途中で切れました');
  }
  return { message: fromClaudeMessage(response.content), model: response.model };
}
