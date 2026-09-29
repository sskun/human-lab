# 语音识别（ASR）能力需求设计文档 —— 语音转文字

> 版本 v0.1 · 2026-09-27
> 一句话目标：给数字人补上"听"的能力——上传/录制一段语音 → 识别成文字，为后续「语音对话数字人」（说 → 听懂 → 回答）打基础。
> 探测先行：本文 §2 是对阿里云接口的**实测探测结论**（非文档转述），所有结论都有可复现脚本佐证（见附录 A）。

---

## 0. 探测结论速览（TL;DR）

| # | 结论 | 实测证据 |
|---|------|----------|
| 1 | 专属 MAAS 端点 + `qwen-audio-3.1-asr-flash` 可用，Bearer 鉴权，HTTP 200 | 用例 A/C，525ms 返回 |
| 2 | **音频可走 base64 data URI 内联，无需 OSS/公网 URL** | 用例 A：`data:audio/mpeg;base64,...` 直接成功 |
| 3 | 裸 base64（无 `data:` 前缀）不行——`data` 字段按 URL 处理 | 用例 B：400 `FILE_DOWNLOAD_FAILED: domain resolution failed` |
| 4 | `parameters.format` 必填；`sample_rate` 可省略；**格式/采样率写错服务端能自动兼容** | 用例 D 400 `parse parameters failed`；format=wav 实为 mp3 仍识别成功 |
| 5 | mp3/22050 直接识别，无需 ffmpeg 转码（我们 TTS 产物即输入） | 6 个用例全部正确识别 TTS 合成音频 |
| 6 | 响应含**字级时间戳**（begin/end/标点），文本带标点 | `sentence.words[]`，10~97 词 |
| 7 | 非流式模式：整段合并为**一个** `sentence` 对象 + 全文 `text`（38s 音频也只有 1 个对象，`sentence_id` 内部递增到 9） | 长音频用例 |
| 8 | SSE 流式（`X-DashScope-SSE: enable`）可用：事件为**累积快照**（文本越滚越长），适合渐进式字幕 | 16 个事件，逐句增长 |
| 9 | 延迟极低：3s 音频 ≈ 0.3~0.5s；38s 音频（605KB）≈ 1.4s | 各用例耗时 |
| 10 | 计费口径 = 音频秒数（`usage.duration`），3s→3、5s→5、38s→38 | usage 字段 |
| 11 | 错误可辨识：伪造数据 → `DECODE_ERROR`；缺 parameters → `parse parameters failed`；data 当 URL 解析失败 → `FILE_DOWNLOAD_FAILED` | 错误用例 |

**一句话：接口比预期更省事——不用 OSS、不用转码、同步秒回。本期可以直接落地。**

---

## 1. 背景与目标

### 1.1 背景

数字人 demo 目前已有 TTS（乐高块 01 ✅，文本 → 语音）。整个产品要走向「可对话的数字人」，还需要**听觉**：

```
[已有] 文本 ──TTS──> 语音 ──> 数字人开口说话
[本期] 语音 ──ASR──> 文本            ← 本文档范围
[远期] 用户语音 ──ASR──> 文本 ──LLM──> 回答文本 ──TTS──> 数字人回答（全双工对话）
```

本期只做 ASR 能力本身 + 最小可用入口，不做对话编排。

### 1.2 本期目标

- **G1 能力层**：`@human-lab/shared` 提供一行调用的 `recognizeSpeech()`，输入本地音频文件路径 / Buffer / 公网 URL，输出文字（含字级时间戳可选）。
- **G2 服务接口**：server 提供 `POST /api/listen`，接收上传音频，返回识别文本（同步秒回，不需要轮询）。
- **G3 前端入口**：web 页面提供「按住说话」麦克风按钮，浏览器内录音 → 上传 → 识别结果回填到 TTS 文本框（天然形成"你说一句、数字人读一句"的演示闭环，**不引入 LLM**）。
- **G4 可观测**：每次识别落 SQLite（`type='asr'`），保留录音文件与识别文本，历史列表可见。

### 1.3 非目标（本期不做）

