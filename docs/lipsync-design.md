# 数字人形象与口型 MVP 设计文档 —— 文字口播数字人（商品介绍 / 带货口播）

> 版本 v0.3 · 2026-09-27（v0.1 选型百炼 EMO → emo-v1 下线；v0.2 选型 wan2.2-s2v；v0.3 按口播场景改选 **wan3.0-video-prime** 全能参考）
> 一句话目标：用户输入一段口播文字 → 数字人（一张形象图）面对镜头按文字口播，生成竖屏口播视频（480P mp4），网页播放。面向电商/广告的**离线生成**场景，明确不做实时聊天视频化。
> 选型先行：本文 §3 的 wan3.0 API 细节来自**官方文档整理**（文档 last-modified 2026-09-11，未实测），实施第一步按 §3.4 探测清单跑通 probe 脚本（沿用 asr-design.md「探测先行」方法论）。

---

## 0. 结论速览（TL;DR）

| # | 结论 | 依据 |
|---|------|------|
| 1 | 口播方案选 **万相 wan3.0-video-prime**（高速版全能参考）：`reference_image（形象图，可加商品图）+ reference_audio（TTS 音频）+ prompt（口播指令）→ 音频驱动的口播视频`，零 GPU | 官方素材组合明确支持「图片+音频」全模态参考模式，即音频驱动；prime 高速版能力对齐标准版且端到端更快 |
| 2 | 端点与用户已验证的 r2v curl **完全同路径**：`POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis`（`X-DashScope-Async: enable`），查询 `GET …/api/v1/tasks/{task_id}` | wan3.0 官方文档；与 TTS/ASR/LLM 同一专属实例 host |
| 3 | 硬限制：**reference_audio 单段 [1,15]s**（wav/mp3 ≤15MB）→ 口播稿一次约 **60 字**；reference_image 单边 [240,8000]px ≤20MB（**支持 Base64 data URI**，音频不支持）；reference_image 最多 10 张 → 商品图可同传 | wan3.0 输入限制 |
| 4 | 视频参数：`resolution: 480P`（本期口径）、`ratio: 9:16`（口播竖屏）、`duration: [2,30]` 或 `-1` 智能时长、`audio: true`（默认，输出含声音）、最长 **30 秒** | wan3.0 parameters |
| 5 | 生成耗时官方口径 1~5 分钟（prime 更快）；`video_url` 与 task_id 均 24h 有效 → 成功后立即下载转存 `output/talking-<taskId>.mp4` | wan3.0 官方文档 |
| 6 | 成本：480P 约 ¥0.45/秒（待对账核实），一条 15s 口播 ≈ ¥6.75；任务下发/查询有 RPS 限制，同时处理中任务数以实测为准 | 计费页 + 官方文档 |
| 7 | 任务流水线在现有 `POST /api/speak` 上扩展：`withVideo: true` → TTS → 上传 → wan3.0 异步任务 → 下载转存；单任务双产物（audioUrl + videoUrl） | 与现有任务编排（tasks.ts）无缝衔接 |
| 8 | 兜底：wan2.2-s2v（专门口型模型，图+音频→说话，<20s）保留为口型精度不达标时的降级路线，Provider 形状预留 | §3.1 模型决策 |

**一句话：口播稿（≤60 字）→ TTS → 「形象图 + TTS 音频 + 口播 prompt 模板」喂给 wan3.0-video-prime → 1~5 分钟后得到竖屏 480P 口播视频，网页播放。**

---

## 1. 背景与目标

### 1.1 场景定义：离线口播数字人（非实时）

参照电商/广告行业的成熟用法：商家输入商品介绍文案 → 得到一条数字人对镜头口播的短视频（抖音/视频号竖屏格式）。**本期明确不做实时对话视频**（GPU + 流式渲染成本过大），生成是离线的分钟级任务：

```
[已有 ✅] 文本 ──TTS──> 音频（块01）
[已有 ✅] 语音/文字 ──LLM──> 回复（块03，聊天场景继续纯音频）
[本期 ◼] 口播稿 + 形象图 ──wan3.0-video-prime──> 数字人口播视频（块04）  ← 本文档范围
```

### 1.2 本期目标

