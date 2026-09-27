#!/usr/bin/env node
// ASR 探测第二轮：长音频多句行为 + 错误场景
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
for (const line of fs.readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const ENDPOINT = 'https://llm-bp3e6hufsqhewhcr.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const MODEL = 'qwen-audio-3.1-asr-flash';

async function call(content, parameters, label) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' },
    body: JSON.stringify({ model: MODEL, input: { messages: [{ role: 'user', content }] }, ...(parameters ? { parameters } : {}) }),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json().catch(() => null);
  const ms = Date.now() - t0;
  console.error(`\n=== ${label} | HTTP ${res.status} in ${ms}ms ===`);
  const summarize = (d) => {
    if (!d) return;
    if (d.code) { console.error(`error: ${d.code}: ${d.message}`); return; }
    const s = d.sentence;
    const sArr = Array.isArray(s) ? s : s ? [s] : [];
    console.error(`text: ${JSON.stringify(d.text)}`);
    console.error(`sentence: ${Array.isArray(s) ? 'ARRAY' : 'OBJECT'} × ${sArr.length}`);
    for (const x of sArr) console.error(`  #${x.sentence_id} [${x.begin_time}-${x.end_time}] ${JSON.stringify(x.text)} end=${x.sentence_end} words=${x.words?.length ?? 0}`);
    console.error(`usage: ${JSON.stringify(d.usage)}`);
  };
  summarize(json);
  return json;
}

const mp3 = (f) => `data:audio/mpeg;base64,${fs.readFileSync(path.join(repoRoot, f)).toString('base64')}`;

// 1. 长音频：core-extract-test.mp3（74KB，约 10 秒以上，多句）
const longB64 = mp3('output/core-extract-test.mp3');
await call([{ type: 'input_audio', input_audio: { data: longB64 } }], { format: 'mp3', sample_rate: '22050' }, '长音频 core-extract-test.mp3');
// 2. 长音频：reorg-test.mp3（90KB）
const long2 = mp3('output/reorg-test.mp3');
await call([{ type: 'input_audio', input_audio: { data: long2 } }], { format: 'mp3', sample_rate: '22050' }, '长音频 reorg-test.mp3');
// 3. 错误场景：parameters.format 写 wav 但实际是 mp3
await call([{ type: 'input_audio', input_audio: { data: mp3('output/lego-monorepo-test.mp3') } }], { format: 'wav', sample_rate: '16000' }, '格式不匹配(format=wav 实为 mp3)');
// 4. 错误场景：伪造数据（data URI 前缀 + 乱码）
await call([{ type: 'input_audio', input_audio: { data: 'data:audio/mpeg;base64,AAAA' } }], { format: 'mp3', sample_rate: '22050' }, '伪造数据');
// 5. 错误场景：sample_rate 不匹配（写 16000，实际 22050）
await call([{ type: 'input_audio', input_audio: { data: mp3('output/lego-monorepo-test.mp3') } }, ], { format: 'mp3', sample_rate: '16000' }, 'sample_rate 不匹配(16000 实为 22050)');
// 6. 不传 sample_rate 只传 format
await call([{ type: 'input_audio', input_audio: { data: mp3('output/lego-monorepo-test.mp3') } }], { format: 'mp3' }, '只传 format 不传 sample_rate');
