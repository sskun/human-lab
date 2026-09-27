// 冒烟测试：TTS → ASR → LLM 三个能力各真实调用一次（需配置 DASHSCOPE_API_KEY）
// 运行：npm test（根目录，经 server 的 tsx 直接执行 TS，无需先构建）
import assert from 'node:assert';
import fs from 'node:fs';
import { synthesizeSpeech } from './capabilities/tts.js';
import { recognizeSpeech } from './capabilities/asr.js';
import { chat } from './capabilities/llm.js';

const { bytes, outFile } = await synthesizeSpeech('你好，世界');

assert.ok(bytes > 0, `合成音频为空（${bytes} bytes）`);
assert.ok(fs.existsSync(outFile), `文件未落盘: ${outFile}`);
console.log(`smoke tts ok: ${bytes} bytes -> ${outFile}`);

const asr = await recognizeSpeech(outFile);

assert.ok(asr.text.length > 0, '识别结果为空');
assert.ok(asr.usage?.duration, `usage.duration 缺失（计费口径异常）: ${JSON.stringify(asr.usage)}`);
console.log(`smoke asr ok: ${JSON.stringify(asr.text)} (${asr.usage?.duration}s)`);

const llm = await chat('只回复两个字：收到', { thinking: false });

assert.ok(llm.content.trim().length > 0, 'LLM 回复为空');
console.log(`smoke llm ok: ${llm.content.trim()}`);
