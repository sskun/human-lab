// ASR 能力：语音 → 文字（DashScope multimodal-generation HTTP 协议直连，不依赖官方 SDK）
//
// 请求（POST，探测结论见 docs/asr-design.md §2）：
//   headers: Authorization Bearer / Content-Type json / X-DashScope-SSE: disable
//   body: { model, input.messages[0].content[0] =
//           { type:"input_audio", input_audio:{ data: <URL 或 data:audio/xxx;base64,..> } },
//           parameters: { format } }          ← format 必填；sample_rate 可省略且写错也能自动兼容
// 响应 200：
//   { sentence:{ text, words:[{begin_time,end_time,text,punctuation}], ... },
//     text, request_id, output:{...重复包裹}, usage:{ duration(=音频秒数), input_tokens, ... } }
// 错误：400 { code:"DECODE_ERROR"|"FILE_DOWNLOAD_FAILED"|..., message }
//
// 传音频的三种方式（实测均支持）：
//   1. 公网 URL 直接填 data（文档标准用法）
//   2. base64 data URI 内联（无需 OSS：`data:audio/mpeg;base64,...`，裸 base64 会被当 URL 解析而报错）
//   3. 本地文件路径 —— 由本模块读文件后转第 2 种
import fs from 'node:fs';
import { loadDotEnv, resolveASRConfig, type ASRConfig } from '../config.js';

export { loadDotEnv, resolveASRConfig } from '../config.js';
export type { ASRConfig } from '../config.js';

/** words[] 中的一个词元（中文按字/词切分，毫秒时间戳） */
export interface ASRWord {
  begin_time: number;
  end_time: number;
  text: string;
  punctuation: string;
  fixed: boolean;
  speaker_id: string | null;
}

/** sentence 对象：非流式模式下整段音频合并为一个（长音频也一样） */
export interface ASRSentence {
  sentence_id: number;
  begin_time: number;
  end_time: number;
  text: string;
  channel_id: number;
  speaker_id: string | null;
  sentence_end: boolean;
  words: ASRWord[];
}

export interface ASRUsage {
  /** 音频时长（秒）——即服务端计费口径 */
  duration?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/** 一次识别的结果 */
export interface ASRResult {
  /** 全文（带标点）；纯静音等场景可能为空字符串 */
  text: string;
  /** 原始 sentence 对象（含字级时间戳），识别不出内容时为 null */
  sentence: ASRSentence | null;
  usage: ASRUsage | null;
  requestId: string;
}

/** format（音频封装格式）→ data URI 的 MIME 类型；服务端会自动探测实际格式，MIME 不敏感 */
const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  opus: 'audio/opus',
  webm: 'audio/webm',
};

/** 从文件扩展名推断音频封装格式（用于 parameters.format 与 MIME），未知扩展名回退 wav */
function formatFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_FORMAT[ext] ? ext : 'wav';
}

export class DashScopeASR {
  constructor(private cfg: ASRConfig & { timeoutMs?: number }) {
    if (!cfg.apiKey) throw new Error('apiKey 不能为空：请通过环境变量 DASHSCOPE_API_KEY 或配置对象传入');
    if (!cfg.model) throw new Error('model 不能为空');
    if (!cfg.url) throw new Error('url 不能为空');
  }

  /**
   * 识别一段音频。
   * @param input 公网 URL、本地文件路径、或音频二进制（Buffer）
   * @param opts.format 音频封装格式（mp3/wav/...）；不传时：URL 回退 wav，Buffer 回退 wav，文件按扩展名推断。
   *                    服务端会自动探测真实格式，这里只是必填参数的"声明值"。
   */
  async recognize(input: string | Buffer, opts: { format?: string } = {}): Promise<ASRResult> {
    let data: string;
    let format = opts.format;
    if (Buffer.isBuffer(input)) {
      data = toDataUri(input, format);
    } else if (/^https?:\/\//i.test(input)) {
      data = input; // 公网 URL 直接透传
    } else {
      const buf = fs.readFileSync(input); // 不存在会抛 ENOENT，属于调用方输入错误
      format = format ?? formatFromPath(input);
      data = toDataUri(buf, format);
    }

    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'disable',
      },
      body: JSON.stringify({
        model: this.cfg.model,
        input: {
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data } }] }],
        },
        parameters: { format: format ?? 'wav' },
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
    });

    const body = (await res.json().catch(() => null)) as
      | {
          text?: string;
          sentence?: ASRSentence;
          request_id?: string;
          usage?: ASRUsage;
          code?: string;
          message?: string;
        }
      | null;

    if (!res.ok) {
      const code = body?.code ?? `HTTP ${res.status}`;
      throw new Error(`ASR 失败 ${code}: ${body?.message ?? res.statusText}`);
    }

    return {
      text: body?.text ?? body?.sentence?.text ?? '',
      sentence: body?.sentence ?? null,
      usage: body?.usage ?? null,
      requestId: body?.request_id ?? '',
    };
  }
}

/** Buffer → base64 data URI（裸 base64 会被服务端当 URL 解析，前缀必须带） */
function toDataUri(buf: Buffer, format?: string): string {
  const mime = MIME_BY_FORMAT[format ?? ''] ?? 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 一行调用语音识别能力（自动加载 .env 配置；能力层保持纯粹，不写数据库——
 * "记录任务"是调用方（server tasks.ts）的编排职责）。
 *
 * @param input 音频来源：公网 URL / 本地文件路径 / Buffer
 * @param opts.config 覆盖配置（如 { model: 'qwen-audio-3.1-asr-flash' }）
 * @param opts.format 音频封装格式；不传则按文件扩展名推断，最终由服务端兜底探测
 *
 * @example
 *   import { recognizeSpeech } from './capabilities/asr.js';
 *   const { text, usage } = await recognizeSpeech('output/tts-xxx.mp3');
 */
export async function recognizeSpeech(
  input: string | Buffer,
  opts: { config?: Partial<ASRConfig>; format?: string } = {},
): Promise<ASRResult> {
  loadDotEnv();
  const config = { ...resolveASRConfig(), ...opts.config };
  const asr = new DashScopeASR(config);
  return asr.recognize(input, { format: opts.format });
}