- 实时/边说边出字的流式识别（SSE 能力已验证可用，留作二期）
- 说话人分离（响应里有 `speaker_id` 字段但当前恒为 null）
- 热词定制、多语种/方言显式切换（模型默认支持中英文混说，实测英文单词 `Monorepo` 识别正常）
- 对话编排（ASR → LLM → TTS 全链路）
- 录音的云端存储/管理（录音仅本地 `output/` 保留）

---

## 2. 能力探测（实测记录）

### 2.1 探测环境

| 项 | 值 |
|---|---|
| 端点 | `https://llm-bp3e6hufsqhewhcr.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`（与 TTS 同一专属实例的 HTTP 端点） |
| 模型 | `qwen-audio-3.1-asr-flash` |
| 鉴权 | `Authorization: Bearer $DASHSCOPE_API_KEY`（沿用现有 Key） |
| 测试音频 | 复用仓库 TTS 产物（mp3/22050Hz），另用 TTS 现场合成 38s 长音频 |

### 2.2 请求用例矩阵（实测）

| 用例 | 传参方式 | parameters | 结果 |
|---|---|---|---|
| A ✅ | `content:[{type:"input_audio", input_audio:{data:"data:audio/mpeg;base64,..."}}]` | `{format:"mp3", sample_rate:"22050"}` | 200，识别正确 |
| B ❌ | 同上但 `data` 为裸 base64（无 `data:` 前缀） | 同上 | 400 `FILE_DOWNLOAD_FAILED: domain resolution failed`（被当 URL 解析） |
| C ✅ | DashScope 原生风格 `content:[{type:"audio", audio:"data:audio/mpeg;base64,..."}]` | 同上 | 200，识别正确（与 A 等价） |
| D ❌ | 同 A 但**不传** `parameters` | — | 400 `parse parameters failed`（format 必填） |
| E ✅ | 同 A，`format:"wav"` 但实际是 mp3 | `{format:"wav", sample_rate:"16000"}` | 200，识别正确（**格式自动探测**） |
| F ✅ | 同 A，只传 `format` 不传 `sample_rate` | `{format:"mp3"}` | 200 |
| G ❌ | 同 A，data 为伪造数据 `data:audio/mpeg;base64,AAAA` | 同上 | 400 `DECODE_ERROR` |
| H ✅ | SSE 流式：同 A + `X-DashScope-SSE: enable` | 同上 | 200 `text/event-stream`，累积快照事件 |
| I ✅ | 公网 URL 传入 `data`（文档标准用法，未实测——本地无公网 URL，信任文档 + B 用例反证 data 按 URL 处理） | 同上 | —（列入待验证） |

### 2.3 响应结构（非流式，HTTP 200）

```jsonc
{
  "sentence": {                       // 整段一个对象（实测 38s 也只返回 1 个）
    "sentence_id": 9,                 // 内部句编号，非流式下即最后一句的编号
    "begin_time": 240, "end_time": 37825,   // 毫秒
    "text": "这是语音识别的长音频测试，……谢谢大家。",   // 全文（带标点）
    "channel_id": 0,
    "speaker_id": null,               // 说话人分离：当前恒为 null
    "sentence_end": true,
    "words": [                        // 字级时间戳（中文按字/词元切分）
      { "begin_time": 240, "end_time": 760, "text": "这是", "punctuation": "", "fixed": true, "speaker_id": null },
      …
    ]
  },
  "text": "……",                       // 与 sentence.text 相同的全文
  "request_id": "d6c672c3-…",
  "output": { "sentence": {…}, "text": "…", "request_id": "…" },  // 重复包裹（兼容层，可忽略）
  "usage": { "duration": 38, "input_tokens": 530, "output_tokens": 109, "total_tokens": 639 }
}                                     //        ↑ 计费口径：音频秒数
```

SSE 流式模式：每个 `data:` 帧结构与上相同，`text`/`sentence` 为**从头累积到当前**的快照（非增量 delta），最后一个事件即完整结果。

### 2.4 性能实测

| 音频 | 大小 | 时长 | 非流式耗时 |
|---|---|---|---|
| lego-monorepo-test.mp3 | 44KB | 3s | 0.34~0.53s |
| asr-long-test.mp3（TTS 现场合成的多句长文） | 605KB | 38s | 1.4s |

