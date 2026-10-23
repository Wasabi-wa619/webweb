import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxify, decodeTarget, rewriteHtml, rewriteCss, rewriteSrcset, shouldScopeScript } from '../lib/rewrite.js';
import { CookieJar } from '../lib/cookies.js';

const BASE = 'https://example.com/dir/page.html';

test('proxify resolves and prefixes URLs', () => {
  assert.equal(proxify('/a?b=1', BASE), '/p/https://example.com/a?b=1');
  assert.equal(proxify('img.png', BASE), '/p/https://example.com/dir/img.png');
  assert.equal(proxify('//cdn.example.net/x.js', BASE), '/p/https://cdn.example.net/x.js');
  for (const u of ['#top', 'javascript:void 0', 'data:text/plain,hi', 'mailto:a@b.c', '']) {
    assert.equal(proxify(u, BASE), u);
  }
});

test('decodeTarget handles collapsed slashes and shorthand', () => {
  assert.equal(decodeTarget('/p/https://example.com/a?x=1').href, 'https://example.com/a?x=1');
  assert.equal(decodeTarget('/p/https:/example.com/a').href, 'https://example.com/a');
  assert.equal(decodeTarget('/p/example.com').href, 'https://example.com/');
});

test('rewriteHtml rewrites attributes, injects script, keeps script bodies', () => {
  const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<link rel="stylesheet" href="/s.css" integrity="sha384-x"><style>body{background:url('bg.png')}</style></head>
<body><a href="https://other.org/?a=1&amp;b=2">x</a><a href="#frag">y</a>
<img srcset="a.png 1x, /b.png 2x" style="background:url(c.png)">
<form action="/search"></form><script>if (a < b && "<a href='/z'>") {}</script>
<meta http-equiv="refresh" content="0; url=/next"></body></html>`;
  const out = rewriteHtml(html, BASE, { inject: '<!--INJ-->' });
  assert.match(out, /<head><!--INJ-->/);
  assert.doesNotMatch(out, /Content-Security-Policy/);
  assert.doesNotMatch(out, /integrity/);
  assert.match(out, /href="\/p\/https:\/\/example.com\/s.css"/);
  assert.match(out, /url\("\/p\/https:\/\/example.com\/dir\/bg.png"\)/);
  assert.match(out, /href="\/p\/https:\/\/other.org\/\?a=1&amp;b=2"/);
  assert.match(out, /href="#frag"/);
  assert.match(out, /srcset="\/p\/https:\/\/example.com\/dir\/a.png 1x, \/p\/https:\/\/example.com\/b.png 2x"/);
  assert.match(out, /action="\/p\/https:\/\/example.com\/search"/);
  assert.match(out, /"<a href='\/z'>"/, 'script content untouched');
  assert.match(out, /content="0; url=\/p\/https:\/\/example.com\/next"/);
});

test('rewriteHtml honours <base> and injects without head', () => {
  const out = rewriteHtml('<base href="https://cdn.test/root/"><img src="x.png">', BASE, { inject: '<i>' });
  assert.match(out, /^<i><base href="\/p\/https:\/\/cdn.test\/root\/">/);
  assert.match(out, /src="\/p\/https:\/\/cdn.test\/root\/x.png"/);
});

test('rewriteCss and srcset', () => {
  const fn = (u) => proxify(u, BASE);
  assert.equal(rewriteCss('@import "a.css"; x{y:url(data:image/png;base64,AA)}', fn),
    '@import "/p/https://example.com/dir/a.css"; x{y:url(data:image/png;base64,AA)}');
  assert.equal(rewriteSrcset('data:image/png;base64,A,B 1x,b.png 2x', fn),
    'data:image/png;base64,A,B 1x, /p/https://example.com/dir/b.png 2x');
});

test('shouldScopeScript only targets classic scripts using location', () => {
  assert.equal(shouldScopeScript('var x = location.pathname;'), true);
  assert.equal(shouldScopeScript('f(top, parent);'), true);
  assert.equal(shouldScopeScript('console.log("hi");'), false, 'no location ref');
  assert.equal(shouldScopeScript('import x from "y"; location.href;'), false, 'module');
  assert.equal(shouldScopeScript('export const a = location;'), false, 'module');
  assert.equal(shouldScopeScript('const m = await import("./x"); location;'), false, 'dynamic import');
});

test('rewriteHtml wraps eligible inline scripts only when scriptScope is on', () => {
  const html = `<script>a = location.pathname</script>
<script type="module">b = location.pathname</script>
<script src="/x.js"></script>
<script type="application/json">{"location":1}</script>
<script>plain()</script>`;
  const on = rewriteHtml(html, BASE, { scriptScope: true });
  assert.match(on, /<script>with\(window.__pxScope\|\|\{\}\)\{\na = location.pathname\n\}<\/script>/);
  assert.match(on, /<script type="module">b = location.pathname<\/script>/, 'module untouched');
  assert.match(on, /<script type="application\/json">\{"location":1\}<\/script>/, 'json untouched');
  assert.match(on, /<script>plain\(\)<\/script>/, 'no location ref untouched');
  const off = rewriteHtml(html, BASE, { scriptScope: false });
  assert.doesNotMatch(off, /__pxScope/);
});

test('CookieJar domain/path/expiry/httpOnly', () => {
  const jar = new CookieJar();
  const u = new URL('https://www.example.com/a/b');
  jar.setCookie('a=1; Path=/; Domain=example.com', u);
  jar.setCookie('b=2; HttpOnly', u);
  jar.setCookie('c=3; Domain=evil.com', u);
  jar.setCookie('d=4; Secure', u);
  assert.equal(jar.getCookieHeader(new URL('https://example.com/')), 'a=1');
  assert.equal(jar.getCookieHeader(new URL('https://www.example.com/a/x')), 'b=2; d=4; a=1');
  assert.equal(jar.getCookieHeader(new URL('http://www.example.com/a/x')), 'b=2; a=1');
  assert.equal(jar.getCookieHeader(u, { includeHttpOnly: false }), 'd=4; a=1');
  jar.setCookie('b=9', u, { fromScript: true });
  assert.match(jar.getCookieHeader(u), /b=2/);
  jar.setCookie('a=; Path=/; Domain=example.com; Max-Age=0', u);
  assert.doesNotMatch(jar.getCookieHeader(u), /a=/);
});
