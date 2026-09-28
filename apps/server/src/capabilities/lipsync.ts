// 口播视频能力：wan3.0-video-prime 全能参考（音频驱动）——形象图 + TTS 音频 → 数字人口播 mp4
//
// 属于 server 的"能力层"：只负责生成、不碰数据库不碰 HTTP 路由（任务记录由 tasks.service 编排写入）。
// 协议（docs/lipsync-design.md §3.2，官方 wan3.0 API 文档）：
//   创建  POST {base}/services/aigc/video-generation/video-synthesis
//         X-DashScope-Async: enable
//         input: { prompt, media: [reference_image(形象图[+商品图]), reference_audio(TTS音频)] }
//         parameters: { resolution, ratio, duration, audio:true, prompt_extend, watermark:false }
//         → output.task_id
//   查询  GET {base}/tasks/{task_id}   （官方建议 15s 间隔，task_id/video_url 均 24h 有效）
//         → output.task_status: PENDING|RUNNING|SUCCEEDED|FAILED|CANCELED|UNKNOWN
//           SUCCEEDED 时 output.video_url + usage{duration,fps,SR,ratio}
//
// 关键约束：reference_audio 单段 [1,15]s（→ 口播稿约 60 字，LIPSYNC_TEXT_MAX_CHARS 前置拦截）。
// 素材 URL 支持 oss:// 临时 URL（capabilities/upload.ts 产出）与公网 https；图像另支持 Base64 data URI。
import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR, loadDotEnv, resolveTalkConfig, type TalkConfig } from '../config.js';
import { getUploadPolicy, uploadToTempStore, type HttpDeps } from './upload.js';

// CLI（lego/04-lipsync）直接引构建产物时会用到这几个配置工具，一并从这里导出
export { loadDotEnv, resolveTalkConfig } from '../config.js';
export type { TalkConfig } from '../config.js';

/** 可注入依赖（单元测试 mock fetch/ sleep 用，见 tests/lipsync.test.ts） */
export interface TalkDeps extends HttpDeps {
  /** 轮询等待（默认真实 setTimeout；测试注入 no-op 提速） */
  sleep?: (ms: number) => Promise<void>;
}

/** 口播 prompt 模板（§3.4）：口播稿不进 prompt——内容由 reference_audio 承载，prompt 只描述镜头行为 */
export function buildTalkPrompt(opts: { product?: boolean } = {}): string {
  return opts.product
    ? '图1是数字人主播的形象照，图2是本次介绍的商品。' +
        '生成一段竖屏带货口播视频：图1中的人物面对镜头介绍图2的商品，按照音频1中的语音逐句播报，' +
        '口型与音频1精确同步；讲到商品时展示图2的商品（手持或陈列在画面一侧），' +
        '保持图1人物形象一致，表情自然亲和，节奏明快，电商带货风格，无字幕。'
    : '图1是数字人主播的形象照。生成一段竖屏口播视频：图1中的人物正面面对镜头，' +
        '保持图1的形象、服装、发型与背景完全一致，按照音频1中的语音逐句播报，' +
        '口型与音频1精确同步，表情自然亲和，眼神看向镜头，伴随轻微的手势与头部动作，' +
        '光线柔和，画面稳定，专业口播主播风格，无字幕。';
}

/** 任务查询响应里我们关心的 usage 字段 */
export interface WanTalkUsage {
  video_count?: number;
  /** 计费口径（秒） */
  duration?: number;
  output_video_duration?: number;
  fps?: number;
  SR?: number;
  ratio?: string;
}

/** 一次生成的结果 */
export interface TalkingVideoResult {
  video: Buffer;
  bytes: number;
  /** usage.duration（计费口径，秒） */
  durationSec: number | null;
  fps: number | null;
  ratio: string | null;
  /** wan3.0 任务 id（排障/对账用） */
  remoteTaskId: string;
  usage: WanTalkUsage | null;
}

interface TaskOutput {
  task_id?: string;
  task_status?: string;
  video_url?: string;
  code?: string;
  message?: string;
}

