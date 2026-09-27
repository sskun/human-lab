#!/usr/bin/env node
// 乐高块 01（演示 CLI）：文本 → 语音
// 能力本体在 apps/server/src/capabilities/tts.ts，本文件只保留"可直接 node 运行"的演示入口。
// 注意：引用的是 server 构建产物 dist/，先跑 npm run build（或 npm install 时的 prepare）。
//
// 用法：
//   node lego/01-tts/tts-dashscope.mjs "今天天气怎么样？"
//   node lego/01-tts/tts-dashscope.mjs --voice longanlufeng --out output/demo.mp3 --text "你好。"
import { synthesizeSpeech, loadDotEnv, resolveTTSConfig } from '../../apps/server/dist/capabilities/tts.js';

loadDotEnv();
const base = resolveTTSConfig();

const args = process.argv.slice(2);
const get = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const text = get('text') ?? args.find((a) => !a.startsWith('--')) ?? '你好，我是你的专属数字人，很高兴认识你。';
const out = get('out') ?? 'output/tts-demo.mp3';
const config = {};
const voice = get('voice');
const model = get('model');
if (voice) config.voice = voice;
if (model) config.model = model;

console.error(`[tts] model=${config.model ?? base.model} voice=${config.voice ?? base.voice} format=${base.format}@${base.sampleRate}Hz`);
console.error(`[tts] text: ${text}`);

const started = Date.now();
let lastLogged = 0;
let received = 0;

const { bytes, usage, outFile } = await synthesizeSpeech(text, {
  out,
  config,
  onAudio: (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastLogged > 300) {
      lastLogged = now;
      process.stderr.write(`[tts] receiving... ${received} bytes\r`);
    }
  },
});

console.error(`\r[tts] done in ${((Date.now() - started) / 1000).toFixed(1)}s, ${bytes} bytes -> ${outFile}`);
if (usage) console.error(`[tts] usage: ${JSON.stringify(usage)}`);
console.log(outFile);
console.error(`[tts] 试听: afplay ${outFile}   (macOS)`);
