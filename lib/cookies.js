// プロキシ側で保持するクッキージャー (セッションごと)

function defaultPath(url) {
  const p = url.pathname;
  if (!p.startsWith('/')) return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

function pathMatch(reqPath, cookiePath) {
  if (reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/');
}

function domainMatch(host, cookie) {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith('.' + cookie.domain);
}

export class CookieJar {
  constructor(cookies = []) {
    this.cookies = Array.isArray(cookies) ? cookies : [];
  }

  /** 永続化用: 期限切れでない (セッションクッキー以外の) クッキーだけを返す */
  toJSON() {
    const now = Date.now();
    return this.cookies.filter((c) => c.expires !== null && c.expires > now);
  }

  /** Set-Cookie ヘッダー (または document.cookie への代入文字列) を保存する */
  setCookie(str, url, { fromScript = false } = {}) {
    const [pair, ...attrs] = String(str).split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return;

    const host = url.hostname.toLowerCase();
    const c = { name, value, domain: host, hostOnly: true, path: defaultPath(url), expires: null, secure: false, httpOnly: false };
    let maxAgeSet = false;

    for (const attr of attrs) {
      const i = attr.indexOf('=');
      const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const val = i < 0 ? '' : attr.slice(i + 1).trim();
      if (key === 'domain' && val) {
        const d = val.replace(/^\./, '').toLowerCase();
        if (host !== d && !host.endsWith('.' + d)) return;
        if (!d.includes('.') && d !== host) return;
        c.domain = d;
        c.hostOnly = false;
      } else if (key === 'path' && val.startsWith('/')) {
        c.path = val;
      } else if (key === 'expires' && !maxAgeSet) {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) c.expires = t;
      } else if (key === 'max-age') {
        const sec = parseInt(val, 10);
        if (!Number.isNaN(sec)) {
          c.expires = Date.now() + sec * 1000;
          maxAgeSet = true;
        }
      } else if (key === 'secure') {
        c.secure = true;
      } else if (key === 'httponly') {
        c.httpOnly = true;
      }
    }

    const same = (o) => o.name === c.name && o.domain === c.domain && o.path === c.path;
    if (fromScript) {
      if (c.httpOnly) return;
      if (this.cookies.some((o) => same(o) && o.httpOnly)) return;
    }
    this.cookies = this.cookies.filter((o) => !same(o));
    if (c.expires !== null && c.expires <= Date.now()) return; // 削除
    this.cookies.push(c);
  }

  getCookies(url, { includeHttpOnly = true } = {}) {
    const now = Date.now();
    this.cookies = this.cookies.filter((c) => c.expires === null || c.expires > now);
    const host = url.hostname.toLowerCase();
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    return this.cookies
      .filter((c) => domainMatch(host, c) && pathMatch(url.pathname || '/', c.path))
      .filter((c) => (!c.secure || secure) && (includeHttpOnly || !c.httpOnly))
      .sort((a, b) => b.path.length - a.path.length);
  }

  /** リクエストの Cookie ヘッダー用文字列 */
  getCookieHeader(url, opts) {
    return this.getCookies(url, opts)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
}
