#!/usr/bin/env node
// 乐高块 03（演示 CLI）：对话 → 回复（流式输出，思考过程与回答分色显示）
// 能力本体在 apps/server/src/capabilities/llm.ts，本文件只保留"可直接 node 运行"的演示入口。
// 注意：引用的是 server 构建产物 dist/，先跑 npm run build（或 npm install 时的 prepare）。
//
// 用法：
//   node lego/03-llm/llm-chat.mjs "用一句话介绍你自己"
//   node lego/03-llm/llm-chat.mjs --no-thinking "1+1等于几？只回答数字。"
//   node lego/03-llm/llm-chat.mjs --system "你是一个说话很短的海盗" "你是谁"
import { chat, loadDotEnv, resolveLLMConfig } from '../../apps/server/dist/capabilities/llm.js';

loadDotEnv();
const base = resolveLLMConfig();

const args = process.argv.slice(2);
const get = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);
const prompt = get('prompt') ?? args.find((a) => !a.startsWith('--'));
if (!prompt) {
  console.error('用法: node lego/03-llm/llm-chat.mjs [--no-thinking] [--system "提示词"] "问题"');
  process.exit(1);
}
const thinking = !has('no-thinking');
const system = get('system');

console.error(`[llm] model=${base.model} thinking=${thinking}`);

const started = Date.now();
let firstContentAt = 0;
const result = await chat(prompt, {
  thinking,
  ...(system && { system }),
  onReasoning: (d) => process.stdout.write(`\x1b[2m${d}\x1b[0m`), // 思考过程：暗色
  onContent: (d) => {
    if (!firstContentAt) {
      firstContentAt = Date.now();
      process.stdout.write('\n\x1b[1m=== 回答 ===\x1b[0m\n');
    }
    process.stdout.write(d);
  },
});

if (thinking && result.reasoning) console.log('\n\x1b[2m=== 思考结束 ===\x1b[0m');
console.log(`\n[llm] ${thinking ? `首字 ${(firstContentAt - started) / 1000}s, ` : ''}总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (result.usage) console.error(`[llm] usage: ${JSON.stringify(result.usage)}`);