识别准确度：全部用例（含"乐高块在Monorepo下依然可用""数字人的名字叫小安"等中英混排）逐字正确。

### 2.5 已知边界（未实测 / 待验证项）

| 项 | 状态 | 说明 |
|---|---|---|
| 音频时长/大小上限 | ⚠️ 未实测 | 官方通用口径为长音频支持小时级、单文件 ≤1GB（URL 方式）；base64 方式受 HTTP 请求体限制，按 38s=605KB 推算，**几分钟内的音频安全**。上线前用 5~10 分钟音频验证一次 |
| 支持的格式清单 | ⚠️ 部分 | 实测 mp3 ✅；官方文档口径支持 wav/mp3/aac/amr/opus/m4a 等；**浏览器 MediaRecorder 的 webm/opus 未实测**（见 §5.3 决策，已规避） |
| 空音频/纯静音 | ✅ 已验证（浏览器 E2E） | 无语音内容时上游返回 400 `CLIENT_ERROR: ASR_RESPONSE_HAVE_NO_WORDS`；web 端已将其映射为引导提示"没有听清"，CLI/能力层原样抛出 |
| 公网 URL 输入 | ⚠️ 未实测 | 文档标准用法；能力层支持该入参形态，但不依赖它 |

---

## 3. 需求定义（本期范围）

### R1 共享能力层（`packages/shared/src/asr.ts`）

- `recognizeSpeech(input, opts?)` 一行调用：
  - `input`：三种形态——本地文件路径（`string`，读文件转 base64）、HTTP(S) URL（透传）、`Buffer`（转 base64）
  - `opts.config`：覆盖 `resolveASRConfig()`（模型/端点/超时）
  - 返回：`{ text, sentence, usage, requestId }`（`sentence` 含原始字级时间戳；`words` 不做二次加工）
- 错误处理：非 200 抛出带 `code` + `message` 的 Error（`DECODE_ERROR`/`FILE_DOWNLOAD_FAILED`/HTTP 状态码等原样透传）；`text` 为空字符串时不报错（静音场景）
- 验收：`node lego/02-asr/asr-dashscope.mjs output/tts-xxx.mp3` 输出识别文本；38s 音频 2s 内返回

### R2 乐高块 02 CLI（`lego/02-asr/`）

- `asr-dashscope.mjs <音频文件|URL>`：命令行识别，输出文本 + 耗时 + usage（风格对齐乐高块 01）
- 探测脚本 `probe-asr*.mjs` 保留作回归验证

### R3 服务接口（`apps/server`）

- `POST /api/listen`，请求体 JSON：`{ audioBase64: string, format?: "wav"|"mp3"|…, source?: "mic"|"file" }`
  - `audioBase64` 为裸 base64（不含 `data:` 前缀，由 server 拼前缀）；大小上限 **10MB**（超限 413）
  - 同步返回 200：`{ taskId, text, duration }`（`duration` = 音频秒数，取自 usage）
  - 错误：400（缺参/格式不支持）、413（超限）、502（上游错误，透传 message）
- **同步接口而非 202 任务轮询**：实测延迟亚秒级，轮询反而增加复杂度；落库仍复用 tasks 表（见 R4）
- 录音归档：把上传音频写 `output/asr-<taskId>.<format>`，`file_path` 指向它，便于排查识别质量问题
- 验收：`curl -F` 或 JSON 上传一段 TTS mp3，返回正确文字；`GET /api/tasks` 能看到 `type=asr` 记录

### R4 数据契约（`packages/shared`）

- `types.ts`：新增 `ListenRequest`/`ListenResponse`；`TaskView` 增加 `text?: string`（asr 任务结果直接展示文字，无音频 URL 或音频 URL 二选一）
- `db.ts`：零迁移——`text` 列复用（asr 任务存**识别结果文本**），`voice` 列存录音格式（如 `wav`）
- server 历史列表/详情天然兼容（`audioUrl` 对 asr 任务同样生效，可回放录音）

### R5 前端入口（`apps/web`）

