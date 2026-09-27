// TTS 能力：文本 → 语音（DashScope tts_v2 WebSocket 协议直连，不依赖官方 SDK）
//
// 属于 server 的"能力层"：只负责合成、不碰数据库不碰 HTTP——任务记录由 tasks.ts 编排时写入。
// （若未来出现第二个服务端消费方，如独立合成 worker，再把本文件抽成 packages/core。）
//
// ws 协议（对照官方 Python SDK dashscope/audio/tts_v2/speech_synthesizer.py）：
//   run-task      header{action,task_id,streaming:"duplex"} payload{model,task_group:"audio",task:"tts",
//                 function:"SpeechSynthesizer",input:{},parameters:{voice,volume,text_type,sample_rate,
//                 rate,format,pitch,seed,type,enable_ssml}}
//   task-started  ←服务端
//   continue-task payload{model,task_group,task,function,input:{text}}
//   finish-task   payload{input:{}}
//   ←二进制音频帧 / result-generated / task-finished / task-failed
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { OUTPUT_DIR, loadDotEnv, resolveTTSConfig, type TTSConfig } from '../config.js';

// CLI（lego/01-tts）直接引构建产物时会用到这几个配置工具，一并从这里导出
export { loadDotEnv, findEnvFile, resolveTTSConfig } from '../config.js';
export type { TTSConfig } from '../config.js';

/** 一次合成的结果 */
export interface SynthesizeResult {
  audio: Buffer;
  bytes: number;
  usage: unknown;
  taskId: string;
}

export class DashScopeTTS {
  constructor(
    // apiKey 等在运行时校验（见下），类型上保持宽松以便直接传入 resolveTTSConfig() 的结果
    private cfg: TTSConfig & {
      volume?: number;
      rate?: number;
      pitch?: number;
      seed?: number;
      timeoutMs?: number;
    },
  ) {
    if (!cfg.apiKey) throw new Error('apiKey 不能为空：请通过环境变量 DASHSCOPE_API_KEY 或配置对象传入');
    if (!cfg.voice) throw new Error('voice 不能为空');
  }

  /**
   * 合成语音。
   * @param text 待合成文本
   * @param opts.onAudio 传入时可边合成边消费流式音频（做实时播放用）
   */
  synthesize(text: string, opts: { onAudio?: (chunk: Buffer) => void } = {}): Promise<SynthesizeResult> {
    if (!text || !text.trim()) return Promise.reject(new Error('text 不能为空'));
    const { cfg } = this;

    return new Promise<SynthesizeResult>((resolve, reject) => {
      const taskId = crypto.randomUUID().replace(/-/g, '');
      const chunks: Buffer[] = [];
      let settled = false;

      const ws = new WebSocket(cfg.wsUrl, {
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'user-agent': 'human-lab tts/0.1 (node; ws)',
          'X-DashScope-DataInspection': 'enable',
        },
      });

      const timer = setTimeout(
        () => fail(new Error(`超时（${(cfg.timeoutMs ?? 120_000) / 1000}s）无响应，请检查端点 URL / Key / 网络`)),
        cfg.timeoutMs ?? 120_000,
      );

      function fail(err: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        reject(err);
      }
      function done(result: SynthesizeResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        resolve(result);
      }
      const send = (obj: unknown) => ws.send(JSON.stringify(obj));
      // tts_v2 协议：三个 action 的 streaming 统一为 "duplex"
      const header = (action: string) => ({ action, task_id: taskId, streaming: 'duplex' });
      // run-task / continue-task 的 payload 前缀（finish-task 只带 input）
      const payloadPrefix = () => ({
        model: cfg.model,
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
      });

      ws.on('open', () => {
        send({
          header: header('run-task'),
          payload: {
            ...payloadPrefix(),
            input: {},
            parameters: {
              voice: cfg.voice,
              volume: cfg.volume ?? 50,
              text_type: 'PlainText',
              sample_rate: cfg.sampleRate ?? 22050,
              rate: cfg.rate ?? 1,
              format: cfg.format ?? 'mp3',
              pitch: cfg.pitch ?? 1,
              seed: cfg.seed ?? 0,
              type: 0,
              enable_ssml: true, // 官方 call() 默认开启
            },
          },
        });
      });

      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          // 二进制帧 = 音频数据
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Uint8Array);
          chunks.push(buf);
          opts.onAudio?.(buf);
          return;
        }
        let msg: { header?: { event?: string; error_code?: string; error_message?: string; usage?: unknown } };
        try {
          msg = JSON.parse((data as Buffer).toString());
        } catch {
          return;
        }
        const { event, error_code, error_message, usage } = msg.header ?? {};
        switch (event) {
          case 'task-started':
            // MVP 一次性下发全部文本；流式场景可在此拆句多次 continue-task
            send({ header: header('continue-task'), payload: { ...payloadPrefix(), input: { text } } });
            send({ header: header('finish-task'), payload: { input: {} } });
            break;
          case 'result-generated':
            // 文本事件帧（时间戳/进度等）；音频走二进制帧，这里无需处理
            break;
          case 'task-finished':
            done({ audio: Buffer.concat(chunks), bytes: chunks.reduce((n, c) => n + c.length, 0), usage, taskId });
            break;
          case 'task-failed':
            fail(new Error(`task-failed ${error_code || ''}: ${error_message || '未知错误'}`));
            break;
          default:
            break;
        }
      });

      ws.on('error', (err: Error) => fail(new Error(`WebSocket 错误: ${err.message}`)));
      ws.on('close', (code: number, reason: Buffer) => {
        if (!settled) fail(new Error(`连接提前关闭 code=${code} reason=${reason.toString() || '(空)'}`));
      });
    });
  }
}

/** 未指定输出路径时的默认文件名：<OUTPUT_DIR>/tts-YYYYMMDDHHMMSS.mp3 */
function defaultOutFile(ext: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return path.join(OUTPUT_DIR, `tts-${ts}.${ext}`);
}

/**
 * 一行调用文本转语音能力（自动加载 .env 配置；音频写入 output/ 目录）。
 * 注意：本函数不写数据库——"记录任务"是调用方（tasks.ts）的编排职责，能力层保持纯粹。
 *
 * @param text 待合成文本
 * @param opts.config 覆盖配置（如 { voice: 'longanlufeng' }）
 * @param opts.onAudio 流式音频回调
 * @param opts.out 输出文件路径；不传则写入 output/tts-<时间戳>.mp3
 *
 * @example
 *   import { synthesizeSpeech } from './capabilities/tts.js';
 *   const { audio, outFile } = await synthesizeSpeech('你好，我是数字人。');
 */
export async function synthesizeSpeech(
  text: string,
  opts: { config?: Partial<TTSConfig>; onAudio?: (chunk: Buffer) => void; out?: string } = {},
): Promise<SynthesizeResult & { outFile: string }> {
  loadDotEnv();
  const config = { ...resolveTTSConfig(), ...opts.config };
  const tts = new DashScopeTTS(config);
  const result = await tts.synthesize(text, { onAudio: opts.onAudio });

  const out = opts.out ?? defaultOutFile(config.format);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, result.audio);

  return { ...result, outFile: path.resolve(out) };
}
