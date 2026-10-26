import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chat, parseEntry, usableEntries, resetCooldowns } from '../lib/llm.js';
import { parseDuckDuckGo, htmlToText } from '../lib/web.js';
import { resolveInWorkspace, validateArgs, runTool } from '../lib/tools.js';
import { Conversation, recentHistory } from '../lib/agent.js';

let tmp;
let config;
const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function reply(message, model = 'm') {
  return jsonResponse({ model, choices: [{ message }] });
}

beforeEach(() => {
  resetCooldowns();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-test-'));
  fs.mkdirSync(path.join(tmp, 'ws'));
  process.env.TEST_KEY_A = 'a';
  process.env.TEST_KEY_B = 'b';
  delete process.env.TEST_KEY_MISSING;
  config = {
    providers: {
      a: { baseUrl: 'https://a.example/v1', apiKeyEnv: 'TEST_KEY_A' },
      b: { baseUrl: 'https://b.example/v1/', apiKeyEnv: 'TEST_KEY_B' },
      nokey: { baseUrl: 'https://n.example/v1', apiKeyEnv: 'TEST_KEY_MISSING' },
      local: { baseUrl: 'http://127.0.0.1:11434/v1' },
    },
    roles: { main: ['a:model-a', 'b:model-b'], coder: ['b:coder-b'] },
    maxSteps: 5,
    dataDir: tmp,
    workspace: path.join(tmp, 'ws'),
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseEntry splits at the first colon only', () => {
  assert.deepEqual(parseEntry('ollama:qwen3:1.7b'), { provider: 'ollama', model: 'qwen3:1.7b' });
  assert.deepEqual(parseEntry('groq:openai/gpt-oss-120b'), { provider: 'groq', model: 'openai/gpt-oss-120b' });
  assert.throws(() => parseEntry('nocolon'));
});

test('usableEntries skips providers without keys, unknown providers, but keeps keyless local ones', () => {
  const chain = ['nokey:x', 'a:y', 'unknown:z', 'local:w'];
  assert.deepEqual(usableEntries(config, chain), ['a:y', 'local:w']);
});

test('chat falls back to the next provider on 429 and cools the failed one down', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    if (url.startsWith('https://a.example')) return new Response('rate limited', { status: 429 });
    return reply({ content: 'こんにちは', reasoning: 'secret' }, 'model-b-001');
  };
  const { message, used } = await chat(config, config.roles.main, { messages: [{ role: 'user', content: 'hi' }], fetchImpl });
  assert.equal(message.content, 'こんにちは');
  assert.equal(message.reasoning, undefined);
  assert.equal(used, 'b:model-b-001');
  assert.equal(calls[0].url, 'https://a.example/v1/chat/completions');
  assert.equal(calls[1].url, 'https://b.example/v1/chat/completions');
  assert.equal(calls[1].auth, 'Bearer b');
  assert.deepEqual(usableEntries(config, config.roles.main), ['b:model-b']);
});

test('chat reports every failure when the whole chain fails', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('https://a.example')) throw new Error('ECONNREFUSED');
    return new Response('bad', { status: 500 });
  };
  await assert.rejects(chat(config, config.roles.main, { messages: [], fetchImpl }), /a:model-a: ECONNREFUSED[\s\S]*b:model-b: HTTP 500/);
});

test('chat fills in missing tool call ids and arguments', async () => {
  const fetchImpl = async () => reply({ content: null, tool_calls: [{ function: { name: 'browser_back' } }] });
  const { message } = await chat(config, ['a:x'], { messages: [], fetchImpl });
  assert.equal(message.content, '');
  assert.match(message.tool_calls[0].id, /^call_/);
  assert.equal(message.tool_calls[0].function.arguments, '{}');
});

test('parseDuckDuckGo extracts real URLs and skips ads', () => {
  const html = `
    <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/y.js?ad=1">Ad</a></div>
    <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;rut=x">Example &amp; <b>Title</b></a>
    <a class="result__snippet" href="#">Some <b>snippet</b> text</a></div>`;
  assert.deepEqual(parseDuckDuckGo(html), [{ title: 'Example & Title', url: 'https://example.com/a?b=1', snippet: 'Some snippet text' }]);
});

test('htmlToText drops scripts and keeps paragraphs', () => {
  const text = htmlToText('<html><title>T</title><script>evil()</script><p>一行目</p><p>二&nbsp;行目</p></html>');
  assert.equal(text, '# T\n\n一行目\n二 行目');
});

