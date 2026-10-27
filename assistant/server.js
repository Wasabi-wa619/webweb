import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadConfig } from './lib/config.js';
import { Conversation } from './lib/agent.js';
import { usableEntries, parseEntry } from './lib/llm.js';
import * as browser from './lib/browser.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 7860);
const ON_SPACES = Boolean(process.env.SPACE_ID); // Hugging Face Spaces の中で動いているか
const ON_CODESPACES = process.env.CODESPACES === 'true';

const config = loadConfig();
const PASSWORD_FILE = path.join(config.dataDir, 'password.txt');

// Codespaces ではポートを公開 (Public) にして使うので、パスワードがなければ自動で作って保存する
function resolvePassword() {
  if (process.env.APP_PASSWORD) return process.env.APP_PASSWORD;
  if (!ON_CODESPACES) return '';
  try {
    const saved = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // まだない
  }
  const created = crypto.randomBytes(6).toString('base64url');
  fs.writeFileSync(PASSWORD_FILE, `${created}\n`, { mode: 0o600 });
  return created;
}

const PASSWORD = resolvePassword();
const PASSWORD_HINT = !process.env.APP_PASSWORD && ON_CODESPACES
  ? 'パスワードは、Codespace のエディターで assistant/data/password.txt を開くと書いてあります。'
  : '';
// パスワードがないときは、外から触れないよう自分のマシンだけで待ち受ける。
// ただし Spaces では、設定の手順を画面に出すために外から見えるようにする (API は使えない)
const SETUP_REQUIRED = !PASSWORD && ON_SPACES;
const HOST = process.env.HOST || (PASSWORD || ON_SPACES ? '0.0.0.0' : '127.0.0.1');
const TOKEN = PASSWORD ? crypto.createHmac('sha256', PASSWORD).update('webweb-assistant').digest('hex') : '';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

const conversation = new Conversation(config);
let running = null; // 実行中の { controller }

// キーのいらない AI (Ollama など) は、実際に動いているかを確かめる (30 秒だけ覚えておく)
const reachableCache = new Map();
async function reachable(baseUrl) {
  const hit = reachableCache.get(baseUrl);
  if (hit && hit.at > Date.now() - 30_000) return hit.ok;
  const ok = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  reachableCache.set(baseUrl, { ok, at: Date.now() });
  return ok;
}

// 画面に出す「いま使える AI」の一覧
async function availableRoles() {
  const roles = {};
  for (const [name, chain] of Object.entries(config.roles)) {
    roles[name] = [];
    for (const entry of usableEntries(config, chain)) {
      const p = config.providers[parseEntry(entry).provider];
      if (p.apiKeyEnv || await reachable(p.baseUrl)) roles[name].push(entry);
    }
  }
  return roles;
}

// API キーを登録する場所 (画面の案内に出す)
function secretsHelp() {
  if (process.env.CODESPACES === 'true') {
    return {
      url: 'https://github.com/settings/codespaces',
      where: 'GitHub の Codespaces 設定の「Secrets」→「New secret」',
      after: '登録したら、リポジトリへのアクセスを許可し、Codespace を停止して開き直してください',
    };
  }
  if (process.env.SPACE_ID) {
    return {
      url: `https://huggingface.co/spaces/${process.env.SPACE_ID}/settings`,
      where: 'Space の設定ページの「New secret」',
      after: '登録すると再起動するので、終わったら読み込み直してください',
    };
  }
  return { url: null, where: '環境変数', after: '設定したら、サーバーを起動し直してください' };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authorized(req) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : new URL(req.url, 'http://x').searchParams.get('token');
  return Boolean(token) && safeEqual(token, TOKEN);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('too large');
  }
  return body ? JSON.parse(body) : {};
}

function serveStatic(res, name) {
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function handleChat(req, res) {
  if (running) return sendJson(res, 409, { error: 'いま別の返事を作っています' });
  const { text, role } = await readJson(req);
  if (!text?.trim()) return sendJson(res, 400, { error: 'text が空です' });

  // 途中経過を 1 行ずつの JSON (NDJSON) で流す
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const emit = (event) => res.write(`${JSON.stringify(event)}\n`);
  const controller = new AbortController();
  running = { controller };
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    await conversation.send(text.trim(), { role, emit, signal: controller.signal });
  } catch (err) {
    emit({ type: 'error', text: err.message });
  } finally {
    running = null;
    emit({ type: 'done' });
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && /^\/[\w.-]+\.(js|css)$/.test(url.pathname)) return serveStatic(res, url.pathname.slice(1));

    if (SETUP_REQUIRED && url.pathname.startsWith('/api/')) {
      return sendJson(res, 503, { setup: 'password', spaceId: process.env.SPACE_ID });
    }
    if (url.pathname === '/api/hint' && req.method === 'GET') return sendJson(res, 200, { hint: PASSWORD_HINT });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const { password } = await readJson(req);
      if (PASSWORD && !safeEqual(password ?? '', PASSWORD)) return sendJson(res, 401, { error: 'パスワードが違います' });
      return sendJson(res, 200, { token: TOKEN });
    }
    if (url.pathname.startsWith('/api/') && !authorized(req)) return sendJson(res, 401, { error: 'ログインしてください' });

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const roles = await availableRoles();
      const keys = Object.values(config.providers).filter((p) => p.apiKeyEnv).map((p) => p.apiKeyEnv);
      return sendJson(res, 200, { history: conversation.display(), roles, keys, secrets: secretsHelp(), busy: Boolean(running) });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      running?.controller.abort();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      if (running) return sendJson(res, 409, { error: '返事を作っている最中です' });
      conversation.reset();
      await browser.close();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/screenshot' && req.method === 'GET') {
      const file = browser.latestScreenshot();
      if (!file || !fs.existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`assistant: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
  if (SETUP_REQUIRED) console.log('APP_PASSWORD が未設定です。Space の Settings → Secrets で設定してください。');
  if (PASSWORD_HINT) console.log(`パスワード: ${PASSWORD}  (${PASSWORD_FILE} に保存しています)`);
  else if (!PASSWORD) console.log('APP_PASSWORD が未設定なので、このマシンからだけ接続できます。');
  for (const [name, ok] of Object.entries(await availableRoles())) {
    console.log(`  ${name}: ${ok.length ? ok.join(' → ') : '(使えるAIなし: APIキーを設定してください)'}`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    setTimeout(() => process.exit(0), 3000).unref(); // Chrome が閉じきらなくても終わる
    await browser.close();
    process.exit(0);
  });
}
