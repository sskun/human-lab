# 数字人 MVP 设计文档 —— 文本驱动的口型播报数字人

> 版本 v0.1 · 2026-09-27
> 一句话目标：输入一段文字 → 数字人（一张正脸照片）开口朗读，口型与语音同步，在网页上播放。

---

## 1. 目标与非目标

**MVP 目标**

- 输入一段中文文字（几十 ~ 几百字）
- 系统合成语音，并驱动一个固定的数字人形象（先只支持一张正面照片）
- 网页点击播放，看到"照片开口说话"，音画同步
- 离线合成为主：单次生成端到端可接受 10 秒 ~ 2 分钟延迟

**本期不做（非目标）**

- 实时交互对话（流式 TTS + 流式口型 + WebRTC）
- 声音克隆、情绪控制、肢体/半身动作生成
- 多形象管理、用户体系、高并发

---

## 2. 需要哪些能力（能力拆解）

整条链路只有 **两个核心 AI 能力**，其余都是普通工程：

```
文本 ──① TTS──> audio.wav ──┐
                             ├──② 音频驱动口型──> talking.mp4 ──③ 网页播放
形象（照片/视频）────────────┘
```

| # | 能力 | 作用 | MVP 选型建议 | 后续可升级 |
|---|------|------|--------------|------------|
| ① | **TTS 文本转语音** | 文字 → 语音 | edge-tts（免费）/ 百炼 CosyVoice·Qwen-TTS | 声音克隆：GPT-SoVITS、IndexTTS2 |
| ② | **音频驱动口型**（audio-driven talking head / lip sync） | 形象 + 音频 → 说话视频 | SadTalker（一张照片）或 MuseTalk（快）；云端用百炼 EMO | LatentSync（质量更高）、EchoMimicV3、HunyuanVideo-Avatar |
| ③ | 播放端 | 展示 | 静态 HTML `<video>` | 字幕、流式播放 |
| ④ | 服务编排 | 串流程、异步任务 | FastAPI + SQLite 任务表 + 轮询 | Celery/Redis、WebSocket 推送 |
| ⑤ | 形象资产 | 说话的"人" | 一张正脸照片（≥512px，正脸、闭嘴、背景简洁） | 自拍视频、多形象库 |

---

## 3. 技术路线对比与推荐

### 路线 A：全云端 API（零 GPU，最快 1~2 天跑通）

- **推荐：阿里云百炼一个 API-Key 覆盖全链路**
  - TTS：`qwen-tts` / `cosyvoice`（百炼模型广场开通）
  - 口型视频：`EMO视频生成API`（肖像图 + 人声音频 → 动态人脸视频，异步任务接口，仅北京地域）或更轻量的 `LivePortrait API`
  - 注意：EMO 输入是 `image_url` / `audio_url`（公网可访问 URL），需要配一个对象存储（OSS）放照片和音频
- 国际替代组合：任一 TTS（OpenAI / MiniMax / 火山）+ **Sync（sync.so）lipsync API** 或 D-ID / HeyGen 平台型 API

### 路线 B：本地开源模型（免费可控，需 NVIDIA GPU）

- TTS：先用 **edge-tts**（免费、无需申请、中文音色好）联调；正式版换 **CosyVoice2**（开源，可本地部署）
- 口型（按"最简单"排序）：
  - **SadTalker**：单张照片 + 音频 → 说话视频（含头部微动），部署简单、显存低、教程多，MVP 首选
  - **MuseTalk 1.5**（MIT 协议）：嘴部 inpainting，3090 上接近实时，适合后续做实时直播
  - **LatentSync 1.6**（Apache-2.0，字节）：扩散模型，512×512 口型质量最好，但慢、显存要求高
- 无本地 GPU 时：租云 GPU（AutoDL 等平台 4090 约 ¥2/小时）跑通后再决定要不要自购

### 路线 C：极简 2D 嘴型切换（仅适合卡通形象，无需 GPU）

