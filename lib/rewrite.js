// サーバー側の URL / HTML / CSS 書き換え

export const PREFIX = '/p/';

// プロキシ済みパス (/p/http://... または /p/https://...) の判定
export const PROXIED_RE = /^\/p\/https?:\/*/i;

// 書き換え対象外のURL
const SKIP_RE = /^(?:#|javascript:|data:|blob:|about:|mailto:|tel:|sms:|chrome:|file:)/i;

/** URL を base で解決し、プロキシ経由のパスへ変換する */
export function proxify(url, base) {
  if (url == null) return url;
  const raw = String(url).trim();
  if (!raw || SKIP_RE.test(raw)) return url;
  let abs;
  try {
    abs = new URL(raw, base);
  } catch {
    return url;
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return url;
  return PREFIX + abs.href;
}

/** "/p/https://example.com/a?b" から対象URLを取り出す */
export function decodeTarget(pathAndQuery) {
  if (!pathAndQuery.startsWith(PREFIX)) return null;
  let rest = pathAndQuery.slice(PREFIX.length);
  // 途中で "//" が "/" に潰されても復元する
  rest = rest.replace(/^(https?):\/*/i, '$1://');
  if (!/^https?:\/\//i.test(rest)) rest = 'https://' + rest;
  try {
    const u = new URL(rest);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** 完全なプロキシURL (http://proxy/p/https://...) から対象URLを取り出す */
export function unproxyUrl(full) {
  try {
    const u = new URL(full);
    if (!PROXIED_RE.test(u.pathname)) return null;
    return decodeTarget(u.pathname + u.search);
  } catch {
    return null;
  }
}

/** srcset 属性の各URLを書き換える (data: URL 内のカンマにも対応) */
export function rewriteSrcset(value, fn) {
  const s = String(value);
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    let desc = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      let k = j;
      while (k < s.length && s[k] !== ',') k++;
      desc = s.slice(j, k).trim();
      j = k;
    }
    i = j;
    out.push(fn(url) + (desc ? ' ' + desc : ''));
  }
  return out.join(', ');
}

/** CSS 内の url(...) と @import を書き換える */
export function rewriteCss(css, fn) {
  return css
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi, (m, a, b, c) => {
      const u = a ?? b ?? c ?? '';
      const r = fn(u);
      return r === u ? m : `url("${String(r).replace(/"/g, '%22')}")`;
    })
    .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/gi, (m, a, b) => {
      const u = a ?? b;
      const r = fn(u);
      return r === u ? m : `@import "${r}"`;
    });
}

