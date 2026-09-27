// 数字人后端入口：Express HTTP 服务
//
// 接口（与设计文档 §4.2 / docs/asr-design.md §4.4 一致）：
//   POST /api/speak        { text, voice? } → 202 { taskId }      受理合成任务（异步，轮询取结果）
//   POST /api/listen       { audioBase64, format? } → 200 { taskId, text, duration }
//                                                                 语音识别（同步，亚秒级返回）
//   GET  /api/tasks/:id    → TaskView { id, status, audioUrl?, text?, error? }
//   GET  /api/tasks        → TaskView[]（最近 20 条）
//
// 实时聊天（会话制）：
//   POST /api/chat/sessions            → 200 { session }             点击「开始聊天」
//   POST /api/chat/sessions/:id/turns  { text? | audioBase64?, format? }
//                                      → 200 { turn }                说一轮（ASR→LLM→TTS，同步）
//   POST /api/chat/sessions/:id/end    → 200 { session }             点击「结束聊天」
//   GET  /api/chat/sessions            → ChatSessionView[]           历史会话列表
//   GET  /api/chat/sessions/:id/turns  → ChatTurnView[]              会话的输入/输出明细
//
//   GET  /media/<file>     → 静态文件（output/ 目录下的 mp3/wav/mp4）
//
// 启动：npm run dev:server（tsx 热更新，端口 3001）
// web 端通过 vite 代理把 /api、/media 转发到这里，因此无需处理 CORS。
import express from 'express';
import { ListenRequest, ChatTurnRequest } from '@human-lab/shared';
import { OUTPUT_DIR } from './config.js';
import { createTask, createListenTask, getTaskView, listTaskViews } from './tasks.js';
import {
  ChatError,
  startChatSession,
  stopChatSession,
  runChatTurn,
  getChatSessionView,
  listChatSessionViews,
  listChatTurnViews,
} from './chat.js';

/** 单个音频的解码后大小上限（10MB；1 分钟 16kHz 单声道 wav 约 1.9MB，余量充足） */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const app = express();

// 解析 JSON 请求体。默认 100kb 上限装不下 base64 音频（约放大 4/3），放宽到 16MB，
// 音频本身的大小再由 /api/listen 内按解码后字节数精确限制（超限 413）。
app.use(express.json({ limit: '16mb' }));

// 把 output/ 目录挂载为静态资源：前端拿到的 audioUrl 是 /media/tts-xxx.mp3
app.use('/media', express.static(OUTPUT_DIR));

// 受理合成任务：校验参数 → 入库（queued）→ 后台执行 → 立即返回 taskId
app.post('/api/speak', (req, res) => {
  const { text, voice } = (req.body ?? {}) as { text?: string; voice?: string };
  if (!text || !text.trim()) {
    res.status(400).json({ error: 'text 不能为空' });
    return;
  }
  const taskId = createTask(text.trim(), voice);
  // 202 Accepted：任务已受理，结果通过 GET /api/tasks/:id 轮询获取
  res.status(202).json({ taskId });
});

// 语音识别（同步）：校验 base64 → 落库 → 归档录音 → 调 ASR 能力 → 返回文字
app.post('/api/listen', (req, res) => {
  const { audioBase64, format } = (req.body ?? {}) as ListenRequest;
  if (!audioBase64 || !audioBase64.trim()) {
    res.status(400).json({ error: 'audioBase64 不能为空' });
    return;
  }
  const clean = audioBase64.replace(/\s/g, '');
  // btoa 产出标准 base64；兼容 URL-safe 变体（-_）与省略的 padding
  if (!/^[A-Za-z0-9+/=_-]+$/.test(clean)) {
    res.status(400).json({ error: 'audioBase64 不是合法的 base64' });
    return;
  }
  const audio = Buffer.from(clean, 'base64');
  if (audio.length === 0) {
    res.status(400).json({ error: 'audioBase64 解码后为空' });
    return;
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    res.status(413).json({ error: `音频超过大小上限（${MAX_AUDIO_BYTES / 1024 / 1024}MB）` });
    return;
  }
  void createListenTask(audio, format)
    .then((outcome) => res.json(outcome))
    .catch((err: unknown) => {
      if (res.headersSent) return;
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `识别失败：${message}` });
    });
});

// 查询单个任务状态（web 端每秒轮询这个接口直到 done/failed）
app.get('/api/tasks/:id', (req, res) => {
  const view = getTaskView(req.params.id);
  if (!view) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  res.json(view);
});

// 最近任务列表
app.get('/api/tasks', (req, res) => {
  res.json(listTaskViews(20));
});

// ———— 实时聊天（会话制）————

// 点击「开始聊天」：创建会话
app.post('/api/chat/sessions', (req, res) => {
  res.status(201).json({ session: startChatSession() });
});

// 会话中说一轮：voice（audioBase64）或 text 二选一；同步执行 ASR→LLM→TTS 并返回轮次明细。
// 上游失败不抛 5xx——轮次已按 failed 落库，直接把失败的 turn 视图给前端展示（会话可继续）。
app.post('/api/chat/sessions/:id/turns', (req, res) => {
  const { text, audioBase64, format } = (req.body ?? {}) as ChatTurnRequest;
  if (!text?.trim() && !audioBase64?.trim()) {
    res.status(400).json({ error: '输入为空：请提供 text 或 audioBase64' });
    return;
  }
  const audio = audioBase64?.trim() ? Buffer.from(audioBase64.replace(/\s/g, ''), 'base64') : undefined;
  if (audio && audio.length === 0) {
    res.status(400).json({ error: 'audioBase64 解码后为空' });
    return;
  }
  if (audio && audio.length > MAX_AUDIO_BYTES) {
    res.status(413).json({ error: `音频超过大小上限（${MAX_AUDIO_BYTES / 1024 / 1024}MB）` });
    return;
  }
  void runChatTurn(req.params.id, { text: text?.trim() || undefined, audio, format })
    .then((turn) => res.json({ turn }))
    .catch((err: unknown) => {
      if (err instanceof ChatError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `聊天轮次执行失败：${message}` });
    });
});

// 点击「结束聊天」：关闭会话
app.post('/api/chat/sessions/:id/end', (req, res) => {
  const session = getChatSessionView(req.params.id);
  if (!session) {
    res.status(404).json({ error: '聊天会话不存在' });
    return;
  }
  const ended = stopChatSession(req.params.id)!;
  res.json({ session: ended });
});

// 历史会话列表
app.get('/api/chat/sessions', (req, res) => {
  res.json(listChatSessionViews(20));
});

// 某会话的输入/输出明细
app.get('/api/chat/sessions/:id/turns', (req, res) => {
  if (!getChatSessionView(req.params.id)) {
    res.status(404).json({ error: '聊天会话不存在' });
    return;
  }
  res.json(listChatTurnViews(req.params.id));
});

// 统一 404（未匹配的 /api 路径）
app.use((req, res) => {
  res.status(404).json({ error: `not found: ${req.method} ${req.path}` });
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] media dir: ${OUTPUT_DIR}`);
});
