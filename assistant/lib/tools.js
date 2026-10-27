// AI が使える道具 (ツール) の定義と実行。
// ファイル操作とコマンド実行は「作業フォルダ (workspace)」の中だけに限る。

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { webSearch, fetchPage } from './web.js';
import * as browser from './browser.js';
import { chat } from './llm.js';

const MAX_RESULT_CHARS = 12_000;

function fn(name, description, properties = {}, required = Object.keys(properties)) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });

export const TOOL_DEFS = [
  fn('web_search', 'インターネットを検索して、タイトル・URL・要約の一覧を返す。最新の情報や知らないことを調べるときに使う。', { query: str('検索ワード') }),
  fn('fetch_url', 'URL のページを取得して本文のテキストを返す。検索結果の中身を読むときに使う。', { url: str('http(s) の URL') }),
  fn('browser_open', 'クラウド上の Chrome で URL を開き、ページの文章と操作できる要素の番号一覧を返す。ログインやボタン操作が必要なサイト、JavaScript で表示されるサイトに使う。', { url: str('開く URL') }),
  fn('browser_click', 'Chrome で、番号の要素をクリックする。', { id: int('browser_open などが返した要素の番号') }),
  fn('browser_type', 'Chrome で、番号の入力欄に文字を入力する。', { id: int('要素の番号'), text: str('入力する文字'), submit: bool('入力後に Enter を押すか') }, ['id', 'text']),
  fn('browser_press', 'Chrome でキーを押す (Enter, Tab, Escape, ArrowDown など)。', { key: str('キー名') }),
  fn('browser_scroll', 'Chrome でページをスクロールする。', { direction: { type: 'string', enum: ['up', 'down'] } }),
  fn('browser_back', 'Chrome で前のページに戻る。', {}),
  fn('browser_read', 'Chrome で開いているページの文章を長めに読む。', { offset: int('何文字目から読むか (最初は 0)') }, []),
  fn('browser_screenshot', 'Chrome の画面のスクリーンショットを撮って、ユーザーの画面に表示する。', {}),
  fn('list_files', '作業フォルダ内のファイルとフォルダの一覧を返す。', { path: str('作業フォルダからの相対パス (省略時は直下)') }, []),
  fn('read_file', '作業フォルダ内のテキストファイルを読む。', { path: str('作業フォルダからの相対パス') }),
  fn('write_file', '作業フォルダ内にファイルを作る (上書きする)。フォルダがなければ作る。', { path: str('作業フォルダからの相対パス'), content: str('ファイルの中身全体') }),
  fn('edit_file', 'ファイル内の文字列 old を new に置き換える。old はファイル内にちょうど1回だけ現れる必要がある。', { path: str('作業フォルダからの相対パス'), old: str('置き換える前の文字列'), new: str('置き換えた後の文字列') }),
  fn('run_command', '作業フォルダで Linux のシェルコマンドを実行し、出力を返す (例: python3 main.py, node app.js, ls, pip install --user ...)。2分で打ち切る。', { command: str('実行するコマンド') }),
  fn('ask_ai', '別の AI に質問して答えをもらう。難しいコードは "coder"、簡単で速さ重視の作業は "fast" に頼む。', { role: str('頼む相手 (設定の roles の名前。例: coder, fast)'), prompt: str('頼む内容。相手は会話の流れを知らないので、必要な情報をすべて書く') }),
  fn('remember', 'ユーザーについて覚えておくべきこと (好み・名前・予定など) を長期記憶に書き足す。', { note: str('覚えること (1行)') }),
];

export const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.function.name));

// モデルが返した引数を検査する。足りない・型が違うときはエラーにして AI にやり直させる
export function validateArgs(name, args) {
  const def = TOOL_DEFS.find((t) => t.function.name === name);
  if (!def) throw new Error(`知らないツールです: ${name}`);
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('引数は JSON オブジェクトで渡してください');
  const { properties, required } = def.function.parameters;
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) throw new Error(`引数 ${key} がありません`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec || value === undefined || value === null) continue;
    if (spec.type === 'integer' && !Number.isInteger(Number(value))) throw new Error(`引数 ${key} は整数にしてください`);
    if (spec.type === 'string' && typeof value !== 'string') throw new Error(`引数 ${key} は文字列にしてください`);
  }
  return args;
}

