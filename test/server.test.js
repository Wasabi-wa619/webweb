import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxyServer } from '../server.js';

let upstream, proxy, UP, PX;
const sockets = new Set();
const track = (srv) => srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=shift_jis',
        'set-cookie': ['sid=abc; Path=/; HttpOnly', 'theme=dark; Path=/'],
        'content-security-policy': "default-src 'none'",
        'x-frame-options': 'DENY',
      });
      // "日本語" in Shift_JIS
      return res.end(Buffer.concat([Buffer.from('<html><head><title>'), Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]),
        Buffer.from('</title></head><body><a href="/next">n</a><img src="img.png"></body></html>')]));
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/page' });
      return res.end();
    }
    if (req.url === '/persist') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'pref=keep; Path=/; Max-Age=3600' });
      return res.end('<title>p</title>');
    }
    if (req.url === '/echo') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body, cookie: req.headers.cookie || '', referer: req.headers.referer || '' }));
      });
    }
    if (req.url === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('a{background:url(/bg.png)}');
    }
    res.writeHead(404);
    res.end('nope');
  });
  // Minimal WebSocket echo server
  upstream.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once('data', (buf) => {
      const len = buf[1] & 0x7f;
      const mask = buf.subarray(2, 6);
      const payload = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]));
      const reply = Buffer.from(`echo:${payload}|origin:${req.headers.origin}|cookie:${req.headers.cookie || ''}`);
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });
  track(upstream);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  UP = `http://127.0.0.1:${upstream.address().port}`;
  proxy = createProxyServer({ allowPrivate: true });
  track(proxy);
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  PX = `http://127.0.0.1:${proxy.address().port}`;
});

after(() => {
  for (const s of sockets) s.destroy();
  proxy.close();
  upstream.close();
});

test('HTML is decoded, rewritten and security headers stripped', async () => {
  const res = await fetch(`${PX}/p/${UP}/page`);
  const html = await res.text();
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('content-security-policy'), null);
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.match(html, /<title>日本語<\/title>/);
  assert.match(html, /<script src="\/__px\/client.js"><\/script>/);
  assert.ok(html.includes(`href="/p/${UP}/next"`));
  assert.ok(html.includes(`src="/p/${UP}/img.png"`));
  // only non-HttpOnly cookies are exposed to page scripts
  assert.match(html, /"cookies":"theme=dark"/);
});

test('cookies are kept server-side per session and redirects are rewritten', async () => {
  const first = await fetch(`${PX}/p/${UP}/redirect`, { redirect: 'manual' });
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), `/p/${UP}/page`);
  const sid = first.headers.getSetCookie().find((c) => c.startsWith('__px_sid=')).split(';')[0];

  await fetch(`${PX}/p/${UP}/page`, { headers: { cookie: sid } });
  const echo = await (await fetch(`${PX}/p/${UP}/echo`, {
    method: 'POST', body: 'hello', headers: { cookie: sid, referer: `${PX}/p/${UP}/page` },
  })).json();
  assert.equal(echo.method, 'POST');
  assert.equal(echo.body, 'hello');
  assert.match(echo.cookie, /sid=abc/);
  assert.equal(echo.referer, `${UP}/page`);

  // cookies written by page JS via document.cookie
  await fetch(`${PX}/__px/cookie`, {
    method: 'POST', headers: { cookie: sid }, body: JSON.stringify({ url: `${UP}/page`, cookie: 'js=1; path=/' }),
  });
  const echo2 = await (await fetch(`${PX}/p/${UP}/echo`, { headers: { cookie: sid } })).json();
  assert.match(echo2.cookie, /js=1/);
});

test('CSS is rewritten', async () => {
  const css = await (await fetch(`${PX}/p/${UP}/style.css`)).text();
  assert.equal(css, `a{background:url("/p/${UP}/bg.png")}`);
});

test('root-relative requests fall back to the referring site', async () => {
  const res = await fetch(`${PX}/echo?x=1`, { redirect: 'manual', headers: { referer: `${PX}/p/${UP}/page` } });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), `/p/${UP}/echo?x=1`);
});

test('private hosts are blocked by default', async () => {
  const strict = createProxyServer();
  await new Promise((r) => strict.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${strict.address().port}/p/${UP}/page`);
  assert.equal(res.status, 403);
  strict.closeAllConnections();
  strict.close();
});

test('WebSocket is tunnelled with the real origin', async () => {
  const wsUrl = `${PX.replace('http', 'ws')}/__px/ws?url=${encodeURIComponent(UP.replace('http', 'ws') + '/sock')}&origin=${encodeURIComponent('https://site.test')}`;
  const ws = new WebSocket(wsUrl);
  const msg = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send('ping');
    ws.onmessage = (e) => resolve(e.data);
    ws.onerror = () => reject(new Error('ws error'));
  });
  ws.close();
  assert.equal(msg, 'echo:ping|origin:https://site.test|cookie:');
});

test('cookie jar persists to disk across restarts', async () => {
  const store = path.join(os.tmpdir(), `px-store-${crypto.randomUUID()}.json`);
  const s1 = createProxyServer({ allowPrivate: true, storePath: store });
  await new Promise((r) => s1.listen(0, '127.0.0.1', r));
  track(s1);
  const P1 = `http://127.0.0.1:${s1.address().port}`;
  const first = await fetch(`${P1}/p/${UP}/persist`);
  const sid = first.headers.getSetCookie().find((c) => c.startsWith('__px_sid=')).split(';')[0];
  // give the debounced write time to flush, then stop the server
  await new Promise((r) => setTimeout(r, 1200));
  await new Promise((r) => s1.close(r));
  assert.ok(fs.existsSync(store), 'store file written');

  // a fresh server loads the same jar; the persisted cookie is replayed upstream
  const s2 = createProxyServer({ allowPrivate: true, storePath: store });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  track(s2);
  const P2 = `http://127.0.0.1:${s2.address().port}`;
  const echo = await (await fetch(`${P2}/p/${UP}/echo`, { headers: { cookie: sid } })).json();
  assert.match(echo.cookie, /pref=keep/);
  await new Promise((r) => s2.close(r));
  fs.rmSync(store, { force: true });
});
