const $ = (id) => document.getElementById(id);
const log = $('log');
let token = '';
try { token = localStorage.getItem('token') || ''; } catch { /* 保存できない環境 */ }

const TOOL_LABELS = {
  web_search: (a) => `🔍 検索: ${a.query}`,
  fetch_url: (a) => `📄 ページを読む: ${a.url}`,
  browser_open: (a) => `🌐 Chrome で開く: ${a.url}`,
  browser_click: (a) => `🖱 クリック: [${a.id}]`,
  browser_type: (a) => `⌨ 入力: [${a.id}] ${a.text}`,
  browser_press: (a) => `⌨ キー: ${a.key}`,
  browser_scroll: (a) => `↕ スクロール: ${a.direction || 'down'}`,
  browser_back: () => '← 戻る',
  browser_read: () => '📖 ページを読む',
  browser_screenshot: () => '📸 スクリーンショット',
  list_files: (a) => `📁 一覧: ${a.path || '.'}`,
  read_file: (a) => `📄 読む: ${a.path}`,
  write_file: (a) => `✏ 書く: ${a.path}`,
  edit_file: (a) => `✏ 書き換え: ${a.path}`,
  run_command: (a) => `▶ 実行: ${a.command}`,
  ask_ai: (a) => `🤝 ${a.role} に相談`,
  remember: (a) => `🧠 覚える: ${a.note}`,
};

function api(path, options = {}) {
  return fetch(path, { ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...options.headers } });
}

function scrollDown() {
  log.scrollTop = log.scrollHeight;
}

// ``` で囲まれたコードだけ整形し、残りはそのまま文字として表示する
function renderText(el, text) {
  text.split(/```[\w-]*\n?([\s\S]*?)```/g).forEach((part, i) => {
    if (i % 2) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part;
      pre.append(code);
      el.append(pre);
    } else if (part) {
      el.append(document.createTextNode(part));
    }
  });
}

function addMessage(kind, text, model) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  renderText(el, text);
  if (model) {
    const m = document.createElement('span');
    m.className = 'model';
    m.textContent = model;
    el.append(m);
  }
  log.append(el);
  scrollDown();
  return el;
}

function addTool(name, args) {
  const el = document.createElement('div');
  el.className = 'msg tool';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = (TOOL_LABELS[name] || ((a) => `${name} ${JSON.stringify(a)}`))(args || {});
  details.append(summary);
  el.append(details);
  log.append(el);
  scrollDown();
  return details;
}

function addScreenshot() {
  const el = document.createElement('div');
  el.className = 'msg ai';
  const img = document.createElement('img');
  img.src = `/api/screenshot?token=${encodeURIComponent(token)}&t=${Date.now()}`;
  img.alt = 'Chrome のスクリーンショット';
  img.onload = scrollDown;
  el.append(img);
  log.append(el);
}

const KEY_PAGES = {
  ANTHROPIC_API_KEY: ['Claude (有料・おすすめ)', 'https://console.anthropic.com/settings/keys'],
  GEMINI_API_KEY: ['Google Gemini (無料)', 'https://aistudio.google.com/apikey'],
  GROQ_API_KEY: ['Groq (無料)', 'https://console.groq.com/keys'],
  OPENROUTER_API_KEY: ['OpenRouter (無料)', 'https://openrouter.ai/keys'],
};

function settingsUrl(spaceId) {
  return spaceId ? `https://huggingface.co/spaces/${spaceId}/settings` : null;
}

function showSetup(data) {
  $('login').hidden = true;
  $('app').hidden = true;
  $('setup').hidden = false;
  const link = $('setup-link');
  const url = settingsUrl(data.spaceId);
  if (url) link.href = url;
  else link.removeAttribute('href');
}

// どの AI も使えないときに、キーの取り方と登録のしかたを出す
function showNoAi(state) {
  const banner = $('no-ai');
  banner.hidden = state.roles.main?.length > 0;
  if (banner.hidden) return;
  const { url, where: whereText, after } = state.secrets;
  const where = url ? `<a href="${url}" target="_blank" rel="noopener">${whereText}</a>` : whereText;
  const items = state.keys.map((k) => {
    const [label, page] = KEY_PAGES[k] || [k, null];
    return `<li>${page ? `<a href="${page}" target="_blank" rel="noopener">${label}</a>` : label} → Name: <code>${k}</code></li>`;
  }).join('');
  banner.innerHTML = `<b>AI のキーがまだありません。</b>どれか 1 つ取ってきて、${where}に登録してください。${after}。<ol>${items}</ol>`;
}

async function loadState() {
  const res = await api('/api/state');
  if (res.status === 503) return showSetup(await res.json());
  if (res.status === 401) return showLogin();
  const state = await res.json();
  $('login').hidden = true;
  $('app').hidden = false;
  showNoAi(state);
  const role = $('role');
  const current = role.value || 'main';
  role.replaceChildren(...Object.entries(state.roles).map(([name, chain]) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name}${chain.length ? '' : ' (使えるAIなし)'}`;
    opt.title = chain.join(' → ');
    return opt;
  }));
  role.value = current in state.roles ? current : 'main';
  log.replaceChildren();
  for (const item of state.history) {
    if (item.type === 'user') addMessage('user', item.text);
    else if (item.type === 'text') addMessage('ai', item.text);
    else if (item.type === 'tool') addTool(item.name, item.args);
  }
  if (!state.history.length) addMessage('ai', 'やっほー！ 話しかけてくれたら、雑談でも調べものでもコーディングでも手伝うよ。');
}

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
  const data = await res.json();
  if (!res.ok) {
    $('login-error').textContent = data.error;
    return;
  }
  token = data.token;
  try { localStorage.setItem('token', token); } catch { /* 保存できない環境 */ }
  loadState();
});

async function send(text) {
  addMessage('user', text);
  $('send').hidden = true;
  $('stop').hidden = false;
  const waiting = document.createElement('div');
  waiting.className = 'thinking';
  waiting.textContent = '考え中…';
  log.append(waiting);
  let lastTool = null;
  try {
    const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text, role: $('role').value }) });
    if (!res.ok) {
      addMessage('error', (await res.json()).error);
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'text') addMessage('ai', ev.text, ev.model);
        else if (ev.type === 'tool') lastTool = addTool(ev.name, ev.args);
        else if (ev.type === 'tool_result' && lastTool) {
          const pre = document.createElement('pre');
          pre.textContent = ev.preview;
          if (!ev.ok) lastTool.parentElement.classList.add('error');
          lastTool.append(pre);
        } else if (ev.type === 'screenshot') addScreenshot();
        else if (ev.type === 'error') addMessage('error', ev.text);
        log.append(waiting);
        scrollDown();
      }
    }
  } catch (err) {
    addMessage('error', `通信エラー: ${err.message}`);
  } finally {
    waiting.remove();
    $('send').hidden = false;
    $('stop').hidden = true;
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  send(text);
});

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('composer').requestSubmit();
});

$('stop').addEventListener('click', () => api('/api/stop', { method: 'POST' }));

$('reset').addEventListener('click', async () => {
  if (!confirm('会話を最初からやり直しますか？ (覚えたことは残ります)')) return;
  const res = await api('/api/reset', { method: 'POST' });
  if (!res.ok) addMessage('error', (await res.json()).error);
  else loadState();
});

loadState();