- 用 Rhubarb Lip Sync（开源）从音频提取音素时间戳，前端按时间戳切换 10~20 张嘴型贴图
- 成本几乎为零，但只适合 2D/卡通形象，真人照片不适用

### 对比

| 维度 | A 云端 API | B 本地开源 | C 2D 嘴型 |
|------|-----------|-----------|-----------|
| 跑通时间 | 1~2 天 | 2~5 天 | 1 天 |
| 硬件 | 无 | NVIDIA GPU ≥8GB | 无 |
| 成本 | 按量付费（量级：TTS ¥0.5~3/万字符，口型视频按条/按分钟，以官网为准） | 电费/GPU 租金 | ≈0 |
| 效果 | 好（EMO 很自然） | SadTalker 中等 / MuseTalk 好 | 卡通风格 |
| 数据出域 | 是（音频、照片上传云端） | 否 | 否 |
| 主要风险 | 需对象存储、内容审核 | 环境踩坑、显存不足 | 不适合真人 |

### 推荐结论

- **没有 GPU / 想最快看到效果** → 路线 A：百炼一个 Key 走全链路
- **有 NVIDIA GPU（≥8GB）** → 路线 B：edge-tts + SadTalker（或 MuseTalk）
- 两种路线在后端里做成 **可切换的 Provider**（见 §4），接口不变，先跑通一条，另一条随时补

---

## 4. 系统设计

### 4.1 架构

```
浏览器(index.html)                        后端(FastAPI, 单机)
 ┌──────────────┐   POST /api/speak      ┌─────────────────────┐
 │ 文本框+按钮    │ ─────────────────────> │ 任务表(SQLite) 入队   │
 │              │                        └──────┬──────────────┘
 │  轮询         │   GET /api/tasks/{id}         │ 后台线程依次执行
 │  GET /api/.. │ <─────────────────────        ├─ TTSProvider.synthesize(text)  → audio.wav
 │              │                               └─ LipSyncProvider.generate(照片, wav) → mp4
 │ <video> 播放  │ <──── GET /videos/{id}.mp4 ── 静态目录
 └──────────────┘
```

### 4.2 接口定义

```
POST /api/speak          提交任务
  请求  { "text": "你好，我是数字人。", "voice": "default" }
  响应  202 { "task_id": "t_abc123" }

GET /api/tasks/{task_id} 查询任务
  响应  { "status": "queued|tts|lipsync|done|failed",
          "video_url": "/videos/t_abc123.mp4" | null,
          "error": null }

GET /videos/{task_id}.mp4   静态文件
```

MVP 用「提交 + 轮询」而非 WebSocket，实现最简单；status 中间态（tts / lipsync）顺便展示了流水线进度。

### 4.3 Provider 抽象（两条路线可切换的关键）

```python
class TTSProvider(Protocol):
    def synthesize(self, text: str, out_wav: str) -> None: ...

class LipSyncProvider(Protocol):
    def generate(self, avatar_path: str, audio_wav: str, out_mp4: str) -> None: ...
```

实现对应关系：

| Provider 实现 | 对应路线 |
|---|---|
| `tts/edge_tts.py`、`tts/bailian_tts.py` | A / B |
| `lipsync/sadtalker.py`、`lipsync/musetalk.py` | B |
| `lipsync/emo_api.py`（百炼 EMO） | A |
| `lipsync/sync_api.py`（sync.so，可选） | A |

用环境变量/配置文件切换：`TTS_PROVIDER=edge|bailian`、`LIP_PROVIDER=sadtalker|musetalk|emo`。

### 4.4 目录结构（实际落地，标准 monorepo）

