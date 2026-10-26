// APIキーのいらないWeb検索 (DuckDuckGo の HTML 版) と、ページ本文の取得

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

export function parseDuckDuckGo(html) {
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<\/div>)/g;
  for (const m of html.matchAll(re)) {
    let url = decodeEntities(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // 広告
    results.push({ title: stripTags(m[2]), url, snippet: m[3] ? stripTags(m[3]) : '' });
  }
  return results;
}

export async function webSearch(query, { fetchImpl = fetch, max = 8 } = {}) {
  const res = await fetchImpl('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, 'accept-language': 'ja,en;q=0.8' },
    body: new URLSearchParams({ q: query, kl: 'jp-jp' }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`検索に失敗しました (HTTP ${res.status})`);
  const results = parseDuckDuckGo(await res.text()).slice(0, max);
  if (!results.length) return ''; // ロボット確認の画面などで取れなかった
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
}

export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<(script|style|noscript|svg|template|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return (title ? `# ${stripTags(title)}\n\n` : '') + text;
}

export async function fetchPage(url, { fetchImpl = fetch, maxChars = 15_000 } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('http(s) の URL を指定してください');
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, 'accept-language': 'ja,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  const type = res.headers.get('content-type') || '';
  const raw = await res.text();
  const text = /html/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : raw;
  const head = `URL: ${res.url}\nHTTP ${res.status}\n\n`;
  return head + (text.length > maxChars ? `${text.slice(0, maxChars)}\n…(以下省略。全${text.length}文字)` : text);
}