// クラシックな (モジュールでない) JavaScript で、location / top / parent を参照し、
// かつ import/export を含まないものだけを with スコープで包む対象とする。
const SCOPE_REF_RE = /\b(?:location|top|parent)\b/;
const MODULE_RE = /(?:^|[;\n])\s*(?:import|export)[\s{*('"]/;

export function shouldScopeScript(code) {
  return SCOPE_REF_RE.test(code) && !MODULE_RE.test(code) && !/\bimport\s*\(/.test(code);
}

const CLASSIC_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'application/ecmascript',
  'text/ecmascript', 'text/jscript']);

/** <script> の開始タグが「インラインのクラシックスクリプト」か判定する */
function isClassicInlineScript(openTag) {
  if (/\ssrc\s*=/i.test(openTag)) return false; // 外部スクリプト
  const m = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openTag);
  const type = (m ? (m[1] ?? m[2] ?? m[3]) : '').trim().toLowerCase().split(';')[0];
  if (type === 'module') return false; // モジュールは with で包めない
  return CLASSIC_TYPES.has(type);
}

/** スクリプト本文を with(window.__pxScope){...} で包む (裸の location 等の読み取りを補正) */
export function wrapScript(code) {
  return 'with(window.__pxScope||{}){\n' + code + '\n}';
}

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);?/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'xlink:href']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);
const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function rewriteTag(tag, name, nameLen, ctx) {
  const end = tag.endsWith('/>') ? '/>' : tag.endsWith('>') ? '>' : '';
  const inner = tag.slice(nameLen, tag.length - end.length);

  const attrs = [];
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(inner))) {
    const value = m[2] ?? m[3] ?? m[4];
    attrs.push({
      name: m[1].toLowerCase(),
      value: value === undefined ? undefined : decodeEntities(value),
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
    });
  }
  const get = (n) => attrs.find((a) => a.name === n)?.value;

  if (name === 'meta') {
    const equiv = (get('http-equiv') || '').toLowerCase();
    if (equiv === 'content-security-policy' || equiv === 'content-security-policy-report-only') return '';
  }
  // <base href> は以降の相対URL解決の基準になる
  if (name === 'base') {
    const href = get('href');
    if (href) {
      try {
        ctx.base = new URL(href, ctx.base).href;
      } catch {}
    }
  }

  const fn = (u) => proxify(u, ctx.base);
  let changed = false;
  for (const a of attrs) {
    let nv = a.value;
    if (a.name === 'integrity' || a.name === 'ping') {
      nv = null; // 削除
    } else if (a.value === undefined) {
      continue;
    } else if (URL_ATTRS.has(a.name) || (a.name === 'data' && name === 'object')) {
      nv = fn(a.value);
    } else if (a.name === 'srcset' || a.name === 'imagesrcset') {
      nv = rewriteSrcset(a.value, fn);
    } else if (a.name === 'style') {
      nv = rewriteCss(a.value, fn);
    } else if (a.name === 'content' && name === 'meta' && /refresh/i.test(get('http-equiv') || '')) {
      nv = a.value.replace(/^(\s*\d*\.?\d*\s*[;,]\s*url\s*=\s*)(['"]?)(.*?)\2\s*$/i, (_, p, q, u) => p + fn(u));
    }
    if (nv !== a.value) {
      a.raw = nv === null ? '' : `${a.raw.slice(0, a.raw.indexOf('=') >= 0 ? a.raw.indexOf('=') : a.raw.length).trimEnd()}="${escapeAttr(nv)}"`;
      changed = true;
    }
  }
  if (!changed) return tag;

  let out = '';
  let pos = 0;
  for (const a of attrs) {
    out += inner.slice(pos, a.start) + a.raw;
    pos = a.end;
  }
  out += inner.slice(pos);
  return tag.slice(0, nameLen) + out + end;
}

/**
 * HTML を書き換える。
 * - URL属性をプロキシ経由に変換
 * - <style> / style属性の CSS を書き換え
 * - CSP の meta と integrity 属性を除去
 * - opts.inject を <head> の先頭に挿入 (クライアント側フック用)
 */
export function rewriteHtml(html, pageUrl, opts = {}) {
  const ctx = { base: pageUrl };
  const inject = opts.inject || '';
  let injected = !inject;
  let out = '';
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      const stop = e === -1 ? n : e + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const e = html.indexOf('>', lt);
      const stop = e === -1 ? n : e + 1;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }

    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 100));
    if (!m) {
      out += '<';
      i = lt + 1;
      continue;
    }

    // 引用符を考慮してタグの終端を探す
    let j = lt + m[0].length;
    let q = null;
    for (; j < n; j++) {
      const c = html[j];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
    }
    const tagEnd = Math.min(j + 1, n);
    const name = m[2].toLowerCase();
    const closing = m[1] === '/';
    let tag = html.slice(lt, tagEnd);

    if (!closing) {
      tag = rewriteTag(tag, name, m[0].length, ctx);
      if (!injected && name !== 'html') {
        if (name === 'head') tag += inject;
        else tag = inject + tag;
        injected = true;
      }
    }
    out += tag;
    i = tagEnd;

    // script や style の中身はタグとして解釈しない
    if (!closing && RAW_TEXT.has(name)) {
      const closeRe = new RegExp('</' + name + '[\\s/>]', 'ig');
      closeRe.lastIndex = i;
      const close = closeRe.exec(html);
      const stop = close ? close.index : n;
      const content = html.slice(i, stop);
      if (name === 'style') {
        out += rewriteCss(content, (u) => proxify(u, ctx.base));
      } else if (name === 'script' && opts.scriptScope && isClassicInlineScript(tag) && shouldScopeScript(content)) {
        out += wrapScript(content);
      } else {
        out += content;
      }
      i = stop;
    }
  }

  if (!injected) out += inject;
  return out;
}
