# human-lab

数字人 demo：输入一段文字 → 数字人对口型朗读并播放。
标准 monorepo 结构（`apps/*` 应用 + `packages/*` 共享包），设计文档见 [docs/design.md](docs/design.md)。

## 项目结构

```
human-lab/
├─ apps/
│  ├─ server/             # 后端：Express + TypeScript（端口 3001）
│  │  └─ src/
│  │     ├─ index.ts      # HTTP 入口：/api/speak、/api/listen、/api/chat/*、/api/tasks、/media
│  │     ├─ tasks.ts      # 任务编排：受理 → 执行（TTS 异步 / ASR 同步）→ 状态回写
│  │     ├─ chat.ts       # 实时聊天编排：会话制，每轮 ASR→LLM(带上下文)→TTS，明细落库
│  │     ├─ capabilities/
│  │     │  ├─ tts.ts     # TTS 能力（DashScope tts_v2 WebSocket 协议）
│  │     │  ├─ asr.ts     # ASR 能力（qwen-audio-3.1-asr-flash，multimodal-generation HTTP 协议）
│  │     │  └─ llm.ts     # LLM 能力（OpenAI 兼容 chat/completions，流式 SSE，实时聊天备料）
│  │     ├─ db.ts         # SQLite 任务存储（Node 内置 node:sqlite，零依赖）
│  │     └─ config.ts     # 配置：环境变量 > .env > 默认值；OUTPUT_DIR/DATA_DIR
│  └─ web/                # 前端：Vite + React + TypeScript（端口 5173）
│     └─ src/
│        ├─ App.tsx       # 外壳：💬实时聊天 / 🔊朗读 双页签
│        ├─ ChatPanel.tsx # 聊天面板：免按键连续对话（VAD 断句）、气泡、历史明细
│        ├─ SpeakPanel.tsx# 朗读面板：文本框/按住说话 → 合成 → 播放
│        ├─ recorder.ts   # 浏览器录音：Web Audio 采集 → 重采样 16k → WAV → base64
│        └─ main.tsx
├─ packages/
│  └─ shared/             # @human-lab/shared：server/web 共享的 API 契约（纯类型，零运行时依赖）
│     └─ src/types.ts     # TaskStatus / TaskView / SpeakRequest / ListenRequest / ...
├─ lego/                  # 各能力的"可直接 node 运行"演示块
├─ data/                  # SQLite 数据库（data/human-lab.db）
├─ output/                # 生成的语音/归档录音/口型视频（统一落这里）
├─ docs/design.md         # 总设计文档；docs/asr-design.md 语音识别设计（含接口探测结论）
└─ .env                   # 密钥与配置（gitignore，勿提交）
```

**分层依据**：`shared` 按行业惯例只放"两边都要认的类型契约"；TTS 能力和 db 的消费方目前只有 server（web 走 HTTP），因此内聚在 `apps/server/src`——能力归 `capabilities/`，存储归 `db.ts`。未来若出现第二个服务端消费方（如独立合成 worker），再抽成 `packages/core`。

## 快速开始

```bash
npm install                # 安装所有 workspace 依赖（prepare 自动构建 shared）
npm run dev:server         # 终端1：后端 http://localhost:3001
npm run dev:web            # 终端2：前端 http://localhost:5173（/api、/media 自动代理到 3001）
```

其他命令：

```bash
npm run build              # 构建 shared + server（tsc）
npm test                   # 冒烟测试（真实调用：TTS 合成 → ASR 识别 → LLM 对话各一次）
npm run tts                # 乐高块01 CLI：命令行直接合成语音
npm run asr                # 乐高块02 CLI：命令行识别音频文件/URL → 文字
npm run llm                # 乐高块03 CLI：命令行对话（流式输出，--no-thinking 关思考）
```

## 数据流

