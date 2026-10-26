// クラウド上のヘッドレス Chrome (Chromium) を AI に操作させる。
// ページを開くたびに、クリックや入力ができる要素へ番号を振って一覧にし、
// AI はその番号を使って操作する。

import path from 'node:path';

const SNAPSHOT_TEXT_CHARS = 4000;
const MAX_ELEMENTS = 150;

let browserPromise = null;
let context = null;
let page = null;
let lastScreenshot = null;

async function getPage() {
  if (page && !page.isClosed()) return page;
  if (!browserPromise) {
    browserPromise = import('playwright').then(({ chromium }) => chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }));
  }
  const browser = await browserPromise;
  if (!context) {
    context = await browser.newContext({
      locale: 'ja-JP',
      timezoneId: process.env.TZ || 'Asia/Tokyo',
      viewport: { width: 1280, height: 800 },
    });
    // 新しいタブで開かれたページは、そのタブに切り替えて追いかける
    context.on('page', (p) => { page = p; });
  }
  page = await context.newPage();
  return page;
}

// ページ内で実行: 見えている操作可能な要素に data-aid 番号を振る
function markElements(max) {
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=true]';
  document.querySelectorAll('[data-aid]').forEach((el) => el.removeAttribute('data-aid'));
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= max) break;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || st.visibility === 'hidden' || st.display === 'none') continue;
    const id = out.length + 1;
    el.setAttribute('data-aid', String(id));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const field = tag === 'input' || tag === 'textarea' || tag === 'select';
    const label = (el.getAttribute('aria-label') || (field ? el.getAttribute('placeholder') : el.innerText) ||
      el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || (field ? '' : el.value) || '')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
    let desc = `[${id}] ${tag}${type ? `[type=${type}]` : ''} "${label}"`;
    if (tag === 'a') desc += ` -> ${el.getAttribute('href').slice(0, 100)}`;
    if (field && el.value) desc += ` 値="${String(el.value).slice(0, 40)}"`;
    out.push(desc);
  }
  return out;
}

async function snapshot(p, note = '') {
  await p.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  await p.waitForTimeout(500);
  const [title, elements, text] = await Promise.all([
    p.title().catch(() => ''),
    p.evaluate(markElements, MAX_ELEMENTS).catch(() => []),
    p.evaluate(() => document.body?.innerText || '').catch(() => ''),
  ]);
  const body = text.replace(/\n{3,}/g, '\n\n').trim();
  return [
    note,
    `タイトル: ${title}`,
    `URL: ${p.url()}`,
    '',
    '## ページの文章',
    body.length > SNAPSHOT_TEXT_CHARS ? `${body.slice(0, SNAPSHOT_TEXT_CHARS)}\n…(続きは browser_read で)` : body,
    '',
    '## 操作できる要素 (番号で指定)',
    elements.join('\n') || '(なし)',
  ].join('\n').trim();
}

function locate(p, id) {
  return p.locator(`[data-aid="${Number(id)}"]`).first();
}

export async function open(url) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`; // example.com だけでも開けるように
  const p = await getPage();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return snapshot(p);
}

export async function click(id) {
  const p = await getPage();
  await locate(p, id).click({ timeout: 10_000 });
  await p.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  return snapshot(page, `[${id}] をクリックしました。`);
}

export async function type(id, text, submit = false) {
  const p = await getPage();
  const el = locate(p, id);
  await el.fill(text, { timeout: 10_000 });
  if (submit) await el.press('Enter');
  return snapshot(page, `[${id}] に入力しました${submit ? ' (Enter で送信)' : ''}。`);
}

export async function press(key) {
  const p = await getPage();
  await p.keyboard.press(key);
  return snapshot(page, `${key} キーを押しました。`);
}

export async function scroll(direction = 'down') {
  const p = await getPage();
  await p.mouse.wheel(0, direction === 'up' ? -700 : 700);
  return snapshot(p, `${direction === 'up' ? '上' : '下'}にスクロールしました。`);
}

export async function back() {
  const p = await getPage();
  await p.goBack({ timeout: 15_000 }).catch(() => {});
  return snapshot(p, '前のページに戻りました。');
}

export async function read(offset = 0) {
  const p = await getPage();
  const text = await p.evaluate(() => document.body?.innerText || '');
  const chunk = text.slice(offset, offset + 12_000);
  const rest = text.length - offset - chunk.length;
  return `URL: ${p.url()}\n(${offset}文字目から)\n\n${chunk}${rest > 0 ? `\n…(残り${rest}文字。offset=${offset + chunk.length} で続き)` : ''}`;
}

export async function screenshot(dir) {
  const p = await getPage();
  const file = path.join(dir, 'screenshot.png');
  await p.screenshot({ path: file });
  lastScreenshot = file;
  return `スクリーンショットを撮りました。画面に表示されています。URL: ${p.url()}`;
}

export function latestScreenshot() {
  return lastScreenshot;
}

export async function close() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  context = null;
  page = null;
  await b?.close().catch(() => {});
}