- TTS 文本框旁新增「🎤 按住说话」按钮：
  - 按下开始录音、松开结束；录音中显示计时与波形/红点动效
  - 录音方案：**Web Audio API 采集 PCM → 前端重采样 16kHz 单声道 → 编码 WAV → base64 上传**（不依赖 MediaRecorder 容器格式，见 §5.3）
  - 识别结果回填文本框（追加模式），用户可改后点「合成」形成「你说 → 数字人读」闭环
  - 错误提示：麦克风权限被拒 / 网络失败 / 识别失败，行内 toast
- 验收：Chrome + Safari 本地录音识别中文正确；`localhost` 无需 HTTPS（浏览器安全策略允许）

---

## 4. 技术设计

### 4.1 数据流

```
web(App.tsx 麦克风)                          server(:3101)
 │ WebAudio 采集 PCM(16k mono)                │
 │ 编码 WAV → base64                          │
 ├────POST /api/listen {audioBase64,format}──▶│ 校验/落库(queued) → 写 output/asr-<id>.wav
 │                                            │ shared.recognizeSpeech(本地文件) ──▶ 阿里云 MAAS
 │ ◀──200 {taskId, text, duration}────────────│ 回写 done + 识别文本
 │ 回填文本框 ──POST /api/speak──▶ 数字人朗读   │
```

### 4.2 能力层 API（对齐 tts.ts 风格）

```ts
// packages/shared/src/asr.ts
export interface ASRConfig { apiKey?: string; url: string; model: string; timeoutMs?: number }
export interface ASRResult {
  text: string;              // 全文（带标点）
  sentence: Sentence | null; // 原始 sentence 对象（含 words 字级时间戳）
  usage: { duration: number } | null;
  requestId: string;
}
export class DashScopeASR { constructor(cfg: ASRConfig); recognize(input: string | Buffer): Promise<ASRResult> }
export async function recognizeSpeech(
  input: string | Buffer,
  opts?: { config?: Partial<ASRConfig>; format?: string },   // format 供 URL/Buffer 场景提示
): Promise<ASRResult>
```

- `input` 形态判定：`Buffer` → base64 data URI；`string` 以 `http(s)://` 开头 → 直接透传给 `data`；否则按本地文件路径读取
- data URI 的 MIME 由 `format` 推断（mp3→`audio/mpeg`、wav→`audio/wav`、其余→`application/octet-stream`——实测服务端自动探测，MIME 不敏感）
- 复用 `config.ts` 的 `loadDotEnv`；新增 `resolveASRConfig()`：
  - `ASR_MODEL`（默认 `qwen-audio-3.1-asr-flash`）
  - `DASHSCOPE_ASR_URL`（默认专属端点，示例 curl 同款）
  - 超时默认 120s（长音频兜底）

### 4.3 HTTP 请求体（能力层发出的报文，实测可用）

```json
{
  "model": "qwen-audio-3.1-asr-flash",
  "input": { "messages": [ { "role": "user", "content": [
    { "type": "input_audio", "input_audio": { "data": "data:audio/wav;base64,…" } }
  ] } ] },
  "parameters": { "format": "wav", "sample_rate": "16000" }
}
```

Headers：`Authorization: Bearer …`、`Content-Type: application/json`、`X-DashScope-SSE: disable`（本期固定非流式）。

### 4.4 server 接口

```
POST /api/listen          { audioBase64, format? } → 200 { taskId, text, duration }
GET  /api/tasks/:id       TaskView 增加 text（asr 任务）；audioUrl 仍指向录音文件
GET  /api/tasks           历史列表兼容展示两类任务
```

实现要点：沿用 `tasks.ts` 编排骨架，但 `runTask` 改为同步等待（`/api/listen` 内 `await`，识别快，不值得异步轮询）；任务状态仍走 `queued→processing→done|failed` 全程落库。

### 4.5 前端录音（关键实现约束）