- **G1 形象资产**：形象图（AI 生图获得，规避肖像权）目录约定与规范；预留商品图扩展位。
- **G2 能力层**：`capabilities/lipsync.ts` 提供一行调用的 `generateTalkingVideo()`（本地图 + 本地音频 → 本地 mp4），内部封装上传 / 任务创建 / 轮询 / 下载；内置口播 prompt 模板。
- **G3 服务接口**：`POST /api/speak` 增加 `withVideo` 开关；`TaskView` 增加 `videoUrl` 与 `stage`。
- **G4 前端**：朗读面板增加 `<video>` 播放器、阶段文案（「合成中…」→「口播视频生成中，约 1~5 分钟…」）与「AI 生成」角标；口播稿限长提示。
- **G5 可观测**：口播任务落 SQLite（`type='talking'`），视频归档 `output/`，历史列表可见。

### 1.3 非目标（本期不做）

- **实时聊天视频化**（用户已明确：消耗太大，聊天模式维持纯音频；远期走 MuseTalk/LiveTalking 路线）
- 超过 15s 音频的长口播（远期：切段生成 + ffmpeg 拼接）
- 多形象管理界面、口播视频模板市场、字幕/花字包装
- 声音克隆（先用 TTS 系统音色）

---

## 2. 形象设计（Avatar）

### 2.1 资产形态

```
assets/avatars/
└─ default/            # 默认形象（AVATAR_ID=default）
   └─ image.png        # 形象图（gitignore，不入库；AI 生图获得，提示词见 §2.5）
```

- 形象 = 一张图，wan3.0 以 `reference_image` 引用并要求生成视频保持形象一致。
- **商品图（可选扩展）**：`assets/avatars/<id>/product.jpg` 或请求参数传入——`reference_image` 最多 10 张，商品图作为第 2 张参考图 + prompt 模板变体即构成「商品介绍」场景（MVP 先跑纯口播，商品图列入 M5）。
- 图片不入 git；AI 生图的脸非真人，从源头规避肖像权与云端审核（§2.4）。

### 2.2 图片规范（对齐 wan3.0 `reference_image` 要求）

| 项 | 要求 | 原因 |
|---|------|------|
| 内容 | 单人、正面正对镜头、五官无遮挡（尤其嘴部） | 口播基准帧 |
| 嘴型 | 自然闭合、微笑不露齿 | 露齿基准帧易造成张口瑕疵 |
| 分辨率 | 单边 **[240, 8000]px**，长宽比 ≤8:1，≤20MB；建议 1024~1792px | 官方硬限制 |
| 格式 | JPEG/JPG/PNG（无透明通道）/BMP/WEBP | 官方支持列表 |
| 构图 | 胸像/半身，3:4 或 4:5；背景简洁 | 输出 ratio 由参数控制，形象图本身干净即可 |
| 商品图 | 白底/场景实拍、主体清晰、无文字水印 | 作为第 2 张 reference_image |

> 注：图像支持 Base64 data URI 直传（`data:image/png;base64,…`），音频**只支持公网 URL / oss:// 临时 URL** → 上传通道必接（§3.3）。

### 2.3 视频画幅与分辨率：9:16 + 480P

- `ratio: 9:16`（默认）：口播/带货主流竖屏格式，同一形象图适配多平台分发；`.env` 可切 `adaptive/3:4/1:1/16:9`
- `resolution: 480P`（本期口径）：单价最低，网页预览足够；720P/1080P 留作配置项
- `duration: -1`（智能时长，默认）：让模型按参考音频长度对齐输出；探测 P4 对比固定秒数方案

### 2.4 合规要求（形象侧）

- 真人肖像必须本人/已授权；MVP 用 AI 生图脸规避
- 前端播放器加「AI 生成」角标；wan3.0 `watermark` 参数保持 false，深度合成标识由我们前端叠加（§7）

### 2.5 形象生图提示词（文生图直接可用）

竖构图 3:4，尺寸 ≥1024px（如 1328×1792）。

**中文版（通义万相文生图 / 即梦）：**

```
真实摄影风格的数字人形象照：一位 25 岁左右的年轻亚洲女性，亲和专业的带货主播气质，
正面面对镜头，头部端正无偏转，眼神自然看向镜头，微笑但嘴巴自然闭合、不露齿，
肩部以上的胸像构图，穿简约的浅米色圆领针织衫，佩戴小巧耳钉，
柔和均匀的正面柔光，肤色真实自然，发丝清晰，
纯浅灰色无缝摄影棚背景，画面干净无杂物，
85mm 人像镜头，浅景深，超高清细节，人物居中
```

