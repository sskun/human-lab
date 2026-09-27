#!/usr/bin/env node
// ASR 接口能力探测脚本（一次性，探测结论沉淀到 docs/asr-design.md 后可删）
// 探测目标：阿里云 MAAS 专属端点 + qwen-audio-3.1-asr-flash，验证：
//   1. 用户给的 curl 请求体结构（input_audio.data = URL）是否可用
//   2. 本地文件场景：base64 data URI / 裸 base64 是否可用（没有公网 URL / OSS 时的关键问题）
//   3. mp3 格式是否可直接识别（示例参数写的是 wav/16000，而我们 TTS 产物是 mp3/22050）
//   4. 响应结构：识别文本在哪个字段、耗时、有无 usage
//
// 用法：node lego/02-asr/probe-asr.mjs <audio文件> [用例序号...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 与 config.ts 的 loadDotEnv 等价（探测脚本独立运行，不依赖构建产物）
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
for (const line of fs.readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const ENDPOINT =
  process.env.DASHSCOPE_ASR_URL ||
  'https://llm-bp3e6hufsqhewhcr.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const MODEL = 'qwen-audio-3.1-asr-flash';
const KEY = process.env.DASHSCOPE_API_KEY;

const audioFile = process.argv[2] ?? path.join(repoRoot, 'output/lego-monorepo-test.mp3');
const only = process.argv[3] ? new Set(process.argv.slice(3).map(Number)) : null;
const audioBuf = fs.readFileSync(audioFile);
const b64 = audioBuf.toString('base64');
const dataUri = `data:audio/mpeg;base64,${b64}`;

console.error(`[probe] endpoint: ${ENDPOINT}`);
console.error(`[probe] model: ${MODEL}`);
console.error(`[probe] audio: ${audioFile} (${audioBuf.length} bytes, base64 ${b64.length} chars)`);

/** 每个用例构造一份请求体，返回 {name, body} */
const cases = [
  {
    name: 'A: 用户文档原样结构（input_audio.data=URL占位→base64 data URI）',
    body: {
      model: MODEL,
      input: {
        messages: [
          { role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] },
        ],
      },
      parameters: { format: 'mp3', sample_rate: '22050' },
    },
  },
  {
    name: 'B: input_audio.data=裸base64（无 data: 前缀）',
    body: {
      model: MODEL,
      input: {
        messages: [
          { role: 'user', content: [{ type: 'input_audio', input_audio: { data: b64 } }] },
        ],
      },
      parameters: { format: 'mp3', sample_rate: '22050' },
    },
  },
  {
    name: 'C: DashScope 原生多模态格式（type:audio + audio 字段, data URI）',
    body: {
      model: MODEL,
      input: {
        messages: [
          { role: 'user', content: [{ type: 'audio', audio: dataUri }] },
        ],
      },
      parameters: { format: 'mp3', sample_rate: '22050' },
    },
  },
  {
    name: 'D: OpenAI 风格 messages 顶层（input.messages）+ format 不传',
    body: {
      model: MODEL,
      input: {
        messages: [
          { role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] },
        ],
      },
    },
  },
];

for (const [i, c] of cases.entries()) {
  const n = i + 1;
  if (only && !only.has(n)) continue;
  const t0 = Date.now();
  let res, json;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'disable',
      },
      body: JSON.stringify(c.body),
      signal: AbortSignal.timeout(60_000),
    });
    json = await res.json().catch(() => null);
  } catch (e) {
    console.error(`\n=== 用例${n} ${c.name} ===`);
    console.error(`[probe] 网络错误: ${e.message}`);
    continue;
  }
  const ms = Date.now() - t0;
  console.error(`\n=== 用例${n} ${c.name} ===`);
  console.error(`[probe] HTTP ${res.status} in ${ms}ms`);
  console.log(JSON.stringify(json, null, 2));
}