export class WanTalkVideo {
  constructor(
    private cfg: TalkConfig,
    private deps: TalkDeps = {},
  ) {
    if (!cfg.apiKey) throw new Error('apiKey 不能为空：请通过环境变量 DASHSCOPE_API_KEY 或配置对象传入');
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private get sleep(): (ms: number) => Promise<void> {
    return this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request(url: string, init: RequestInit): Promise<{ output: TaskOutput; usage?: WanTalkUsage }> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
        // media.url 里的 oss://dashscope-instant/ 临时 URL 需要这个头才会在服务端解析为
        // https（实测 2026-09-28：缺它报 "media.url scheme must be http/https, got: 'oss'"）
        'X-DashScope-OssResourceResolve': 'enable',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    let json: { output?: TaskOutput; usage?: WanTalkUsage; message?: string; code?: string };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`wan3.0 响应非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    if (!res.ok) {
      throw new Error(`wan3.0 请求失败（HTTP ${res.status}）：${json.code ?? ''} ${json.message ?? text.slice(0, 200)}`);
    }
    return { output: json.output ?? {}, usage: json.usage };
  }

  /**
   * 创建口播视频生成任务（异步）。
   * @param input.imageUrl 形象图（oss:// 临时 URL / 公网 https / Base64 data URI）
   * @param input.productImageUrl 商品图（带货模板，作为第二张 reference_image）
   * @param input.prompt 缺省用内置口播模板（buildTalkPrompt）
   */
  async createTask(input: {
    imageUrl: string;
    audioUrl: string;
    productImageUrl?: string;
    prompt?: string;
  }): Promise<{ taskId: string }> {
    const media: Array<{ type: string; url: string }> = [
      { type: 'reference_image', url: input.imageUrl },
      ...(input.productImageUrl ? [{ type: 'reference_image', url: input.productImageUrl }] : []),
      { type: 'reference_audio', url: input.audioUrl },
    ];
    const prompt = input.prompt ?? buildTalkPrompt({ product: Boolean(input.productImageUrl) });
    const { output } = await this.request(`${this.cfg.baseUrl}/services/aigc/video-generation/video-synthesis`, {
      method: 'POST',
      headers: { 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({
        model: this.cfg.model,
        input: { prompt, media },
        parameters: {
          resolution: this.cfg.resolution,
          ratio: this.cfg.ratio,
          duration: this.cfg.duration,
          audio: true,
          prompt_extend: this.cfg.promptExtend,
          watermark: false,
        },
      }),
    });
    if (output.code) throw new Error(`wan3.0 创建任务失败：${output.code} ${output.message ?? ''}`.trim());
    if (!output.task_id) throw new Error(`wan3.0 创建任务未返回 task_id：${JSON.stringify(output).slice(0, 300)}`);
    return { taskId: output.task_id };
  }

  /** 查询一次任务状态（不等待；轮询循环见 generate） */
  async pollTask(taskId: string): Promise<{ status: string; videoUrl?: string; usage: WanTalkUsage | null }> {
    const { output, usage } = await this.request(`${this.cfg.baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
    });
    return {
      status: output.task_status ?? 'UNKNOWN',
      videoUrl: output.video_url,
      usage: usage ?? null,
    };
  }

