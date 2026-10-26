// 会話の履歴を持ち、AI とツールのやり取りを繰り返す本体

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { chat } from './llm.js';
import { TOOL_DEFS, TOOL_NAMES, runTool, validateArgs } from './tools.js';

const HISTORY_SENT = 60; // AI に送る直近のメッセージ数

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

export function buildSystemPrompt(config) {
  const character = readIfExists(path.join(ROOT, 'character.md'));
  const memory = readIfExists(path.join(config.dataDir, 'memory.md'));
  const now = new Date().toLocaleString('ja-JP', { timeZone: process.env.TZ || 'Asia/Tokyo' });
  return [
    'あなたはユーザー専用のパーソナルAIアシスタントです。次のキャラクターになりきって話してください。',
    character,
    '## できること',
    '- web_search / fetch_url でインターネットを調べる。最新の情報や自信のないことは、答える前に調べる。調べたら出典の URL を添える。',
    '- browser_* でクラウド上の Chrome を操作する (サイトを開く、クリック、入力)。購入・送金・投稿・削除など取り消せない操作の前には、必ずユーザーに確認する。',
    '- 作業フォルダ (クラウド上) でファイルを読み書きし、run_command でコードを実行する。コードを書いたら実行して確かめる。',
    '- ask_ai で別の AI に相談する。',
    '- remember でユーザーについて覚える。',
    'ツールを使わずに済む雑談には、ツールを使わずにそのまま答える。',
    memory ? `## ユーザーについて覚えていること\n${memory}` : '',
    `## 現在の日時\n${now}`,
  ].filter(Boolean).join('\n\n');
}

// 送る履歴を直近だけに絞る。tool メッセージの途中から始まらないよう、user の発言から始める
export function recentHistory(messages, limit = HISTORY_SENT) {
  if (messages.length <= limit) return messages;
  let start = messages.length - limit;
  while (start < messages.length && messages[start].role !== 'user') start++;
  return messages.slice(start);
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new Error(`引数が JSON として読めませんでした: ${String(raw).slice(0, 200)}`);
  }
}

export class Conversation {
  constructor(config, id = 'main') {
    this.config = config;
    this.file = path.join(config.dataDir, `conversation-${id}.json`);
    this.messages = [];
    try {
      this.messages = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // 初回は空
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.messages));
  }

  reset() {
    this.messages = [];
    this.save();
  }

  // ユーザーの発言を受けて、AI が答え終わるまでツールを回す。
  // emit には画面に表示するための途中経過が届く
  async send(text, { role = 'main', emit = () => {}, signal } = {}) {
    const chain = this.config.roles[role] || this.config.roles.main;
    this.messages.push({ role: 'user', content: text });
    this.save();
    for (let step = 0; step < this.config.maxSteps; step++) {
      const { message, used } = await chat(this.config, chain, {
        messages: [{ role: 'system', content: buildSystemPrompt(this.config) }, ...recentHistory(this.messages)],
        tools: TOOL_DEFS,
        signal,
      });
      this.messages.push(message);
      this.save();
      if (message.content) emit({ type: 'text', text: message.content, model: used });
      if (!message.tool_calls?.length) return;

      for (const call of message.tool_calls) {
        const name = call.function.name;
        let result;
        let isError = false;
        try {
          // 中断されても、tool_calls には必ず結果を返しておく (返さないと次の会話でエラーになる)
          if (signal?.aborted) throw new Error('ユーザーが中断しました');
          if (!TOOL_NAMES.has(name)) throw new Error(`知らないツールです: ${name}`);
          const args = validateArgs(name, parseArgs(call.function.arguments));
          emit({ type: 'tool', name, args, model: used });
          result = String(await runTool(name, args, { config: this.config, signal, emit }));
        } catch (err) {
          isError = true;
          result = signal?.aborted ? 'エラー: ユーザーが中断しました' : `エラー: ${err.message}`;
        }
        emit({ type: 'tool_result', name, ok: !isError, preview: result.slice(0, 500) });
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      this.save();
      if (signal?.aborted) throw new Error('中断しました');
    }
    emit({ type: 'text', text: `(ツールを ${this.config.maxSteps} 回使ったので、いったん止めました。「続けて」と言えば再開します)` });
  }

  // 画面に表示する用に、履歴を見やすい形にする
  display() {
    const items = [];
    for (const m of this.messages) {
      if (m.role === 'user') items.push({ type: 'user', text: m.content });
      else if (m.role === 'assistant') {
        if (m.content) items.push({ type: 'text', text: m.content });
        for (const c of m.tool_calls || []) {
          let args = {};
          try { args = parseArgs(c.function.arguments); } catch { /* 表示用なので無視 */ }
          items.push({ type: 'tool', name: c.function.name, args });
        }
      }
    }
    return items;
  }
}