**英文版（Midjourney / SDXL）：**

```
photorealistic portrait of a friendly young Asian woman in her mid-20s, professional livestream host look,
facing the camera directly, head straight, eyes to the viewer, gentle smile with lips closed (no teeth),
head-and-shoulders bust framing, wearing a simple light beige crew-neck knit top, small earrings,
soft even frontal lighting, realistic skin texture, sharp hair detail,
plain light gray seamless studio background, clean composition,
85mm lens, shallow depth of field, ultra detailed, centered subject --ar 3:4
```

变体：男声形象换「30 岁左右年轻亚洲男性，短发清爽」；卡通形象换「3D 卡通风格解说员角色，皮克斯质感」。

**生成后自查**：正脸平视 ✔ 嘴巴闭合不露齿 ✔ 单人且嘴部无遮挡 ✔ 背景无文字水印 ✔ 短边 ≥240px（建议 ≥1024px）✔

---

## 3. 口播能力选型与协议（官方文档整理）

### 3.1 模型决策：wan3.0-video-prime（口播主选）

| 模型 | 输入 | 定位 | 结论 |
|---|---|---|---|
| **wan3.0-video-prime** | prompt + 全模态参考（图/视频/音频/文件/网页） | 全能参考生成：最长 30s、30fps、480P~1080P、原生音画；「reference_image + reference_audio」组合即官方的**音频驱动**模式；prime 高速版端到端更快 | ✅ **本期主选**：图+音频+口播指令 → 口播视频，且同传商品图就能做商品介绍 |
| wan2.2-s2v | 一张图 + 一段音频（<20s） | 专门的口型驱动数字人模型（说话/唱歌/表演） | 🔁 **降级兜底**：若 wan3.0 全能参考模式的口型精度/形象一致性不达标，切回 s2v（能力层 Provider 形状预留） |
| wan2.7-r2v | prompt + 参考视频/图片 | 多主体剧情生成（2.7 时代） | 被 wan3.0 全能参考取代，不再单独设计 |
| emo-v1 | 肖像 + 音频 | 旧口型模型 | **已宣布下线，弃用** |

wan3.0 首帧/首尾帧模式**不支持**音频输入（官方 FAQ：wan2.7 支持 driving_audio，wan3.0 不支持，音频驱动必须走全模态参考模式）——因此我们的调用形态固定为 `reference_image + reference_audio` 组合。

### 3.2 wan3.0 视频生成接口（异步任务）

```
# 创建任务（与用户已验证的 r2v curl 同端点同路径，仅换 model 与 input 内容）
POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis
Authorization: Bearer $DASHSCOPE_API_KEY
X-DashScope-Async: enable          // 必选
Content-Type: application/json
{
  "model": "wan3.0-video-prime",
  "input": {
    "prompt": "<口播指令模板，用「图1」「音频1」指代 media 素材>",
    "media": [
      { "type": "reference_image", "url": "<形象图URL 或 data:image/...;base64,...>" },
      { "type": "reference_audio", "url": "<TTS 音频URL，wav/mp3，[1,15]s，≤15MB>" }
    ]
  },
  "parameters": {
    "resolution": "480P",          // 480P（本期）| 720P | 1080P，默认 1080P
    "ratio": "9:16",               // adaptive(默认) | 16:9 | 4:3 | 1:1 | 3:4 | 9:16
    "duration": -1,                // [2,30] 整数；-1 = 智能时长（按音频对齐，P4 实测）
    "audio": true,                 // 默认 true：输出视频含声音
    "prompt_extend": false,        // 口播模板是精确指令，关闭改写保证可控（P3 可对比）
    "watermark": false
  }
}
→ 200 { "output": { "task_id": "…", "task_status": "PENDING" }, "request_id": "…" }

# 轮询（官方口径 1~5 分钟，建议 15s 间隔；查询 RPS 20；task_id 24h 有效）
GET https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/tasks/{task_id}
→ { "output": { "task_status": "PENDING|RUNNING|SUCCEEDED|FAILED|CANCELED|UNKNOWN",
                "submit_time": "…", "end_time": "…",
                "video_url": "…" },                 // SUCCEEDED 时存在，24h 有效
   "usage": { "video_count": 1, "duration": 12.0, "output_video_duration": 12.0,
              "fps": 30, "SR": 480, "ratio": "9:16" } }
// 失败：output.code / output.message（如 InvalidParameter）
```