test('resolveInWorkspace blocks paths that escape the workspace', async () => {
  const ws = config.workspace;
  assert.equal(await resolveInWorkspace(ws, 'a/b.txt'), path.join(fs.realpathSync(ws), 'a/b.txt'));
  assert.equal(await resolveInWorkspace(ws, '/abs.txt'), path.join(fs.realpathSync(ws), 'abs.txt'));
  await assert.rejects(resolveInWorkspace(ws, '../outside.txt'), /外/);
  fs.symlinkSync(tmp, path.join(ws, 'link'));
  await assert.rejects(resolveInWorkspace(ws, 'link/secret.txt'), /外/);
});

test('validateArgs checks required and typed arguments', () => {
  assert.throws(() => validateArgs('web_search', {}), /query/);
  assert.throws(() => validateArgs('browser_click', { id: 'abc' }), /整数/);
  assert.throws(() => validateArgs('nope', {}), /知らない/);
  assert.deepEqual(validateArgs('browser_type', { id: 3, text: 'x' }), { id: 3, text: 'x' });
});

test('file tools and run_command work inside the workspace', async () => {
  const ctx = { config };
  await runTool('write_file', { path: 'src/hello.py', content: 'print("hi")\n' }, ctx);
  await runTool('edit_file', { path: 'src/hello.py', old: 'hi', new: 'やあ' }, ctx);
  assert.equal(await runTool('read_file', { path: 'src/hello.py' }, ctx), 'print("やあ")\n');
  assert.equal(await runTool('list_files', {}, ctx), 'src/');
  assert.match(await runTool('run_command', { command: 'cat src/hello.py && exit 3' }, ctx), /終了コード: 3\nprint/);
  await assert.rejects(runTool('edit_file', { path: 'src/hello.py', old: 'zzz', new: '' }, ctx), /0 回/);
});

test('remember appends to the memory file', async () => {
  await runTool('remember', { note: '好きな色は青\n本当に' }, { config });
  assert.equal(fs.readFileSync(path.join(tmp, 'memory.md'), 'utf8'), '- 好きな色は青 本当に\n');
});

test('recentHistory never starts in the middle of a tool exchange', () => {
  const msgs = [
    { role: 'user', content: '1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't' }] },
    { role: 'tool', tool_call_id: 't', content: 'r' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: '2' },
    { role: 'assistant', content: 'b' },
  ];
  assert.deepEqual(recentHistory(msgs, 4).map((m) => m.content), ['2', 'b']);
  assert.equal(recentHistory(msgs, 10).length, 6);
});

test('Conversation runs tools until the model answers and persists history', async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (requests.length === 1) {
      return reply({ content: '書くね', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"x.txt","content":"ok"}' } }] });
    }
    if (requests.length === 2) {
      return reply({ content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{bad json' } }] });
    }
    return reply({ content: 'できたよ' });
  };
  const events = [];
  const conv = new Conversation(config);
  await conv.send('ファイル作って', { emit: (e) => events.push(e) });

  assert.equal(fs.readFileSync(path.join(config.workspace, 'x.txt'), 'utf8'), 'ok');
  assert.equal(requests[0].messages[0].role, 'system');
  assert.match(requests[0].messages[0].content, /キャラクター/);
  assert.ok(requests[0].tools.some((t) => t.function.name === 'web_search'));
  const toolMsgs = requests[2].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['c1', 'c2']);
  assert.match(toolMsgs[1].content, /^エラー: 引数が JSON/);
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['書くね', 'できたよ']);

  const reloaded = new Conversation(config);
  assert.equal(reloaded.messages.length, conv.messages.length);
  assert.deepEqual(reloaded.display().map((i) => i.type), ['user', 'text', 'tool', 'tool', 'text']);
});

test('Conversation answers pending tool calls when aborted', async () => {
  const controller = new AbortController();
  globalThis.fetch = async () => {
    controller.abort();
    return reply({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] });
  };
  const conv = new Conversation(config);
  await assert.rejects(conv.send('hi', { signal: controller.signal }), /中断/);
  const last = conv.messages.at(-1);
  assert.equal(last.role, 'tool');
  assert.equal(last.tool_call_id, 'c1');
  assert.match(last.content, /中断/);
});
