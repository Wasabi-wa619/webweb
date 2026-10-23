import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PREFIX, PROXIED_RE, proxify, decodeTarget, unproxyUrl, rewriteHtml, rewriteCss } from './lib/rewrite.js';
import { CookieJar } from './lib/cookies.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const SID_COOKIE = '__px_sid';
const ORIGIN_COOKIE = '__px_origin';
const MAX_BODY = 100 * 1024 * 1024;

// 上流に転送しないリクエストヘッダー
const DROP_REQ_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'expect', 'http2-settings', 'cookie', 'origin', 'referer',
  'accept-encoding', 'content-length', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
  'sec-fetch-user', 'service-worker', 'priority',
]);

// ブラウザに返さないレスポンスヘッダー
const DROP_RES_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'content-encoding', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'set-cookie', 'cross-origin-embedder-policy', 'cross-origin-opener-policy',
  'cross-origin-resource-policy', 'report-to', 'nel', 'alt-svc', 'link', 'clear-site-data',
  'referrer-policy', 'location', 'refresh',
]);

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
  }
  return false;
}

async function isBlockedHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  try {
    const addrs = await dns.lookup(h, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return false; // 名前解決の失敗は fetch 側のエラーに任せる
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function detectCharset(contentType, buf, isHtml) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType);
  if (m) return m[1];
  if (isHtml) {
    const head = buf.subarray(0, 2048).toString('latin1');
    const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
    if (meta) return meta[1];
  }
  return 'utf-8';
}