要点：
- prompt 与 media **必填其一**；全能参考模式下 prompt 用「图1/图2/音频1」按 media 数组顺序指代素材（图和视频分别计数）
- **参考音频 = 口播声音**：模型按音频1 的语音内容与音色驱动人物说话（音色一致性列入 P3 实测）
- 组合规则：`first_frame/last_frame` 与 `reference_*` 互斥；`reference_image`/`reference_video`/`reference_audio` 可自由组合；`file/link` 二选一且可与 reference 组合
- 输出 `usage.duration` 是计费口径；`video_url` 24h 失效 → 立即下载转存
- 同时处理中任务数与任务下发 RPS 以实测为准（官方查询 RPS 20）

### 3.3 免搭 OSS：百炼临时文件上传通道

音频只能传 URL（不支持 Base64），百炼免费临时存储解决：

```
① GET https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy
   X-DashScope-OssResourceResolve: enable
   → { policy, upload_dir: "oss://dashscope-instant/<...>/", oss_host, ... }
② POST https://{oss_host}  （multipart/form-data：policy 凭证 + key = upload_dir + 文件名 + file）
③ 得到 oss://dashscope-instant/<...>/<文件名>（wan3.0 文档明确支持 oss:// 临时 URL），48h 有效
```

形象图可走 Base64 免上传，但为统一与省带宽，图和音频都走上传通道（TTS 音频 ~300KB/15s，形象图 1~2MB，均远低于上限）。**探测项 P2**：uploads 通道可用性与 `oss://` URL 在专属端点的接受度。

### 3.4 口播 prompt 模板（能力层内置，`prompt_extend: false`）

**纯口播（MVP 默认）：**

```
图1是数字人主播的形象照。生成一段竖屏口播视频：图1中的人物正面面对镜头，
保持图1的形象、服装、发型与背景完全一致，按照音频1中的语音逐句播报，
口型与音频1精确同步，表情自然亲和，眼神看向镜头，伴随轻微的手势与头部动作，
光线柔和，画面稳定，专业口播主播风格，无字幕。
```

**商品介绍（M5，商品图作第 2 张 reference_image）：**

```
图1是数字人主播的形象照，图2是本次介绍的商品。
生成一段竖屏带货口播视频：图1中的人物面对镜头介绍图2的商品，
按照音频1中的语音逐句播报，口型与音频1精确同步；
讲到商品时展示图2的商品（手持或陈列在画面一侧），
保持图1人物形象一致，表情自然亲和，节奏明快，电商带货风格，无字幕。
```

用户输入的口播稿**不进 prompt**（内容由音频1承载，避免长 prompt 与 prompt 截断问题），必要时只提取关键词辅助。

### 3.5 待探测清单（实施第一步，产出 probe 脚本）

| # | 待验证项 | 验证方式 | 不通过时的兜底 |
|---|---|---|---|
| P1 | 专属端点 + 当前 Key 可调 `wan3.0-video-prime`（模型已开通；用户已验证同路径 r2v 可达） | probe 用例 A：官方示例素材 → 创建任务返回 task_id | 百炼控制台开通；或换标准版 `wan3.0-video` |
| P2 | 临时上传通道可用，`oss://dashscope-instant/...` 被 wan3.0 接受（音频必须走此通道） | probe 用例 B：上传 TTS 音频 → 创建任务 | 自购 OSS + 签名 URL |
| P3 | **口播效果实测**：音色是否= TTS 原声、口型同步精度、形象一致性（换装/漂移）；`prompt_extend` 开/关对比；与 wan2.2-s2v 同素材对比 | probe 用例 C：同一段中文口播稿全链路生成，逐项评分 | 口型精度不足 → 切 wan2.2-s2v（<20s） |
| P4 | 时长对齐：`duration:-1` 输出是否≈音频时长；固定秒数对比；**文本字数 ↔ 秒数**标定（ASR `usage.duration` 反测 TTS 产物） | probe 用例 D：60 字口播稿实测 | 调整 `LIPSYNC_TEXT_MAX_CHARS` |
| P5 | prime 耗时分布（官方 1~5min 口径）与排队行为 | 记录 P3/P4 各状态停留时间 | 调整 `TALK_TIMEOUT_MS` 与前端文案 |