```
web(App.tsx) ──POST /api/speak──▶ server ──▶ SQLite(queued)
     │                              │ 后台执行
     │                              ▼
     │                  server/capabilities/tts.ts ──▶ output/tts-<taskId>.mp3
     │                              │ 状态回写 done
     ├──GET /api/tasks/:id──▶ SQLite ──▶ { status:'done', audioUrl:'/media/tts-xxx.mp3' }
     └──────GET /media/tts-xxx.mp3──▶ <audio controls> 播放

web(按住说话) ── 录音 wav/16k base64 ──POST /api/listen──▶ server（同步）
                              server/capabilities/asr.ts ──▶ qwen-audio-3.1-asr-flash
                           ◀── { taskId, text, duration } ──┘ 录音归档 output/asr-<taskId>.wav
                识别文字回填文本框（你说一句 → 数字人读一句）

web(ChatPanel) ──POST /api/chat/sessions──▶ 创建会话（点击「开始聊天」）
     │  免按键：持续倾听，VAD 自动断句（也可打字）
     ├─POST /api/chat/sessions/:id/turns──▶ ASR → LLM(带会话上下文) → TTS
     │                                      input/output 明细落库 chat_turns
     │ ◀──{ turn: { inputText, outputText, outputAudioUrl } }──┘
     ├─ 自动播放回复音频 <audio>（气泡内）
     └─POST /api/chat/sessions/:id/end──▶ 结束会话（点击「结束聊天」）
```

## 存储约定

- **生成的文件**：统一写 `output/`（语音 mp3、后续的口型视频 mp4），server 以 `/media/<文件名>` 对外提供
- **数据库**：SQLite，固定在 `data/human-lab.db`；`tasks` 表记录每次任务（id/类型/文本/音色/文件/字节数/状态/错误/时间）

## 能力调用方式（server 内部）

```ts
// apps/server 内任意模块（能力层保持纯粹：不碰 HTTP、不写 DB，任务记录由 tasks.ts 负责）
import { synthesizeSpeech } from './capabilities/tts.js';
import { recognizeSpeech } from './capabilities/asr.js';
import { chat, type ChatMessage } from './capabilities/llm.js';

const { audio, outFile } = await synthesizeSpeech('你好，我是数字人。');   // 默认写 output/
await synthesizeSpeech('男声', { config: { voice: 'longanlufeng' } });

const { text, usage } = await recognizeSpeech('output/tts-xxx.mp3');       // 文件路径 / URL / Buffer

await chat('你是谁');                                       // 单句（默认开思考，聚合返回）
await chat('1+1=?', { thinking: false });                   // 关思考（非流式，延迟最低）
await chat(history, { onContent: (d) => append(d) });       // 传回调即流式 + 多轮 history（实时聊天用）
```

配置见 `.env`（`DASHSCOPE_API_KEY` 必填；TTS 音色仅 `longanlingxin` 女 / `longanlufeng` 男；`ASR_MODEL` 默认 `qwen-audio-3.1-asr-flash`；`LLM_MODEL` 默认 `qwen3.8-flash`）。

## 乐高进度

| # | 块 | 状态 |
|---|----|------|
| 01 | TTS 文本转语音（`apps/server/src/capabilities/tts.ts`） | ✅ |
| 02 | ASR 语音识别（`apps/server/src/capabilities/asr.ts`，设计见 docs/asr-design.md） | ✅ |
| 03 | LLM 对话回复（`apps/server/src/capabilities/llm.ts`，流式/思考/多轮，实时聊天备料） | ✅ |
| 04 | 口型视频（形象 + 音频 → 视频，规划为 `capabilities/lipsync.ts`） | ⬜ |
| 05 | 服务化（Express 任务接口） | ✅（合成 + 识别 + 聊天会话） |
| 06 | 前端网页 | ✅（聊天面板 + 朗读面板 + 历史明细） |
| 07 | 实时聊天（语音 → ASR → LLM → TTS 全链路对话） | ✅（免按键连续对话 + 明细落库） |
