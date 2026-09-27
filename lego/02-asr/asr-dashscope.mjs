#!/usr/bin/env node
// 乐高块 02（演示 CLI）：语音 → 文字
// 能力本体在 apps/server/src/capabilities/asr.ts，本文件只保留"可直接 node 运行"的演示入口。
// 注意：引用的是 server 构建产物 dist/，先跑 npm run build（或 npm install 时的 prepare）。
//
// 用法：
//   node lego/02-asr/asr-dashscope.mjs output/tts-xxx.mp3
//   node lego/02-asr/asr-dashscope.mjs --format mp3 https://example.com/audio.mp3
import fs from 'node:fs';
import { recognizeSpeech, loadDotEnv, resolveASRConfig } from '../../apps/server/dist/capabilities/asr.js';

loadDotEnv();
const base = resolveASRConfig();

const args = process.argv.slice(2);
const get = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = get('input') ?? args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('用法: node lego/02-asr/asr-dashscope.mjs <音频文件|URL>');
  process.exit(1);
}
const format = get('format');

console.error(`[asr] model=${base.model}`);
console.error(`[asr] input: ${input}`);

const started = Date.now();
const { text, usage, requestId } = await recognizeSpeech(input, { format });

console.error(`[asr] done in ${((Date.now() - started) / 1000).toFixed(1)}s, requestId=${requestId}`);
console.error(`[asr] usage: ${JSON.stringify(usage)}`);
console.log(text);