probe 脚本落在 `lego/04-lipsync/talk-probe.mjs`，**探测结论回填 §3.6**。

### 3.6 探测结论（待回填）

> 实施后在此记录：各用例实测结果、真实耗时、单价核对、踩坑记录。

---

## 4. 系统设计

### 4.1 架构与数据流

```
web(SpeakPanel) ──POST /api/speak { text, withVideo:true }──▶ server
   │                                                            │ tasks 表(type='talking', queued)
   │  每秒轮询 GET /api/tasks/:id                                ▼ 后台流水线 runTask()
   │                                    ┌────────────────────────────────────────────┐
   │                                    │ stage='tts'     capabilities/tts.ts        │→ output/tts-<id>.mp3
   │                                    │ stage='lipsync' capabilities/upload.ts     │→ 临时URL×2（形象图/音频）
   │                                    │                 capabilities/lipsync.ts    │   ├ createTask(wan3.0-video-prime)
   │                                    │                 │  轮询 15s/次（≤10min）     │   └ poll → SUCCEEDED
   │                                    │                 └ 下载 mp4                   │→ output/talking-<id>.mp4
   │                                    └────────────────────────────────────────────┘
   ◀── { status:'done', audioUrl:'/media/tts-…', videoUrl:'/media/talking-…' } ──┘
   <video controls autoPlay> 播放
```

### 4.2 能力层接口（对齐 tts.ts 的既有风格）

```ts
// apps/server/src/capabilities/upload.ts —— 百炼临时文件上传（其他云能力可复用）
export async function getUploadPolicy(): Promise<UploadPolicy>;
export async function uploadToTempStore(file: Buffer, filename: string): Promise<string>;
// 返回 oss://dashscope-instant/... 临时 URL（P2 实测后如需换算 https 再固定）

// apps/server/src/capabilities/lipsync.ts —— 口播视频能力（只做生成，不碰 DB/HTTP 路由）
export interface TalkingVideoResult {
  video: Buffer;        // 视频二进制
  bytes: number;
  durationSec: number;  // usage.duration（计费口径）
  fps: number;          // usage.fps（wan3.0 为 30）
  ratio: string;        // usage.ratio，如 '9:16'
  remoteTaskId: string; // wan3.0 任务 id（排障用）
}
export class WanTalkVideo {
  constructor(cfg: TalkConfig);      // apiKey/端点/model/resolution/ratio/duration/pollInterval/timeout
  createTask(input: { prompt: string; media: Array<{ type: string; url: string }>; parameters: object })
    : Promise<{ taskId: string }>;
  pollTask(taskId: string): Promise<{ status: string; videoUrl?: string; usage?: unknown }>;
  generate(input: { imageUrl: string; audioUrl: string; productImageUrl?: string }): Promise<TalkingVideoResult>;
}

// 一行调用（自动加载 .env；本地文件进、本地文件出；内置口播 prompt 模板，见 §3.4）
export async function generateTalkingVideo(opts: {
  imagePath: string;             // assets/avatars/default/image.png
  audioPath: string;             // output/tts-<id>.mp3
  productImagePath?: string;     // 商品图（可选，M5）
  out?: string;                  // 缺省 output/talking-<时间戳>.mp4
  resolution?: '480P' | '720P' | '1080P';
  ratio?: string;                // 缺省 '9:16'
  duration?: number;             // 缺省 -1（智能时长）
}): Promise<TalkingVideoResult & { outFile: string }>;
```

与 tts.ts 相同的纪律：能力层不写数据库、不碰路由；任务记录由 tasks.ts 编排时写入。CLI（lego 块）直接引 server 构建产物。

### 4.3 任务编排与 API（在现有 speak 接口上最小扩展）

```
POST /api/speak
  请求  { "text": "<口播稿>", "voice?": "longanlufeng", "withVideo?": true }
  响应  202 { "taskId": "…" }

GET /api/tasks/:id
  响应  { "id": "…", "status": "queued|processing|done|failed",
          "stage": "tts" | "lipsync",        // 新增，processing 期间有值
          "audioUrl": "/media/tts-…",        // done 时存在
          "videoUrl": "/media/talking-…",    // 新增，withVideo 任务 done 时存在
          "text": "…", "error": null }
```

