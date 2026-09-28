#!/usr/bin/env node
// 乐高块 04（探测 + 演示 CLI）：口播稿 → TTS → 形象图+音频 → wan3.0-video-prime → 口播 mp4
// 能力本体在 apps/server/src/capabilities/{lipsync,upload,tts,asr}.ts，本文件分步编排并打印
// docs/lipsync-design.md §3.5 探测清单（P1~P5）的实测证据。
// 注意：引用 server 构建产物 dist/，先跑 npm run build（或 npm run talk 自动构建）。
//
// 用法：
//   npm run talk                                   # 默认口播稿 + 默认形象
//   node lego/04-lipsync/talk-probe.mjs --text "你好" --image assets/avatars/default/image.png --out output/probe.mp4
import fs from 'node:fs';
import path from 'node:path';
import {
  synthesizeSpeech,
  loadDotEnv,
  resolveTTSConfig,
} from '../../apps/server/dist/capabilities/tts.js';
import { recognizeSpeech } from '../../apps/server/dist/capabilities/asr.js';
import {
  getUploadPolicy,
  uploadToTempStore,
} from '../../apps/server/dist/capabilities/upload.js';
import {
  WanTalkVideo,
  buildTalkPrompt,
  resolveTalkConfig,
} from '../../apps/server/dist/capabilities/lipsync.js';

loadDotEnv();

const args = process.argv.slice(2);
const get = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const cfg = resolveTalkConfig();
const ttsCfg = resolveTTSConfig();
const image = get('image') ?? path.join(cfg.avatarDir, cfg.avatarId, 'image.png');
const text = get('text') ?? '大家好，我是你的好物推荐官。今天带来一款随身咖啡杯，保温十二小时，通勤也能喝上热咖啡，喜欢的宝子不要错过。';
const out = get('out') ?? `output/talking-probe-${Date.now()}.mp4`;
const pollMs = Number(get('poll') ?? 5000); // 探测用 5s 间隔拿更细的状态迁移数据（查询 RPS 20 充裕）

const step = (n, msg) => console.log(`\n===== [${n}] ${msg}`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

console.log(`[probe] 模型=${cfg.model} 分辨率=${cfg.resolution} 画幅=${cfg.ratio} duration=${cfg.duration}`);
console.log(`[probe] 形象图: ${image}`);
console.log(`[probe] 口播稿(${text.length}字): ${text}`);

// —— [0] 形象图检查（wan3.0 reference_image 限制：单边 [240,8000]px，≤20MB）——
step(0, '形象资产检查');
if (!fs.existsSync(image)) {
  console.error(`✗ 形象图不存在：${image}（请放置 assets/avatars/default/image.png）`);
  process.exit(1);
}
const imgStat = fs.statSync(image);
console.log(`✓ 形象图 ${(imgStat.size / 1024 / 1024).toFixed(2)}MB`);
if (imgStat.size > 20 * 1024 * 1024) {
  console.error('✗ 图片超过 20MB 上限');
  process.exit(1);
}

// —— [1] TTS 合成口播音频 ——
step(1, 'TTS 合成口播音频');
const t1 = Date.now();
const tts = await synthesizeSpeech(text, { config: {} });
console.log(`✓ ${seconds(Date.now() - t1)} 合成 ${tts.bytes}B -> ${tts.outFile}（voice=${ttsCfg.voice}）`);

// —— [2] ASR 实测音频时长（P4 标定：字数 ↔ 秒数换算依据）——
step(2, 'ASR 实测音频时长（P4）');
const t2 = Date.now();
const asr = await recognizeSpeech(tts.outFile);
const audioSec = asr.usage?.duration ?? null;
console.log(`✓ ${seconds(Date.now() - t2)} 识别 "${asr.text.slice(0, 24)}…"`);
console.log(`✓ 音频时长 = ${audioSec}s（usage.duration 计费口径）→ ${text.length} 字 ≈ ${(text.length / audioSec).toFixed(1)} 字/秒`);
if (audioSec !== null && audioSec >= 15) {
  console.error('✗ 音频已达/超过 15s 参考音频上限，请缩短口播稿后重试');
  process.exit(1);
}

// —— [3] 上传通道（P2）——
step(3, '百炼临时上传通道（P2）');
const t3 = Date.now();
const policy = await getUploadPolicy({ model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.uploadsBaseUrl });
console.log(`✓ getPolicy ${seconds(Date.now() - t3)}：upload_host=${policy.uploadHost}`);
console.log(`  upload_dir=${policy.uploadDir} acl=${policy.xOssObjectAcl} 有效期=${policy.expireInSeconds ?? '?'}s`);
const t3b = Date.now();
const imageUrl = await uploadToTempStore(fs.readFileSync(image), path.basename(image), { policy });
const audioUrl = await uploadToTempStore(fs.readFileSync(tts.outFile), path.basename(tts.outFile), { policy });
console.log(`✓ 上传完成 ${seconds(Date.now() - t3b)}：`);
console.log(`  image_url = ${imageUrl}`);
console.log(`  audio_url = ${audioUrl}`);

// —— [4] 创建 wan3.0 任务（P1）——
step(4, '创建 wan3.0-video-prime 任务（P1）');
const client = new WanTalkVideo(cfg, { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
const t4 = Date.now();
const { taskId } = await client.createTask({ imageUrl, audioUrl });
console.log(`✓ ${seconds(Date.now() - t4)} 受理成功 task_id=${taskId}`);
console.log(`  prompt: ${buildTalkPrompt().slice(0, 60)}…`);

// —— [5] 轮询至终态（P5：各状态停留时间）——
step(5, '轮询任务状态（P5）');
const t5 = Date.now();
let last = '';
for (;;) {
  const st = await client.pollTask(taskId);
  const line = `${seconds(Date.now() - t5)} ${st.status}${st.videoUrl ? ' video_url=有' : ''}`;
  if (line !== last) {
    console.log(`  ${line}`);
    last = line;
  }
  if (st.status === 'SUCCEEDED') {
    console.log(`✓ 生成完成：usage=${JSON.stringify(st.usage)}`);
    break;
  }
  if (st.status === 'FAILED' || st.status === 'CANCELED' || st.status === 'UNKNOWN') {
    console.error(`✗ 任务终态 ${st.status}，退出`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
const elapsedSec = (Date.now() - t5) / 1000;

// —— [6] 下载转存（P4：视频时长 vs 音频时长）——
step(6, '下载转存');
const st = await client.pollTask(taskId);
const res = await fetch(st.videoUrl);
if (!res.ok) {
  console.error(`✗ 视频下载失败 HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, buf);
console.log(`✓ ${seconds(Date.now() - t5)}（任务受理→完成 ${elapsedSec.toFixed(1)}s）`);
console.log(`✓ 视频 ${(buf.length / 1024 / 1024).toFixed(2)}MB -> ${out}`);
const videoSec = st.usage?.duration ?? null;
console.log('\n===== 探测小结 =====');
console.log(`P1 模型可用性：✓（task_id=${taskId}）`);
console.log(`P2 上传通道：✓（oss:// 临时 URL 被 wan3.0 接受）`);
console.log(`P3 口播效果：待人工确认（播放 ${out} 核对口型同步/音色/形象一致性）`);
console.log(`P4 时长对齐：口播稿 ${text.length} 字 → 音频 ${audioSec}s → 视频 ${videoSec}s（差值 ${(videoSec - audioSec).toFixed(1)}s）`);
console.log(`P5 生成耗时：${elapsedSec.toFixed(1)}s（轮询间隔 ${pollMs / 1000}s）`);
console.log('（请把以上结论回填 docs/lipsync-design.md §3.6）');