```
human-lab/
├─ apps/
│  ├─ server/             # Express + TS（:3001）：POST /api/speak、GET /api/tasks/:id、/media 静态
│  │  └─ src/
│  │     ├─ index.ts / tasks.ts          # HTTP 入口 + 任务编排
│  │     ├─ capabilities/tts.ts          # TTS 能力（DashScope tts_v2 ws 协议）✅
│  │     ├─ db.ts                        # SQLite（data/human-lab.db，node:sqlite 零依赖）
│  │     └─ config.ts                    # OUTPUT_DIR / DATA_DIR / .env 加载
│  └─ web/                # Vite + React + TS（:5173，/api、/media 代理到 3001）
│     └─ src/{App.tsx, main.tsx}
├─ packages/
│  └─ shared/             # @human-lab/shared：server/web 共享的 API 契约（纯类型，零依赖）
│     └─ src/types.ts
├─ lego/                  # 各能力的可运行演示块（lego/01-tts/...，引 server 的 dist）
├─ data/                  # SQLite 数据库
├─ output/                # 生成的语音/视频文件
├─ docs/design.md         # 本文档
└─ .env                   # 密钥配置（gitignore）
```

> 分层依据：`shared` 只放跨 app 的类型契约（行业惯例）；能力与存储的消费方目前仅 server，故内聚在其 `src/capabilities/` 与 `db.ts`。出现第二个服务端消费方（如独立 worker）时再抽 `packages/core`。
> 云端 API 路线全链路用 Node/TS（无官方 Node SDK 的部分直接实现协议）；若走本地开源模型路线，Python 侧作为独立进程被 Node 调度。

---

## 5. 选型清单（模型/服务明细）

### TTS

| 方案 | 类型 | 成本 | 备注 |
|---|---|---|---|
| edge-tts | 开源库（非官方微软接口） | 免费 | 无需 Key，中文音色好，MVP 联调首选；商用需替换 |
| CosyVoice2/3 | 开源（阿里 FunAudioLLM） | 免费（需 GPU） | 效果好，可本地部署；百炼/硅基流动也提供同名 API |
| Qwen-TTS / 豆包TTS / MiniMax / 讯飞 | 商用 API | 按量 | 中文效果好，申请 Key 即用 |
| GPT-SoVITS / IndexTTS2 | 开源 | 免费 | 声音克隆（后期升级用） |

### 音频驱动口型

| 方案 | 类型 | 输入 | 显存 | 速度 | 质量 | 协议/备注 |
|---|---|---|---|---|---|---|
| SadTalker | 开源 | **一张照片** + 音频 | ~6GB | 慢（分钟级） | 中 | 最简单、只需照片；维护放缓 |
| Wav2Lip | 开源 | 视频/照片 + 音频 | ~2GB | 快 | 低（嘴部糊，可配 GFPGAN 超分） | 经典兜底方案 |
| MuseTalk 1.5 | 开源 | 视频/形象 + 音频 | 8~16GB | 接近实时 | 好 | MIT；后续实时直播的底座 |
| LatentSync 1.6 | 开源（字节） | 视频 + 音频 | 16GB+ | 慢 | 优 | Apache-2.0；512×512 口型清晰 |
| EchoMimicV3 / HunyuanVideo-Avatar | 开源 | 照片 + 音频 | 高（多卡级） | 很慢 | 优 | 半身/全身动画，MVP 不建议 |
| 百炼 EMO | 云 API | 肖像图 URL + 音频 URL | 无 | 异步任务 | 优 | 一个百炼 Key；需配 OSS |
| 百炼 LivePortrait | 云 API | 肖像图 + 音频 | 无 | 快 | 中 | EMO 的轻量便宜替代 |
| Sync(sync.so) / D-ID / HeyGen | 云 API | 视频/照片 + 音频 | 无 | 快 | 好 | 国际服务，按分钟计费 |

---

## 6. 需要申请 / 准备的事项（直接照着做）

**选路线 A（云端）**

- [ ] 注册阿里云百炼，创建 **API-Key**（TTS + EMO/LivePortrait 都用它；服务地域选北京）
- [ ] 开通 OSS（EMO 的输入是公网 URL，照片/音频要先传上去，MVP 可用带签名的临时 URL）
- [ ] 准备形象照片一张（详见下）
- [ ] （可选备选）国际：OpenAI/MiniMax TTS Key + sync.so / D-ID 账号

**选路线 B（本地）**