  /** 下载生成结果（video_url 仅 24h 有效，调用方应及时转存） */
  private async download(url: string): Promise<Buffer> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`视频下载失败（HTTP ${res.status}）`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * 完整生成：创建任务 → 按间隔轮询至终态 → 下载视频。
   * @throws FAILED/CANCELED/UNKNOWN 终态、轮询超时（cfg.timeoutMs）
   */
  async generate(input: { imageUrl: string; audioUrl: string; productImageUrl?: string; prompt?: string }): Promise<TalkingVideoResult> {
    const { taskId } = await this.createTask(input);
    const deadline = Date.now() + this.cfg.timeoutMs;

    for (;;) {
      const { status, videoUrl, usage } = await this.pollTask(taskId);
      if (status === 'SUCCEEDED') {
        if (!videoUrl) throw new Error('wan3.0 任务成功但未返回 video_url');
        const video = await this.download(videoUrl);
        return {
          video,
          bytes: video.length,
          durationSec: usage?.duration ?? null,
          fps: usage?.fps ?? null,
          ratio: usage?.ratio ?? null,
          remoteTaskId: taskId,
          usage,
        };
      }
      if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
        // 失败详情在 task 查询的 output.code/message 里，重查一次拿原因
        const { output } = await this.request(`${this.cfg.baseUrl}/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' });
        throw new Error(`wan3.0 任务${status === 'FAILED' ? '失败' : `异常（${status}）`}：${output.code ?? ''} ${output.message ?? ''}`.trim());
      }
      if (Date.now() > deadline) {
        throw new Error(`wan3.0 任务超时（>${Math.round(this.cfg.timeoutMs / 1000)}s）：taskId=${taskId}，最后状态 ${status}`);
      }
      await this.sleep(this.cfg.pollIntervalMs);
    }
  }
}

/** 未指定输出路径时的默认文件名：<OUTPUT_DIR>/talking-YYYYMMDDHHMMSS.mp4 */
function defaultOutFile(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return path.join(OUTPUT_DIR, `talking-${ts}.mp4`);
}

/**
 * 一行调用口播视频能力（自动加载 .env 配置）：本地图 + 本地音频 → 本地 mp4。
 * 内部流程：上传形象图/音频取 oss:// 临时 URL → 创建 wan3.0 任务 → 轮询 → 下载转存。
 * 注意：本函数不写数据库——"记录任务"是调用方（tasks.service）的编排职责，能力层保持纯粹。
 *
 * @param opts.imagePath 形象图路径（如 assets/avatars/default/image.png）
 * @param opts.audioPath 音频路径（如 output/tts-<id>.mp3；须 [1,15]s）
 * @param opts.productImagePath 商品图路径（可选，带货模板）
 * @param opts.out 输出文件路径；缺省写 output/talking-<时间戳>.mp4
 * @param opts.config 覆盖配置（如 { resolution: '720P' }）
 *
 * @example
 *   import { generateTalkingVideo } from './capabilities/lipsync.js';
 *   const { outFile, durationSec } = await generateTalkingVideo({ imagePath, audioPath });
 */
export async function generateTalkingVideo(
  opts: {
    imagePath: string;
    audioPath: string;
    productImagePath?: string;
    out?: string;
    config?: Partial<TalkConfig>;
  } & TalkDeps,
): Promise<TalkingVideoResult & { outFile: string }> {
  loadDotEnv();
  const config: TalkConfig = { ...resolveTalkConfig(), ...opts.config };
  const client = new WanTalkVideo(config, { fetchImpl: opts.fetchImpl, sleep: opts.sleep });

  const image = fs.readFileSync(opts.imagePath);
  const audio = fs.readFileSync(opts.audioPath);

  // 形象图也可走 Base64 直传，但为统一与省带宽，图/音频都走临时上传通道
  const policy = await getUploadPolicy({
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.uploadsBaseUrl,
    fetchImpl: opts.fetchImpl,
  });
  const imageUrl = await uploadToTempStore(image, path.basename(opts.imagePath), { policy, fetchImpl: opts.fetchImpl });
  const audioUrl = await uploadToTempStore(audio, path.basename(opts.audioPath), { policy, fetchImpl: opts.fetchImpl });

  const result = await client.generate({
    imageUrl,
    audioUrl,
    productImageUrl: opts.productImagePath
      ? await uploadToTempStore(fs.readFileSync(opts.productImagePath), path.basename(opts.productImagePath), {
          policy,
          fetchImpl: opts.fetchImpl,
        })
      : undefined,
  });

  const out = path.resolve(opts.out ?? defaultOutFile());
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, result.video);
  return { ...result, outFile: out };
}