流水线状态机（任务 `type='talking'`）：

```
queued ──▶ processing(stage=tts) ──▶ processing(stage=lipsync) ──▶ done(audioUrl+videoUrl)
                │ TTS 失败                    │ 口播任一步失败
                ▼                            ▼
              failed                        failed（audioUrl 保留——音频已成功，仍可播放）
```

设计取舍：
- **单任务双产物**：一次提交一个 id，前端轮询逻辑零改动；`file_path` 存 mp3、新增 `video_path` 列存 mp4
- `TaskStatus` 枚举不动，进度细分用可选字段 `stage`
- 纯 TTS（`withVideo` 缺省 false）行为与现状完全一致
- 口播失败不回滚音频：失败原因入库 `error`，前端可继续播音频

### 4.4 数据模型变更

```sql
-- tasks 表新增两列（db.ts 启动时按 PRAGMA table_info 缺列则 ALTER，兼容存量库）
ALTER TABLE tasks ADD COLUMN video_path TEXT;   -- 口播视频产物路径（type='talking'）
ALTER TABLE tasks ADD COLUMN stage    TEXT;     -- 'tts' | 'lipsync'（processing 期间写入）
```

`packages/shared/src/types.ts` 同步扩展：

```ts
export interface TaskView {
  // …现有字段不变…
  stage?: 'tts' | 'lipsync';
  videoUrl?: string;           // /media/talking-<id>.mp4
}
export interface SpeakRequest {
  text: string;
  voice?: string;
  withVideo?: boolean;         // 缺省 false（纯音频，现状不变）
}
```

### 4.5 前端设计（朗读面板增量）

- 「合成语音」按钮旁加开关：**「生成口播视频」**（勾选后提交 `withVideo: true`）
- 阶段文案按 `stage` 区分：`tts` → 「合成中…」（秒级）；`lipsync` → 「口播视频生成中，约 1~5 分钟，请稍候…」
- done 且有 `videoUrl` → `<video className="player" controls autoPlay playsInline src={videoUrl}>` 替代 `<audio>`；容器叠加「AI 生成」角标
- 文本限长提示：勾选视频时超过 `LIPSYNC_TEXT_MAX_CHARS`（60 字）即时提示「口播视频单条最长约 15 秒，请精简文案」
- 聊天面板不动（非目标 §1.3）

### 4.6 配置项（.env 新增）

| 变量 | 说明 | 默认 |
|---|---|---|
| `MAAS_BASE_URL` | 专属实例端点根（wan3.0 与 TTS/ASR/LLM 同 host） | `https://llm-bp3e6hufsqhewhcr.cn-beijing.maas.aliyuncs.com/api/v1` |
| `AVATAR_DIR` / `AVATAR_ID` | 形象资产目录 / 默认形象 | `assets/avatars` / `default` |
| `TALK_MODEL` | 模型名 | `wan3.0-video-prime`（可切 `wan3.0-video` 标准版） |
| `TALK_RESOLUTION` | 分辨率档位 | `480P`（可 720P/1080P） |
| `TALK_RATIO` | 画幅 | `9:16`（口播竖屏；可 adaptive/3:4/1:1/16:9） |
| `TALK_DURATION` | 时长策略 | `-1`（智能时长，P4 定案） |
| `TALK_PROMPT_EXTEND` | prompt 智能改写 | `false`（口播模板精确可控） |
| `TALK_POLL_INTERVAL_MS` | 任务轮询间隔 | `15000` |
| `TALK_TIMEOUT_MS` | 任务总超时 | `600000`（10min） |
| `LIPSYNC_TEXT_MAX_CHARS` | withVideo 任务最大口播字数（对应音频 ≤15s，P4 标定） | `60` |

---

## 5. 目录结构增量