- [ ] 一块 NVIDIA GPU：≥8GB 显存（SadTalker/MuseTalk）；没有就租 AutoDL 4090（约 ¥2/小时）
- [ ] Python 3.10 + CUDA 环境；从 GitHub/ModelScope 下载模型权重（SadTalker checkpoints 或 MuseTalk 权重，国内走 ModelScope 更快）
- [ ] edge-tts：`pip install edge-tts`，无需任何申请
- [ ] 准备形象照片一张

**形象照片要求（两条路线通用）**

- 正脸、正对镜头、光线均匀、嘴巴自然闭合、背景简洁
- 分辨率 ≥512×512，单人，不遮挡嘴部
- ⚠️ 必须是自己或已获授权的人；云端 API 会拒绝名人/公众人物照片

---

## 7. 里程碑

| 里程碑 | 内容 | 预估 | 验收标准 |
|---|---|---|---|
| M1 | TTS 跑通：命令行 文本 → wav | 0.5 天 | 能听到合成的中文语音 |
| M2 | 口型跑通：固定照片 + wav → mp4 | 1~3 天 | 生成的视频口型明显同步 |
| M3 | 服务化 + 前端：FastAPI 两个接口 + 静态页轮询播放 | 1~2 天 | 网页输入文字 → 看到数字人说话 |
| M4 | 打磨（可选） | 2~3 天 | 换更好音色/克隆声音、多形象、卡拉OK式字幕、延迟优化 |
| M5 | 进阶（远期） | — | 实时流式对话（LiveTalking / OpenAvatarChat 路线） |

---

## 8. 风险与合规

- **中文口型精度**：多数模型英文语料训练为主，中文口型整体可用但细节（圆唇/翘舌）稍弱；EMO、MuseTalk 中文表现较好
- **延迟与排队**：本地 SadTalker 一段话生成约 1~5 分钟；MVP 用任务队列 + 轮询兜住体验
- **显存不足**：降级到 Wav2Lip，或切路线 A
- **内容审核**：云端 API 对肖像有审核，名人照片会被拒
- **肖像权**：使用他人形象必须有授权
- **深度合成合规**：若对境内公众提供服务，需遵守《互联网信息服务深度合成管理规定》和《人工智能生成合成内容标识办法》（2025-09-01 施行）——输出视频要加显式标识（如"AI生成"角标）与隐式标识（元数据水印）；规模化商用需按平台要求完成备案
- **开源协议**：MuseTalk（MIT）、LatentSync（Apache-2.0）商用友好；每个仓库商用前再核对权重许可

---

## 9. 参考资料

- SadTalker：<https://github.com/OpenTalker/SadTalker>
- MuseTalk：<https://github.com/TMElyralab/MuseTalk>
- LatentSync：<https://github.com/bytedance/LatentSync>
- Wav2Lip：<https://github.com/Rudrabha/Wav2Lip>
- EchoMimic（蚂蚁）：<https://github.com/antgroup/echomimic_v2>
- HunyuanVideo-Avatar（腾讯混元）：<https://github.com/Tencent-Hunyuan/HunyuanVideo-Avatar>
- CosyVoice：<https://github.com/FunAudioLLM/CosyVoice>
- GPT-SoVITS：<https://github.com/RVC-Boss/GPT-SoVITS>
- IndexTTS：<https://github.com/index-tts/index-tts>
- edge-tts：<https://github.com/rany2/edge-tts>
- 实时框架 LiveTalking：<https://github.com/lipku/LiveTalking> · OpenAvatarChat：<https://github.com/HumanAIGC/OpenAvatarChat>
- 阿里云百炼（模型广场搜「EMO视频生成」「LivePortrait」「qwen-tts」）：<https://help.aliyun.com/zh/model-studio/>
- Sync(sync.so)：<https://sync.so> · D-ID：<https://docs.d-id.com> · HeyGen：<https://docs.heygen.com>
- Rhubarb Lip Sync（2D 路线）：<https://github.com/DanielSWolf/rhubarb-lip-sync>
