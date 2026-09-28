# 能力乐高堆叠

按设计文档 `docs/design.md` 的里程碑，把每个能力做成**独立可运行、可单独测试**的乐高块。

- **能力本体**内聚在 `apps/server/src/capabilities/`（方案一：消费方只有 server，shared 只留类型契约），server 构建后 lego 从其 `dist/` 引用；
- **乐高块**（`lego/`）是每个能力的"可运行演示 + 验证脚本"，保持极薄，只做参数解析和结果展示。注意引用的是 server 构建产物，先 `npm run build`（npm install 时的 prepare 也会自动构建）。

存储约定：生成的文件统一写 `output/`；任务记录写 SQLite（`data/human-lab.db`，由 server 编排时写入）。
配置统一放仓库根目录 `.env`（已被 .gitignore 排除），能力内部自动向上查找加载。

## 乐高块清单

| # | 块 | 输入 → 输出 | 状态 |
|---|----|------------|------|
| 01 | `01-tts/tts-dashscope.mjs` 文本转语音（能力在 `apps/server/src/capabilities/tts.ts`） | 文本 → `output/*.mp3` | ✅ |
| 02 | `02-asr/asr-dashscope.mjs` 语音识别（能力在 `capabilities/asr.ts`，设计见 docs/asr-design.md） | 音频 → 文字 | ✅ |
| 03 | `03-llm/llm-chat.mjs` LLM 对话（能力在 `capabilities/llm.ts`） | 消息 → 回复 | ✅ |
| 04 | `04-lipsync/talk-probe.mjs` 口播视频（能力在 `capabilities/lipsync.ts`，设计见 docs/lipsync-design.md） | 形象图+口播稿 → `output/*.mp4` | ✅ |
| 05 | 服务化（NestJS 任务接口，见 apps/server） | — | ✅ |
| 06 | 前端网页（文本框 + `<audio>`/`<video>` 播放） | — | ✅ |

## 块 01：TTS（DashScope WebSocket）

官方只有 Python SDK，这里直接实现 `api-ws/v1/inference` 协议：
`run-task` → `task-started` → `continue-task`(文本) → `finish-task` → 二进制音频帧 → `task-finished`。

```bash
# 默认测试文本
node lego/01-tts/tts-dashscope.mjs

# 自定义文本 / 音色 / 输出文件
node lego/01-tts/tts-dashscope.mjs "今天天气怎么样？"
node lego/01-tts/tts-dashscope.mjs --voice Cherry --out output.mp3 --text "你好，我是数字人。"

# 试听（macOS）
afplay output.mp3
```

配置项（`.env` 或环境变量，均可被命令行参数覆盖 `--voice/--model/--out`）：

| 变量 | 说明 | 默认 |
|---|---|---|
| `DASHSCOPE_API_KEY` | 百炼 API Key | —（必填） |
| `DASHSCOPE_WS_URL` | WebSocket 推理入口 | 官方公网入口（当前配置了专属端点） |
| `TTS_MODEL` | 模型名 | `qwen-audio-3.0-tts-plus` |
| `TTS_VOICE` | 音色名 | `longanlingxin`（女）/ `longanlufeng`（男）——该模型仅有的 2 个系统音色 |
| `TTS_FORMAT` | 音频格式 | `mp3`（可选 `wav`/`pcm`/`opus`） |
| `TTS_SAMPLE_RATE` | 采样率 | `22050` |

被服务端拒绝（`task-failed`）时的排查经验（都已踩过）：

| 报错 | 原因 | 解决 |
|---|---|---|
| `InvalidParameter: Request format is invalid!` | 报文不符合 tts_v2 协议（如 `streaming` 不是 `duplex`、format 写成 `mp3_22050Hz_16bit_1mono` 老格式） | 对照本文件协议注释；`format` 只传 `mp3`/`wav` 等裸格式名 |
| `InvalidParameter: Request voice is invalid!` | voice 为空 | 填音色名 |
| `InvalidParameter: [cosyvoice:]Engine error [411]: TTS speak operation failed` | **音色不在该模型的音色列表**（音色不能跨模型混用，Cherry 是 CosyVoice/qwen-tts 的） | 查官方[音色列表](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list) |
| `Throttling.RateQuota: Requests rate limit exceeded` | 请求过快触发限流 | 间隔几秒重试 |

实测性能：一句话约 1.5~2.5s 出完整 mp3（48KB/13字）。

## 块 04：口播视频（wan3.0-video-prime，探测 + CLI）

形象图 + 口播稿 → 数字人口播 mp4（9:16/480P，实测 53 字 ≈ 10s 音频 ≈ 67s 生成）：

```bash
npm run talk   # = 构建 server + 运行 talk-probe.mjs（默认口播稿/默认形象）
# 自定义：
node lego/04-lipsync/talk-probe.mjs --text "口播稿（≤60字）" --image assets/avatars/default/image.png --out output/my.mp4
```

探测踩坑（已固化进能力层，详见 docs/lipsync-design.md §3.6）：

| 报错 | 原因 | 解决 |
|---|---|---|
| getPolicy 400 `InvalidParameter` | 缺 `model` 参数；或走了专属实例 host（uploads 仅公网端点有） | `action=getPolicy&model=<模型名>`，host 用 `dashscope.aliyuncs.com` |
| OSS 表单 403 `Policy Condition failed` | 表单 `key` 带 `oss://` 前缀 | key 必须是裸对象键，`oss://` 只加在模型入参 URL 上 |
| 任务秒败 `media.url scheme must be http/https, got: 'oss'` | 创建任务未带 `X-DashScope-OssResourceResolve: enable` 头 | wan3.0 请求统一加该头，服务端才会解析 oss:// 临时 URL |

## 下一块预告

- 长口播稿切段生成 + ffmpeg 拼接；商品图带货模板（第二张 reference_image）
- 实时数字人（MuseTalk/LiveTalking 本地 GPU 路线）
