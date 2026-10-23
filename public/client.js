// プロキシしたページに注入されるスクリプト。
// ページの JavaScript が発行するリクエストやDOM操作をフックし、URLをプロキシ経由に書き換える。
(() => {
  'use strict';
  if (window.__pxInstalled) return;
  window.__pxInstalled = true;

  const CFG = window.__PX || {};
  const PREFIX = '/p/';
  const ORIGIN = location.origin;
  const PROXIED_RE = /^\/p\/https?:\/*/i;
  const SKIP_RE = /^(?:#|javascript:|data:|blob:|about:|mailto:|tel:|sms:)/i;
  const baseURIGetter = Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI').get;

  // プロキシURL → 本来のURL
  function unproxy(u) {
    if (typeof u !== 'string') return u;
    let rest = null;
    if (u.startsWith(ORIGIN + PREFIX)) rest = u.slice(ORIGIN.length + PREFIX.length);
    else if (PROXIED_RE.test(u)) rest = u.slice(PREFIX.length);
    if (rest === null || !/^https?:\/*/i.test(rest)) return u;
    return rest.replace(/^(https?):\/*/i, '$1://');
  }

  function targetUrl() {
    try {
      const u = new URL(unproxy(location.href));
      if (u.origin !== ORIGIN) return u;
    } catch {}
    return new URL(CFG.url || 'about:blank');
  }

  function base() {
    const b = unproxy(baseURIGetter.call(document));
    return b && !b.startsWith(ORIGIN) ? b : targetUrl().href;
  }

  // 本来のURLへ解決 (プロキシのオリジンを指していたら対象サイトのオリジンに置き換える)
  function resolve(u) {
    const s = String(u).trim();
    if (s.startsWith(ORIGIN + PREFIX) || PROXIED_RE.test(s)) return new URL(unproxy(s.startsWith('/') ? ORIGIN + s : s));
    let abs = new URL(s, base());
    if (abs.origin === ORIGIN && !abs.pathname.startsWith('/__px/')) {
      abs = new URL(abs.pathname + abs.search + abs.hash, targetUrl().origin);
    }
    return abs;
  }

  // URL → プロキシ経由のパス
  function rw(u) {
    if (u == null) return u;
    if (typeof u === 'object' && !(u instanceof URL) && typeof u.toString !== 'function') return u;
    const s = String(u).trim();
    if (!s || SKIP_RE.test(s)) return u;
    let abs;
    try {
      abs = resolve(s);
    } catch {
      return u;
    }
    if (abs.origin === ORIGIN) return abs.href;
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
    return PREFIX + abs.href;
  }

  function rwSrcset(value) {
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
      if (url.endsWith(',')) url = url.replace(/,+$/, '');
      else {
        let k = j;
        while (k < s.length && s[k] !== ',') k++;
        desc = s.slice(j, k).trim();
        j = k;
      }
      i = j;
      out.push(rw(url) + (desc ? ' ' + desc : ''));
    }
    return out.join(', ');
  }

  const isRewritten = (v) => typeof v === 'string' && (PROXIED_RE.test(v) || v.startsWith(ORIGIN + PREFIX));
  const needsRewrite = (v) => typeof v === 'string' && (/^(?:https?:)?\/\//i.test(v.trim()) || /^\/(?!\/)/.test(v.trim())) && !isRewritten(v);

  // ---- ネットワーク API ----

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (input instanceof Request) {
        const nu = rw(input.url);
        if (nu !== input.url) input = new Request(nu, input);
      } else input = rw(input);
    } catch {}
    return _fetch.call(this, input, init);
  };

  const _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return _xhrOpen.call(this, method, rw(url), ...rest);
  };

  const hookGetter = (proto, prop, wrap) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    Object.defineProperty(proto, prop, {
      ...d,
      get() {
        return wrap(d.get.call(this), this);
      },
    });
  };
  hookGetter(XMLHttpRequest.prototype, 'responseURL', unproxy);
  hookGetter(window.Response && Response.prototype, 'url', unproxy);

  if (window.WebSocket) {
    const _WS = window.WebSocket;
    const toWs = (url) => {
      const abs = resolve(url);
      if (abs.protocol === 'http:') abs.protocol = 'ws:';
      if (abs.protocol === 'https:') abs.protocol = 'wss:';
      return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/__px/ws?url=${encodeURIComponent(abs.href)}&origin=${encodeURIComponent(targetUrl().origin)}`;
    };
    window.WebSocket = class WebSocket extends _WS {
      constructor(url, protocols) {
        super(toWs(url), protocols);
      }
    };
  }

  const wrapCtor = (name) => {
    const C = window[name];
    if (!C) return;
    window[name] = { [name]: class extends C {
      constructor(url, ...rest) {
        super(rw(url), ...rest);
      }
    } }[name];
  };
  wrapCtor('EventSource');
  wrapCtor('Worker');
  wrapCtor('SharedWorker');

  if (navigator.sendBeacon) {
    const _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => _beacon(rw(url), data);
  }

  // サービスワーカーはプロキシのオリジン全体に影響するので無効化
  if (navigator.serviceWorker) {
    try {
      navigator.serviceWorker.register = () => Promise.reject(new DOMException('Service workers are disabled by the proxy', 'SecurityError'));
    } catch {}
  }

  // ---- ストレージの分離 ----
  // すべてのサイトがプロキシと同じオリジンで動くため、localStorage / sessionStorage を
  // 対象サイトのオリジンごとに名前空間を分け、サイト間で混ざらないようにする。
  function isolateStorage(native, ns) {
    const pfx = '\u0000px\u0000' + ns + '\u0000';
    const keys = () => {
      const out = [];
      for (let i = 0; i < native.length; i++) {
        const k = native.key(i);
        if (k && k.startsWith(pfx)) out.push(k.slice(pfx.length));
      }
      return out;
    };
    const api = {
      getItem: (k) => native.getItem(pfx + k),
      setItem: (k, v) => native.setItem(pfx + k, String(v)),
      removeItem: (k) => native.removeItem(pfx + k),
      key: (i) => keys()[i] ?? null,
      clear: () => keys().forEach((k) => native.removeItem(pfx + k)),
      get length() {
        return keys().length;
      },
    };
    const reserved = (p) => p in api || typeof p === 'symbol';
    return new Proxy(api, {
      get: (t, p) => (reserved(p) ? (typeof t[p] === 'function' ? t[p].bind(t) : t[p]) : native.getItem(pfx + p) ?? undefined),
      set: (t, p, v) => (reserved(p) || native.setItem(pfx + p, String(v)), true),
      has: (t, p) => reserved(p) || native.getItem(pfx + p) !== null,
      deleteProperty: (t, p) => (reserved(p) || native.removeItem(pfx + p), true),
      ownKeys: () => keys(),
      getOwnPropertyDescriptor: (t, p) => {
        const v = typeof p === 'string' ? native.getItem(pfx + p) : null;
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      },
    });
  }
  try {
    const ns = targetUrl().origin || 'null';
    for (const name of ['localStorage', 'sessionStorage']) {
      let native;
      try {
        native = window[name];
      } catch {
        continue;
      }
      if (!native) continue;
      const iso = isolateStorage(native, ns);
      Object.defineProperty(window, name, { configurable: true, get: () => iso });
    }
  } catch {}

  // ---- ナビゲーション ----

  const _open = window.open;
  window.open = function (url, ...rest) {
    return _open.call(window, url == null || url === '' ? url : rw(url), ...rest);
  };

  for (const m of ['pushState', 'replaceState']) {
    const orig = History.prototype[m];
    History.prototype[m] = function (state, title, url) {
      return url == null ? orig.call(this, state, title) : orig.call(this, state, title, rw(url));
    };
  }

  // location.assign / replace は Location.prototype 上にあり差し替えられる
  for (const m of ['assign', 'replace']) {
    const orig = Location.prototype[m];
    if (!orig) continue;
    try {
      Location.prototype[m] = function (url) {
        return orig.call(this, rw(url));
      };
    } catch {}
  }

  // location.href = "..." はフックできないため Navigation API で横取りする (Chromium系)
  if (window.navigation && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('navigate', (e) => {
      try {
        if (!e.cancelable || e.destination.sameDocument || e.formData || e.downloadRequest) return;
        const dest = new URL(e.destination.url);
        if (!/^https?:$/.test(dest.protocol)) return;
        if (dest.origin === ORIGIN && (PROXIED_RE.test(dest.pathname) || dest.pathname.startsWith('/__px/'))) return;
        if (dest.origin === ORIGIN && dest.pathname === '/' && !dest.search && !dest.hash && e.navigationType !== 'push') return;
        e.preventDefault();
        location.assign(rw(dest.href));
      } catch {}
    });
  }

  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href], area[href]');
    if (!a) return;
    const href = _getAttr.call(a, 'href');
    if (needsRewrite(href)) _setAttr.call(a, 'href', rw(href));
  }, true);

  // ---- DOM ----

  const hookUrlProp = (Ctor, prop, srcset = false) => {
    const proto = Ctor && Ctor.prototype;
    const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get() {
        const v = d.get.call(this);
        return srcset ? v : unproxy(v);
      },
      set(v) {
        d.set.call(this, srcset ? rwSrcset(v) : rw(v));
      },
    });
  };
  const W = window;
  [
    [W.HTMLAnchorElement, 'href'], [W.HTMLAreaElement, 'href'], [W.HTMLLinkElement, 'href'], [W.HTMLBaseElement, 'href'],
    [W.HTMLImageElement, 'src'], [W.HTMLScriptElement, 'src'], [W.HTMLIFrameElement, 'src'], [W.HTMLFrameElement, 'src'],
    [W.HTMLEmbedElement, 'src'], [W.HTMLSourceElement, 'src'], [W.HTMLMediaElement, 'src'], [W.HTMLTrackElement, 'src'],
    [W.HTMLInputElement, 'src'], [W.HTMLFormElement, 'action'], [W.HTMLButtonElement, 'formAction'],
    [W.HTMLInputElement, 'formAction'], [W.HTMLVideoElement, 'poster'], [W.HTMLObjectElement, 'data'],
  ].forEach(([C, p]) => hookUrlProp(C, p));
  hookUrlProp(W.HTMLImageElement, 'srcset', true);
  hookUrlProp(W.HTMLSourceElement, 'srcset', true);

  const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background']);
  const _setAttr = Element.prototype.setAttribute;
  const _getAttr = Element.prototype.getAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const n = String(name).toLowerCase();
    if (URL_ATTRS.has(n) || (n === 'data' && this.tagName === 'OBJECT')) value = rw(value);
    else if (n === 'srcset' || n === 'imagesrcset') value = rwSrcset(value);
    else if (n === 'integrity') return;
    return _setAttr.call(this, name, value);
  };
  Element.prototype.getAttribute = function (name) {
    const v = _getAttr.call(this, name);
    return URL_ATTRS.has(String(name).toLowerCase()) ? unproxy(v) : v;
  };

  // innerHTML などで追加された要素の絶対URLを書き換える
  const fixElement = (el) => {
    for (const n of ['src', 'href', 'action', 'poster']) {
      const v = _getAttr.call(el, n);
      if (v && needsRewrite(v)) _setAttr.call(el, n, rw(v));
    }
    const ss = _getAttr.call(el, 'srcset');
    if (ss && !isRewritten(ss.trim())) _setAttr.call(el, 'srcset', rwSrcset(ss));
    if (el.hasAttribute('integrity')) el.removeAttribute('integrity');
  };
  const SELECTOR = '[src],[href],[action],[poster],[srcset],[integrity]';
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(SELECTOR)) fixElement(node);
        node.querySelectorAll(SELECTOR).forEach(fixElement);
      }
    }
  }).observe(document, { childList: true, subtree: true });

  // innerHTML 等は読み込みが始まる前に <template> 上で書き換える
  const htmlDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  const rewriteMarkup = (html) => {
    const s = String(html);
    if (!/\b(?:src|href|action|poster|srcset)\s*=/i.test(s)) return s;
    const t = document.createElement('template');
    htmlDesc.set.call(t, s);
    t.content.querySelectorAll(SELECTOR).forEach(fixElement);
    return htmlDesc.get.call(t);
  };
  for (const prop of ['innerHTML', 'outerHTML']) {
    const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (!d || !d.set) continue;
    Object.defineProperty(Element.prototype, prop, {
      ...d,
      set(v) {
        d.set.call(this, this instanceof HTMLScriptElement || this instanceof HTMLStyleElement ? v : rewriteMarkup(v));
      },
    });
  }
  const _insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (pos, html) {
    return _insertAdjacentHTML.call(this, pos, rewriteMarkup(html));
  };

  // ---- document のプロパティ ----

  hookGetter(Document.prototype, 'URL', unproxy);
  hookGetter(Document.prototype, 'documentURI', unproxy);
  hookGetter(Document.prototype, 'referrer', unproxy);
  hookGetter(window.MessageEvent && MessageEvent.prototype, 'origin', (o, ev) => {
    if (o !== ORIGIN) return o;
    try {
      return new URL(unproxy(ev.source.location.href)).origin;
    } catch {
      return targetUrl().origin;
    }
  });

  // postMessage の targetOrigin は本来のオリジンを指定してくるので "*" に置き換える
  const _postMessage = window.postMessage;
  window.postMessage = function (msg, opt, transfer) {
    if (typeof opt === 'string') {
      if (opt !== '/') opt = '*';
    } else if (opt && typeof opt === 'object' && !Array.isArray(opt) && opt.targetOrigin) {
      opt = { ...opt, targetOrigin: '*' };
    }
    return _postMessage.call(this, msg, opt, transfer);
  };

  // document.cookie はサーバー側のクッキージャーと同期する
  const cookieMap = new Map();
  String(CFG.cookies || '').split(/;\s*/).forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) cookieMap.set(p.slice(0, i), p.slice(i + 1));
  });
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      return [...cookieMap].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set(v) {
      const s = String(v);
      const [pair, ...attrs] = s.split(';');
      const i = pair.indexOf('=');
      if (i <= 0) return;
      const name = pair.slice(0, i).trim();
      let expired = false;
      for (const a of attrs) {
        const [k, val = ''] = a.split('=').map((x) => x.trim());
        const key = k.toLowerCase();
        if (key === 'max-age' && parseInt(val, 10) <= 0) expired = true;
        if (key === 'expires' && Date.parse(val) <= Date.now()) expired = true;
      }
      if (expired) cookieMap.delete(name);
      else cookieMap.set(name, pair.slice(i + 1).trim());
      try {
        _fetch('/__px/cookie', {
          method: 'POST',
          keepalive: true,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: targetUrl().href, cookie: s }),
        });
      } catch {}
    },
  });

  window.__px = { rw, unproxy, targetUrl };
})();
