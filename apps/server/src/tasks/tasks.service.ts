// 任务编排：把"一次合成/一次识别/一次口播"包装成任务，全程落 SQLite
//
// 三条流程：
//   POST /api/speak → create()       异步：入队即返回 202，后台 fire-and-forget 执行 run()
//     纯音频（缺省）：queued → processing → done(音频文件) | failed
//     口播（withVideo）：queued → processing(tts) → processing(lipsync)
//       → done(音频+视频双产物) | failed（口播失败保留已合成的音频）
//   POST /api/listen → createListen()  同步：控制器内 await（实测识别亚秒级，轮询不值得）
//     queued → processing → done(录音归档 + 识别文本) | failed(错误信息) → 抛错由控制器转 502
//
// MVP 说明：单进程内直接跑（Node 事件循环 + 异步等待），不引入消息队列；
// 数据库里留了完整状态机，未来要拆 worker / 上队列时只需要换 run 的执行位置。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { TaskView } from '@human-lab/shared';
import { ConfigService } from '../config.service.js';
import { AsrService } from '../capabilities/asr.service.js';
import { TtsService } from '../capabilities/tts.service.js';
import { LipsyncService } from '../capabilities/lipsync.service.js';
import { TasksRepository, type TaskRecord } from '../database/tasks.repository.js';

/** 一次识别的对外结果（POST /api/listen 的响应体） */
export interface ListenOutcome {
  taskId: string;
  /** 识别出的文字（带标点），纯静音时为空字符串 */
  text: string;
  /** 音频秒数（上游 usage.duration，计费口径） */
  duration: number | null;
}

@Injectable()
export class TasksService {
  /** 经 AppLogger 同时输出到控制台与 app_logs（管理后台「运行日志」） */
  private readonly logger = new Logger('Tasks');

  constructor(
    private readonly config: ConfigService,
    private readonly repo: TasksRepository,
    private readonly tts: TtsService,
    private readonly asr: AsrService,
    private readonly lipsync: LipsyncService,
  ) {}

  /**
   * 创建合成任务并立即返回（后台开始执行）
   * @param text 要朗读/口播的文本
   * @param voice 可选音色（不传用 .env 默认）
   * @param withVideo 勾选后走口播流水线：TTS → wan3.0 生成数字人口播视频（分钟级）
   * @returns taskId
   */
  create(text: string, voice?: string, withVideo = false): string {
    const id = randomUUID();
    this.repo.insertTask({ id, type: withVideo ? 'talking' : 'tts', text, voice: voice ?? null });
    // fire-and-forget：不 await，让 HTTP 响应立刻返回；run 内部自捕获所有错误
    void (withVideo ? this.runTalking(id, text, voice) : this.run(id, text, voice));
    return id;
  }

