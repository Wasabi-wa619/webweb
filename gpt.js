// ちいさな GPT (文字単位) を TensorFlow.js で一から組み立てる。
// 重みの名前と形は colab/tiny_gpt.py と同じなので、Colab で学習した重みをそのまま読み込める。
// 行列はすべて「入力 @ W」の向き ([入力次元, 出力次元]) で持つ。

(function (global) {
  'use strict';
  const tf = global.tf;

  // ---------- 文字トークナイザ ----------
  class CharTokenizer {
    constructor(chars) {
      this.chars = chars;
      this.index = new Map(chars.map((c, i) => [c, i]));
    }
    static fromText(text) {
      return new CharTokenizer([...new Set(Array.from(text))].sort());
    }
    get size() { return this.chars.length; }
    // 語彙にない文字は捨てる
    encode(text) {
      const out = [];
      for (const c of Array.from(text)) {
        const i = this.index.get(c);
        if (i !== undefined) out.push(i);
      }
      return out;
    }
    decode(ids) { return ids.map(i => this.chars[i]).join(''); }
  }

  // ---------- モデル ----------
  // config: { vocabSize, nLayer, nHead, nEmbd, blockSize }
  function paramShapes(cfg) {
    const C = cfg.nEmbd, shapes = {
      wte: [cfg.vocabSize, C],
      wpe: [cfg.blockSize, C],
    };
    for (let i = 0; i < cfg.nLayer; i++) {
      const p = `h${i}.`;
      Object.assign(shapes, {
        [p + 'ln1_g']: [C], [p + 'ln1_b']: [C],
        [p + 'attn_w']: [C, 3 * C], [p + 'attn_b']: [3 * C],
        [p + 'proj_w']: [C, C], [p + 'proj_b']: [C],
        [p + 'ln2_g']: [C], [p + 'ln2_b']: [C],
        [p + 'fc_w']: [C, 4 * C], [p + 'fc_b']: [4 * C],
        [p + 'fc2_w']: [4 * C, C], [p + 'fc2_b']: [C],
      });
    }
    shapes.lnf_g = [C];
    shapes.lnf_b = [C];
    shapes.head_w = [C, cfg.vocabSize];
    return shapes;
  }

  class GPT {
    constructor(cfg, weights) {
      if (cfg.nEmbd % cfg.nHead !== 0) throw new Error('埋め込み次元はヘッド数で割り切れる必要があります');
      this.cfg = cfg;
      this.params = {};
      const shapes = paramShapes(cfg);
      // 残差に足し込む射影は層が深いほど小さく初期化する (GPT-2 と同じ)
      const residStd = 0.02 / Math.sqrt(2 * cfg.nLayer);
      for (const [name, shape] of Object.entries(shapes)) {
        let init;
        if (weights) {
          const w = weights[name];
          if (!w) throw new Error(`重み ${name} がありません`);
          init = tf.tensor(w, shape, 'float32');
        } else if (name.endsWith('_g')) {
          init = tf.ones(shape);
        } else if (name.endsWith('_b')) {
          init = tf.zeros(shape);
        } else {
          const std = /proj_w|fc2_w/.test(name) ? residStd : 0.02;
          init = tf.randomNormal(shape, 0, std);
        }
        // 名前は付けない (TF.js の変数名は全体で一意でないといけず、読み込み直しでぶつかる)
        this.params[name] = tf.variable(init, true);
      }
      // 未来の文字を見ないようにするマスク (上三角に大きな負の値)
      const T = cfg.blockSize;
      this.mask = tf.tidy(() =>
        tf.sub(1, tf.linalg.bandPart(tf.ones([T, T]), -1, 0)).mul(-1e9));
    }

    get numParams() {
      return Object.values(this.params).reduce((n, v) => n + v.size, 0);
    }

    // idx: int32 [B, T] → logits [B, T, vocab]
    forward(idx) {
      const p = this.params, { nLayer, nHead, nEmbd: C } = this.cfg;
      const [B, T] = idx.shape;
      const hs = C / nHead;

      const layerNorm = (x, g, b) => {
        const { mean, variance } = tf.moments(x, -1, true);
        return x.sub(mean).div(variance.add(1e-5).sqrt()).mul(g).add(b);
      };
      const linear = (x, w, b) => {
        const shape = x.shape;
        let y = x.reshape([-1, shape[shape.length - 1]]).matMul(w);
        if (b) y = y.add(b);
        return y.reshape([...shape.slice(0, -1), w.shape[1]]);
      };
      // GELU (tanh 近似。PyTorch の approximate='tanh' と同じ式)
      const gelu = x => x.mul(0.5).mul(
        tf.tanh(x.add(x.pow(3).mul(0.044715)).mul(Math.sqrt(2 / Math.PI))).add(1));

      const pos = tf.range(0, T, 1, 'int32');
      let x = tf.gather(p.wte, idx).add(tf.gather(p.wpe, pos));
      const mask = this.mask.slice([0, 0], [T, T]);

      for (let i = 0; i < nLayer; i++) {
        const l = n => p[`h${i}.${n}`];
        // --- 自己注意 ---
        const qkv = linear(layerNorm(x, l('ln1_g'), l('ln1_b')), l('attn_w'), l('attn_b'));
        const [q, k, v] = tf.split(qkv, 3, -1)
          .map(t => t.reshape([B, T, nHead, hs]).transpose([0, 2, 1, 3])); // [B, H, T, hs]
        let att = tf.matMul(q, k, false, true).mul(1 / Math.sqrt(hs)).add(mask);
        att = tf.softmax(att, -1);
        const y = tf.matMul(att, v).transpose([0, 2, 1, 3]).reshape([B, T, C]);
        x = x.add(linear(y, l('proj_w'), l('proj_b')));
        // --- MLP ---
        const h = gelu(linear(layerNorm(x, l('ln2_g'), l('ln2_b')), l('fc_w'), l('fc_b')));
        x = x.add(linear(h, l('fc2_w'), l('fc2_b')));
      }
      x = layerNorm(x, p.lnf_g, p.lnf_b);
      return linear(x, p.head_w);
    }

    // 平均クロスエントロピー (スカラー)
    loss(idx, targets) {
      const logits = this.forward(idx);
      const V = this.cfg.vocabSize;
      const logp = tf.logSoftmax(logits.reshape([-1, V]), -1);
      const picked = tf.mul(logp, tf.oneHot(targets.reshape([-1]), V)).sum(-1);
      return picked.mean().neg();
    }

    // 続きの 1 文字を選ぶ
    async sampleNext(ids, { temperature = 0.8, topK = 0 } = {}) {
      const ctx = ids.slice(-this.cfg.blockSize);
      const probs = tf.tidy(() => {
        const logits = this.forward(tf.tensor2d([ctx], [1, ctx.length], 'int32'));
        const last = logits.slice([0, ctx.length - 1, 0], [1, 1, -1]).reshape([-1]);
        return tf.softmax(last.div(Math.max(temperature, 1e-3)));
      });
      const p = await probs.data();
      probs.dispose();
      let order = Array.from(p.keys());
      if (topK > 0 && topK < p.length) {
        order.sort((a, b) => p[b] - p[a]);
        order = order.slice(0, topK);
      }
      let total = 0;
      for (const i of order) total += p[i];
      let r = Math.random() * total;
      for (const i of order) {
        r -= p[i];
        if (r <= 0) return i;
      }
      return order[order.length - 1];
    }

    exportWeights() {
      const out = {};
      for (const [name, v] of Object.entries(this.params)) out[name] = v.dataSync().slice();
      return out;
    }

    dispose() {
      Object.values(this.params).forEach(v => v.dispose());
      this.mask.dispose();
    }
  }

  // ---------- 学習データ ----------
  class Dataset {
    constructor(ids, blockSize, valFraction = 0.1) {
      const n = Math.floor(ids.length * (1 - valFraction));
      this.train = Int32Array.from(ids.slice(0, n));
      this.val = Int32Array.from(ids.slice(n));
      this.blockSize = blockSize;
    }
    // ランダムな位置から blockSize 文字を切り出し、1 文字ずらしたものを正解にする
    batch(split, B) {
      const data = split === 'val' && this.val.length > this.blockSize + 1 ? this.val : this.train;
      const T = Math.min(this.blockSize, data.length - 1);
      const x = new Int32Array(B * T), y = new Int32Array(B * T);
      for (let b = 0; b < B; b++) {
        const s = Math.floor(Math.random() * (data.length - T));
        x.set(data.subarray(s, s + T), b * T);
        y.set(data.subarray(s + 1, s + T + 1), b * T);
      }
      return { x: tf.tensor2d(x, [B, T], 'int32'), y: tf.tensor2d(y, [B, T], 'int32') };
    }
  }

  // ---------- 保存形式 (Colab と共通の JSON) ----------
  function f32ToBase64(arr) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function base64ToF32(b64) {
    const s = atob(b64), bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }
  function serialize(model, tokenizer) {
    const w = model.exportWeights(), weights = {};
    for (const [k, v] of Object.entries(w)) weights[k] = f32ToBase64(v);
    return { format: 'tiny-gpt-v1', config: model.cfg, vocab: tokenizer.chars, weights };
  }
  function deserialize(json) {
    if (json.format !== 'tiny-gpt-v1') throw new Error('tiny-gpt-v1 形式の JSON ではありません');
    const weights = {};
    for (const [k, v] of Object.entries(json.weights)) weights[k] = base64ToF32(v);
    const tokenizer = new CharTokenizer(json.vocab);
    return { model: new GPT(json.config, weights), tokenizer };
  }

  global.TinyGPT = { CharTokenizer, GPT, Dataset, serialize, deserialize };
})(typeof window !== 'undefined' ? window : globalThis);
