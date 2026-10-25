// モデルの読み込みと文章の生成を、画面とは別のスレッドで行う。
// transformers.js が ONNX のモデルを WebGPU (なければ WebAssembly) で動かす。
import {
  env,
  pipeline,
  TextStreamer,
  InterruptableStoppingCriteria,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

let generator = null;
let loadedKey = null;
const stopping = new InterruptableStoppingCriteria();

async function pickDevice() {
  try {
    if (navigator.gpu && await navigator.gpu.requestAdapter()) return 'webgpu';
  } catch (e) { /* WebGPU が使えない */ }
  return 'wasm';
}

async function load({ model, dtype = 'q4', remoteHost }) {
  const key = [model, dtype, remoteHost].join('|');
  if (generator && loadedKey === key) {
    self.postMessage({ type: 'ready', model, device: generator.device, cached: true });
    return;
  }
  if (generator) { await generator.dispose(); generator = null; }
  if (remoteHost) {
    // Hugging Face 以外 (自分のサーバーなど) に置いたモデルを読む
    env.remoteHost = remoteHost;
    env.remotePathTemplate = '{model}/';
  }
  const device = await pickDevice();
  const files = new Map();
  generator = await pipeline('text-generation', model, {
    dtype,
    device,
    progress_callback: p => {
      if (p.status === 'progress' || p.status === 'done') {
        const f = files.get(p.file) || { loaded: 0, total: 0 };
        if (p.status === 'progress') { f.loaded = p.loaded; f.total = p.total; } else { f.loaded = f.total; }
        files.set(p.file, f);
        let loaded = 0, total = 0;
        for (const v of files.values()) { loaded += v.loaded; total += v.total; }
        self.postMessage({ type: 'progress', loaded, total, file: p.file });
      }
    },
  });
  generator.device = device;
  loadedKey = key;
  self.postMessage({ type: 'ready', model, device });
}

async function generate({ id, messages, temperature, maxTokens }) {
  stopping.reset();
  const t0 = performance.now();
  let n = 0;
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: text => { n++; self.postMessage({ type: 'token', id, text }); },
  });
  await generator(messages, {
    max_new_tokens: maxTokens,
    do_sample: temperature > 0,
    temperature: temperature > 0 ? temperature : undefined,
    top_p: 0.9,
    repetition_penalty: 1.05,
    streamer,
    stopping_criteria: stopping,
  });
  const secs = (performance.now() - t0) / 1000;
  self.postMessage({ type: 'done', id, tokensPerSec: n / secs });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load(data);
    else if (data.type === 'generate') await generate(data);
    else if (data.type === 'interrupt') stopping.interrupt();
  } catch (e) {
    self.postMessage({ type: 'error', id: data.id, message: String(e && e.message || e) });
  }
};
