import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// config.json があればそれを、なければ config.example.json を読む。
// CONFIG_JSON 環境変数に JSON をそのまま入れることもできる (Hugging Face の Secrets 用)
export function loadConfig() {
  let raw;
  if (process.env.CONFIG_JSON) raw = process.env.CONFIG_JSON;
  else {
    const file = [path.join(ROOT, 'config.json'), path.join(ROOT, 'config.example.json')].find((f) => fs.existsSync(f));
    raw = fs.readFileSync(file, 'utf8');
  }
  const config = JSON.parse(raw);
  config.maxSteps ??= 25;
  config.dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');
  config.workspace = path.resolve(ROOT, process.env.WORKSPACE_DIR || 'workspace');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.workspace, { recursive: true });
  return config;
}