// 作業フォルダの外に出るパスを拒否する (.. やシンボリックリンクも含めて)
export async function resolveInWorkspace(workspace, rel = '.') {
  const root = await fs.realpath(workspace);
  const target = path.resolve(root, String(rel).replace(/^[/\\]+/, ''));
  let real = target;
  try {
    real = await fs.realpath(target);
  } catch {
    // まだ存在しないファイルは、存在する親フォルダで判定する
    let dir = path.dirname(target);
    for (;;) {
      try {
        real = path.join(await fs.realpath(dir), path.relative(dir, target));
        break;
      } catch {
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    }
  }
  const relative = path.relative(root, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('作業フォルダの外にはアクセスできません');
  }
  return real;
}

function runCommand(command, cwd, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, HOME: process.env.HOME || cwd } });
    let out = '';
    const onData = (d) => { if (out.length < 200_000) out += d; };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      out += '\n(2分たったので打ち切りました)';
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(`終了コード: ${code}\n${out}`);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`実行できませんでした: ${err.message}`);
    });
  });
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (!entries.length) return '(空です)';
  return entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .join('\n');
}

function truncate(text) {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(長いので省略。全${text.length}文字)` : text;
}

export async function runTool(name, args, ctx) {
  const { config, signal } = ctx;
  const ws = config.workspace;
  switch (name) {
    case 'web_search': {
      // DuckDuckGo がだめなときは、Chrome で Bing を開いて結果を読む
      const result = await webSearch(args.query).catch(() => '');
      return result || browser.open(`https://www.bing.com/search?q=${encodeURIComponent(args.query)}&setlang=ja`);
    }
    case 'fetch_url': return fetchPage(args.url);
    case 'browser_open': return browser.open(args.url);
    case 'browser_click': return browser.click(args.id);
    case 'browser_type': return browser.type(args.id, args.text, Boolean(args.submit));
    case 'browser_press': return browser.press(args.key);
    case 'browser_scroll': return browser.scroll(args.direction);
    case 'browser_back': return browser.back();
    case 'browser_read': return browser.read(Number(args.offset) || 0);
    case 'browser_screenshot': {
      const result = await browser.screenshot(config.dataDir);
      ctx.emit?.({ type: 'screenshot', at: Date.now() });
      return result;
    }
    case 'list_files': return listFiles(await resolveInWorkspace(ws, args.path || '.'));
    case 'read_file': return truncate(await fs.readFile(await resolveInWorkspace(ws, args.path), 'utf8'));
    case 'write_file': {
      const file = await resolveInWorkspace(ws, args.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, args.content);
      return `${args.path} に書き込みました (${args.content.length}文字)`;
    }
    case 'edit_file': {
      const file = await resolveInWorkspace(ws, args.path);
      const text = await fs.readFile(file, 'utf8');
      const count = text.split(args.old).length - 1;
      if (count !== 1) throw new Error(`old が ${count} 回見つかりました。ちょうど1回現れる文字列にしてください`);
      await fs.writeFile(file, text.replace(args.old, () => args.new));
      return `${args.path} を書き換えました`;
    }
    case 'run_command': return truncate(await runCommand(args.command, ws));
    case 'ask_ai': {
      const chain = config.roles[args.role];
      if (!chain) throw new Error(`その役割はありません。使えるもの: ${Object.keys(config.roles).join(', ')}`);
      const { message, used } = await chat(config, chain, { messages: [{ role: 'user', content: args.prompt }], role: args.role, signal });
      return `(${used} の回答)\n${message.content}`;
    }
    case 'remember': {
      const line = `- ${String(args.note).replace(/\s*\n\s*/g, ' ')}\n`;
      await fs.appendFile(path.join(config.dataDir, 'memory.md'), line);
      return '覚えました';
    }
    default: throw new Error(`知らないツールです: ${name}`);
  }
}