function decodeText(buf, charset) {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function errorPage(res, status, title, detail = '') {
  if (res.headersSent) return res.destroy();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:15vh auto;padding:0 16px">
<h1 style="font-size:1.4rem">${esc(title)}</h1><p style="color:#666">${esc(detail)}</p><p><a href="/">トップへ戻る</a></p></body>`);
}

function scriptJson(obj) {
  return JSON.stringify(obj).replace(/[<\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function createProxyServer({ allowPrivate = false } = {}) {
  const jars = new Map(); // セッションID -> CookieJar

  function session(req, res, outCookies) {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies[SID_COOKIE];
    if (!sid || !jars.has(sid)) {
      sid = crypto.randomBytes(16).toString('hex');
      jars.set(sid, new CookieJar());
      outCookies.push(`${SID_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return { jar: jars.get(sid), cookies };
  }

  function serveStatic(res, file, type) {
    fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
      if (err) return errorPage(res, 404, 'Not Found');
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      res.end(data);
    });
  }

  async function proxy(req, res, target, jar, outCookies) {
    if (!allowPrivate && (await isBlockedHost(target.hostname))) {
      return errorPage(res, 403, 'アクセスできません', 'ローカル/プライベートネットワークへのアクセスは無効になっています。');
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (DROP_REQ_HEADERS.has(k) || k.startsWith('x-forwarded-')) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const cookie = jar.getCookieHeader(target);
    if (cookie) headers.cookie = cookie;
    const realReferer = req.headers.referer && unproxyUrl(req.headers.referer);
    if (realReferer) headers.referer = realReferer.href;
    if (req.headers.origin) headers.origin = realReferer ? realReferer.origin : target.origin;

    const method = req.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);

    let up;
    try {
      up = await fetch(target, { method, headers, body, redirect: 'manual' });
    } catch (err) {
      return errorPage(res, 502, '接続に失敗しました', `${target.href}: ${err.cause?.message || err.message}`);
    }

    for (const sc of up.headers.getSetCookie()) jar.setCookie(sc, target);

    const out = {};
    for (const [k, v] of up.headers) {
      if (!DROP_RES_HEADERS.has(k)) out[k] = v;
    }
    const location = up.headers.get('location');
    if (location) out.location = proxify(location, target.href);
    const refresh = up.headers.get('refresh');
    if (refresh) out.refresh = refresh.replace(/(url\s*=\s*)(\S+)/i, (_, p, u) => p + proxify(u, target.href));

    const ct = up.headers.get('content-type') || '';
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
    const isCss = /text\/css/i.test(ct);
    const hasBody = method !== 'HEAD' && up.status !== 204 && up.status !== 304 && up.body;

    if (hasBody && (isHtml || isCss)) {
      const buf = Buffer.from(await up.arrayBuffer());
      let text = decodeText(buf, detectCharset(ct, buf, isHtml));
      if (isHtml) {
        outCookies.push(`${ORIGIN_COOKIE}=${encodeURIComponent(target.origin)}; Path=/; SameSite=Lax`);
        const cfg = { url: target.href, cookies: jar.getCookieHeader(target, { includeHttpOnly: false }) };
        const inject = `<script>window.__PX=${scriptJson(cfg)}</script><script src="/__px/client.js"></script>`;
        text = rewriteHtml(text, target.href, { inject });
      } else {
        text = rewriteCss(text, (u) => proxify(u, target.href));
      }
      const data = Buffer.from(text, 'utf-8');
      out['content-type'] = ct.split(';')[0].trim() + '; charset=utf-8';
      out['content-length'] = data.length;
      if (outCookies.length) out['set-cookie'] = outCookies;
      res.writeHead(up.status, out);
      return res.end(data);
    }

    // それ以外 (JS・画像・動画など) はそのままストリーミング
    const enc = up.headers.get('content-encoding');
    const len = up.headers.get('content-length');
    if (len && (!enc || enc === 'identity')) out['content-length'] = len;
    if (outCookies.length) out['set-cookie'] = outCookies;
    res.writeHead(up.status, out);
    if (!hasBody) return res.end();
    pipeline(Readable.fromWeb(up.body), res, () => {});
  }

  async function handle(req, res) {
    const outCookies = [];
    const url = req.url || '/';
    const pathname = url.split('?')[0];

    const fromReferer = req.headers.referer && unproxyUrl(req.headers.referer);
    if (pathname === '/' && !fromReferer) return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
    if (pathname === '/__px/client.js') return serveStatic(res, 'client.js', 'text/javascript; charset=utf-8');

    const { jar, cookies } = session(req, res, outCookies);

    // ページの JS から document.cookie に書き込まれたクッキー
    if (pathname === '/__px/cookie' && req.method === 'POST') {
      try {
        const { url: pageUrl, cookie } = JSON.parse((await readBody(req)).toString('utf-8'));
        const u = new URL(pageUrl);
        if (u.protocol === 'http:' || u.protocol === 'https:') jar.setCookie(cookie, u, { fromScript: true });
      } catch {}
      res.writeHead(204, outCookies.length ? { 'set-cookie': outCookies } : {});
      return res.end();
    }

    if (PROXIED_RE.test(pathname)) {
      const target = decodeTarget(url);
      if (!target) return errorPage(res, 400, 'URLが不正です', url);
      return proxy(req, res, target, jar, outCookies);
    }

    // "/api/foo" のようなルート相対リクエスト → 参照元ページのオリジンへ転送
    const origin = fromReferer ? fromReferer.origin : cookies[ORIGIN_COOKIE];
    if (origin && /^https?:\/\//.test(origin)) {
      const h = { location: PREFIX + origin + url, 'cache-control': 'no-store' };
      if (outCookies.length) h['set-cookie'] = outCookies;
      res.writeHead(307, h);
      return res.end();
    }
    if (pathname.startsWith(PREFIX)) {
      const target = decodeTarget(url); // "/p/example.com" のような省略形
      if (target) return proxy(req, res, target, jar, outCookies);
    }
    return errorPage(res, 404, 'Not Found', url);
  }

  // WebSocket: /__px/ws?url=wss://...&origin=https://...
  async function upgrade(req, socket, head) {
    socket.on('error', () => {});
    const reject = (code, msg) => socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    let target;
    let origin;
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== '/__px/ws') return reject(404, 'Not Found');
      target = new URL(u.searchParams.get('url'));
      if (target.protocol !== 'ws:' && target.protocol !== 'wss:') return reject(400, 'Bad Request');
      origin = u.searchParams.get('origin');
    } catch {
      return reject(400, 'Bad Request');
    }
    if (!allowPrivate && (await isBlockedHost(target.hostname))) return reject(403, 'Forbidden');

    const secure = target.protocol === 'wss:';
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = Number(target.port) || (secure ? 443 : 80);
    const sid = parseCookies(req.headers.cookie)[SID_COOKIE];
    const jar = jars.get(sid);

    const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`];
    for (const k of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions',
      'sec-websocket-protocol', 'user-agent', 'accept-language', 'pragma', 'cache-control']) {
      if (req.headers[k]) lines.push(`${k}: ${req.headers[k]}`);
    }
    lines.push(`Origin: ${origin && /^https?:\/\//.test(origin) ? origin : (secure ? 'https://' : 'http://') + target.host}`);
    const cookie = jar && jar.getCookieHeader(new URL(target.href.replace(/^ws/, 'http')));
    if (cookie) lines.push(`Cookie: ${cookie}`);

    const upstream = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host, port });
    const kill = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.once(secure ? 'secureConnect' : 'connect', () => {
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', kill);
    upstream.on('close', kill);
    socket.on('close', kill);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => errorPage(res, 500, 'プロキシエラー', err.message));
  });
  server.on('upgrade', (req, socket, head) => {
    upgrade(req, socket, head).catch(() => socket.destroy());
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '0.0.0.0';
  createProxyServer({ allowPrivate: process.env.ALLOW_PRIVATE === '1' }).listen(port, host, () => {
    console.log(`Web proxy listening on http://localhost:${port}`);
  });
}