  /** 后台执行：调 TTS 能力，把文件写到 output/，并回写任务状态 */
  private async run(id: string, text: string, voice?: string): Promise<void> {
    this.repo.updateTask(id, { status: 'processing' });
    try {
      // 产物文件名带 taskId：一个任务一个文件，且天然可经 /media/<file> 访问
      const out = path.join(this.config.outputDir, `tts-${id}.mp3`);
      const result = await this.tts.synthesizeToFile(text, { out, config: voice ? { voice } : {} });
      this.repo.updateTask(id, { status: 'done', filePath: result.outFile, bytes: result.bytes });
      this.logger.log(`[task ${id}] done: ${result.bytes} bytes -> ${result.outFile}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.repo.updateTask(id, { status: 'failed', error: message });
      this.logger.error(`[task ${id}] failed: ${message}`);
    }
  }

  /**
   * 口播流水线（withVideo=true）：TTS → 上传 → wan3.0 异步任务 → 下载转存。
   * 失败不回滚音频：音频是已付费的合法产物，失败原因入库 error，前端可继续播音频。
   */
  private async runTalking(id: string, text: string, voice?: string): Promise<void> {
    this.repo.updateTask(id, { status: 'processing', stage: 'tts' });
    let audioOut: string;
    let audioBytes: number;
    try {
      audioOut = path.join(this.config.outputDir, `tts-${id}.mp3`);
      const tts = await this.tts.synthesizeToFile(text, { out: audioOut, config: voice ? { voice } : {} });
      audioOut = tts.outFile;
      audioBytes = tts.bytes;
      // 音频是已付费产物：先落库（后续口播失败也保留），再进入 lipsync 阶段
      this.repo.updateTask(id, { status: 'processing', stage: 'lipsync', filePath: audioOut, bytes: audioBytes });
      this.logger.log(`[task ${id}] tts done: ${tts.bytes} bytes -> ${tts.outFile}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.repo.updateTask(id, { status: 'failed', error: message }); // stage 保持 'tts'，产物为空
      this.logger.error(`[task ${id}] failed at tts: ${message}`);
      return;
    }

    try {
      const videoOut = path.join(this.config.outputDir, `talking-${id}.mp4`);
      const result = await this.lipsync.generateToFile({
        imagePath: path.join(this.config.talk.avatarDir, this.config.talk.avatarId, 'image.png'),
        audioPath: audioOut,
        out: videoOut,
      });
      this.repo.updateTask(id, {
        status: 'done',
        filePath: audioOut,
        bytes: audioBytes,
        videoPath: result.outFile,
        stage: null,
      });
      this.logger.log(
        `[task ${id}] done: audio ${audioBytes}B + video ${result.bytes}B (${result.durationSec}s, ` +
          `${result.ratio ?? '?'}, remote=${result.remoteTaskId}) -> ${result.outFile}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.repo.updateTask(id, { status: 'failed', error: message }); // filePath（音频）保留
      this.logger.error(`[task ${id}] failed at lipsync: ${message}`);
    }
  }

  /**
   * 创建识别任务并**同步**执行完（POST /api/listen 内 await，识别快，不值得异步轮询）。
   * 与 TTS 任务一致：全程落库，录音归档到 output/ 便于回放核对识别质量。
   *
   * @param audio 音频二进制（控制器已完成 base64 解码与大小校验）
   * @param format 音频封装格式（wav/mp3/...），决定归档扩展名；识别时按扩展名声明给上游
   * @throws 识别失败时任务标记 failed 并向上抛出（控制器转 502）
   */
  async createListen(audio: Buffer, format?: string): Promise<ListenOutcome> {
    const id = randomUUID();
    this.repo.insertTask({ id, type: 'asr', model: this.config.asr.model });
    this.repo.updateTask(id, { status: 'processing' });
    try {
      const ext = format || 'wav';
      const out = path.join(this.config.outputDir, `asr-${id}.${ext}`);
      fs.writeFileSync(out, audio);
      // 识别归档文件：扩展名即 format 声明值，真实格式由服务端自动探测兜底
      const result = await this.asr.recognize(out);
      this.repo.updateTask(id, { status: 'done', filePath: out, bytes: audio.length, text: result.text });
      this.logger.log(
        `[task ${id}] done: ${audio.length} bytes -> ${out}, text: ${JSON.stringify(result.text)}`,
      );
      return { taskId: id, text: result.text, duration: result.usage?.duration ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.repo.updateTask(id, { status: 'failed', error: message });
      this.logger.error(`[task ${id}] failed: ${message}`);
      throw err;
    }
  }

  /** 内部记录 → 对外视图：隐藏服务器本地路径，只给相对的媒体 URL */
  private toView(t: TaskRecord): TaskView {
    return {
      id: t.id,
      status: t.status,
      audioUrl: t.filePath ? `/media/${path.basename(t.filePath)}` : undefined,
      videoUrl: t.videoPath ? `/media/${path.basename(t.videoPath)}` : undefined,
      stage: (t.stage as 'tts' | 'lipsync') ?? undefined,
      text: t.text ?? undefined,
      error: t.error ?? null,
    };
  }

  /** 查询单个任务（不存在返回 undefined → 控制器转 404） */
  getView(id: string): TaskView | undefined {
    const t = this.repo.getTask(id);
    return t ? this.toView(t) : undefined;
  }

  /** 最近的任务列表（web 端做历史记录用） */
  listViews(limit = 20): TaskView[] {
    return this.repo.listTasks(limit).map((t) => this.toView(t));
  }
}