```
human-lab/
├─ apps/server/src/
│  ├─ capabilities/
│  │  ├─ lipsync.ts          # 新增：wan3.0 口播视频能力（含 prompt 模板）
│  │  ├─ upload.ts           # 新增：百炼临时文件上传（免 OSS）
│  │  └─ …
│  ├─ tasks.ts               # 修改：runTask 支持 withVideo 流水线（stage 回写）
│  ├─ db.ts                  # 修改：tasks 表加 video_path/stage 列 + 迁移
│  └─ config.ts              # 修改：wan3.0/形象配置解析
├─ apps/web/src/
│  ├─ SpeakPanel.tsx         # 修改：withVideo 开关 + <video> 播放 + 阶段文案
│  └─ App.css                # 修改：video 样式 + AI 角标
├─ packages/shared/src/types.ts  # 修改：TaskView.stage/videoUrl、SpeakRequest.withVideo
├─ assets/avatars/default/   # 新增：形象资产（image.png gitignore，AI 生图获得）
├─ lego/04-lipsync/          # 新增：talk-probe.mjs（探测）+ talk-cli.mjs（CLI 演示）
└─ output/                   # 产物：output/talking-<taskId>.mp4
```

---

## 6. 里程碑

| 里程碑 | 内容 | 预估 | 验收标准 |
|---|---|---|---|
| **M1 探测** | `lego/04-lipsync/talk-probe.mjs` 跑通 P1~P5，产出第一条口播视频，结论回填 §3.6 | 0.5 天 | 60 字中文口播稿 → 形象图人物开口播报，口型可辨同步、音色为 TTS 原声 |
| **M2 能力层** | `capabilities/lipsync.ts` + `upload.ts` + `talk-cli.mjs`（`npm run talk`） | 0.5~1 天 | 命令行一条命令：形象图 + 本地音频 → 本地 mp4 |
| **M3 服务化** | `/api/speak withVideo` 流水线、tasks 表变更、`stage/videoUrl` 出参 | 0.5~1 天 | curl 提交 → 轮询到 done → `/media/talking-*.mp4` 可下载 |
| **M4 前端** | withVideo 开关、`<video>` 播放、阶段文案、AI 角标 | 0.5 天 | 网页输入口播稿 → 看到数字人口播 |
| **M5 打磨（可选）** | 商品图带货模板（§3.4 变体）、长稿切段拼接、720P、多形象 | — | 按需 |

---

## 7. 风险与合规

- **口型精度风险（最大不确定项）**：wan3.0 的「图+音频」是全能参考驱动，非专门口型模型，逐字对齐精度需 P3 实测；不达标切 wan2.2-s2v（Provider 已预留，编排层零改动）
- **形象一致性风险**：全能参考可能出现换装/发色漂移 → prompt 模板强约束「形象服装发型完全一致」+ probe 验收
- **音频 15s 上限**：口播稿一次约 60 字 → 提交时前置拦截（P4 标定）；长稿切段拼接列入 M5
- **延迟与排队**：生成 1~5 分钟（prime 已提速）→ 阶段文案管理预期；连续提交自动排队
- **成本**：480P 约 ¥0.45/秒（待对账），一条 15s ≈ ¥6.75 → 调试期先纯音频试听文案再勾选视频；`usage.duration` 落任务记录对账
- **肖像与审核**：MVP 用 AI 生图脸；云端对人物形象有审核，不通过给可读错误不重试
- **深度合成合规**：前端「AI 生成」显式角标（`watermark` 参数保持 false，用自己的标识）；对境内公众提供服务前完成隐式标识与备案评估
- **结果时效**：video_url/task_id 24h 失效 → 轮询成功后立即下载转存
- **选型兜底链**：wan3.0-video-prime → wan3.0-video（标准版）→ wan2.2-s2v（专门口型）→ 本地 SadTalker（Python 子进程）

---

## 8. 参考资料

- 万相3.0 视频生成 API 参考（全能参考/素材组合/参数）：<https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference>
- 数字人 wan2.2-s2v 视频生成 API（降级兜底）：<https://help.aliyun.com/zh/model-studio/wan-s2v-api>
- 上传本地文件获取临时 URL（免 OSS）：<https://docs.bailian.console.aliyun.com>（百炼文档「文件上传」章节）
- 万相 3.0 发布公告（30s/1080P/原生音画/多模态参考）：<https://www.aliyun.com/product/news/30378>
- 后续实时化参考（远期）：MuseTalk <https://github.com/TMElyralab/MuseTalk> · LiveTalking <https://github.com/lipku/LiveTalking> · OpenAvatarChat <https://github.com/HumanAIGC/OpenAvatarChat>