- `getUserMedia({ audio: { channelCount:1, sampleRate:16000 } })` + `AudioWorklet`（降级 `ScriptProcessor`）采集 `Float32 PCM`
- 手动重采样到 16kHz（线性插值），16bit PCM 打包 WAV 头——产出即文档标准姿势（wav/16000）
- 为什么不用 `MediaRecorder`：输出容器随浏览器漂移（Chrome=webm/opus，Safari=mp4/aac），webm 支持未实测；WAV 是唯一「三端一致 + 已被文档示例背书」的格式。1 分钟 16k 单声道 WAV ≈ 1.9MB，base64 后 ≈ 2.5MB，在 10MB 限额内
- 录音上限 60s（前端到时自动截断），防止误触长录

---

## 5. 关键决策记录

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| D1 | 音频走 **base64 data URI 内联** | 公网 URL（需 OSS） | 实测可用（用例 A）；零额外基础设施；本地文件/上传场景天然适配。URL 形态在能力层保留透传 |
| D2 | `/api/listen` **同步返回** | 复用 202 + 轮询 | 实测亚秒级延迟；轮询的复杂度配不上收益。任务仍落库保证可观测 |
| D3 | 前端 **WAV 16k** 上传 | MediaRecorder webm/mp4 直传 | 容器格式跨浏览器一致；规避 webm 未实测风险；正是文档示例参数 |
| D4 | 识别结果复用 tasks 表 `text` 列 | 新建 transcriptions 表 | 零迁移；任务历史两种类型统一展示 |
| D5 | MVP 非流式（`X-DashScope-SSE: disable`） | SSE 流式 | 本期场景是「整句说完再识别」；SSE 已验证可用（用例 H），二期做实时字幕/边说边出字时直接启用 |

## 6. 里程碑

| 里程碑 | 内容 | 预估 | 验收标准 |
|---|---|---|---|
| M1 | 能力层 + 乐高块 02：CLI 文件/URL → 文字 | 0.5 天 | `node lego/02-asr/asr-dashscope.mjs output/tts-xxx.mp3` 输出正确文本 |
| M2 | `/api/listen` + 落库 + 录音归档 | 0.5 天 | curl 上传 mp3/wav 返回文字；tasks 表可见 asr 记录 |
| M3 | 前端按住说话 + 结果回填闭环 | 1 天 | 浏览器说话 → 文本框出现识别文字 → 数字人朗读 |
| M4 | 验证边界（5~10 分钟长音频、webm 直传、静音） | 0.5 天 | §2.5 待验证项有结论并更新本文档 |

## 7. 风险与开放问题

- **专属端点依赖**：MAAS 专属实例的可用性/限流与公共百炼不同，暂无限流数据；server 侧加 429/5xx 的重试一次 + 明确报错即可
- **计费**：按 `usage.duration`（音频秒）计费，单价以控制台为准；每次任务已落库 duration，便于对账
- **隐私**：录音会出域到阿里云；页面录音按钮旁应有提示文案；录音本地归档目录 `output/` 已在 `.gitignore` 约定范围（确认）
- **浏览器兼容**：`AudioWorklet` 需要 Chrome/Edge/Safari 14.1+；降级路径 ScriptProcessor 已在设计中
- **开放问题**：① base64 请求体的实际上限需 M4 实测；② 纯静音/极短音频（<200ms）的返回行为需确认；③ 二期 SSE 流式接入时，需要确认事件里 `fixed:false→true` 的稳定语义（探测中观察到非终帧词为 `fixed:false`）

---

## 附录 A：探测脚本与复现命令

```bash
# 请求体/传参矩阵 + 响应结构（用例 A~D）
node lego/02-asr/probe-asr.mjs output/lego-monorepo-test.mp3
# 长音频 + 错误场景矩阵（用例 E~G 及长音频）
node lego/02-asr/probe-asr2.mjs
# 38s 长音频复现（先用乐高块 01 合成）
node lego/01-tts/tts-dashscope.mjs --out output/asr-long-test.mp3 --text "……多句长文……"
```

## 附录 B：参考资料

- 百炼模型广场（模型详情含价格/限流）：https://www.qianwenai.com/models
- 百炼文档首页：https://help.aliyun.com/zh/model-studio/
- 仓库内 TTS 能力实现（风格基准）：`packages/shared/src/tts.ts`、`docs/design.md`
