// 任务编排：把"一次合成/一次识别"包装成任务，全程落 SQLite
//
// 两条流程：
//   POST /api/speak → createTask()   异步：入队即返回 202，后台 fire-and-forget 执行 runTask()
//     queued → processing → done(文件路径/字节数) | failed(错误信息)
//   POST /api/listen → createListenTask()  同步：路由内 await（实测识别亚秒级，轮询不值得）
//     queued → processing → done(录音归档 + 识别文本) | failed(错误信息) → 抛错由路由转 502
//
// MVP 说明：单进程内直接跑（Node 事件循环 + 异步等待），不引入消息队列；
// 数据库里留了完整状态机，未来要拆 worker / 上队列时只需要换 runTask 的执行位置。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskView } from '@human-lab/shared';
import { OUTPUT_DIR } from './config.js';
import { resolveASRConfig } from './config.js';
import { synthesizeSpeech } from './capabilities/tts.js';
import { recognizeSpeech } from './capabilities/asr.js';
import { insertTask, updateTask, getTask, listTasks, type TaskRecord } from './db.js';

/**
 * 创建合成任务并立即返回（后台开始执行）
 * @param text 要朗读的文本
 * @param voice 可选音色（不传用 .env 默认）
 * @returns taskId
 */
export function createTask(text: string, voice?: string): string {
  const id = randomUUID();
  insertTask({ id, type: 'tts', text, voice: voice ?? null });
  // fire-and-forget：不 await，让 HTTP 响应立刻返回；runTask 内部自捕获所有错误
  void runTask(id, text, voice);
  return id;
}

/** 后台执行：调 TTS 能力，把文件写到 output/，并回写任务状态 */
async function runTask(id: string, text: string, voice?: string): Promise<void> {
  updateTask(id, { status: 'processing' });
  try {
    // 产物文件名带 taskId：一个任务一个文件，且天然可经 /media/<file> 访问
    const out = path.join(OUTPUT_DIR, `tts-${id}.mp3`);
    const result = await synthesizeSpeech(text, {
      out,
      config: voice ? { voice } : {},
    });
    updateTask(id, { status: 'done', filePath: result.outFile, bytes: result.bytes });
    console.log(`[task ${id}] done: ${result.bytes} bytes -> ${result.outFile}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateTask(id, { status: 'failed', error: message });
    console.error(`[task ${id}] failed: ${message}`);
  }
}

/** 一次识别的对外结果（POST /api/listen 的响应体） */
export interface ListenOutcome {
  taskId: string;
  /** 识别出的文字（带标点），纯静音时为空字符串 */
  text: string;
  /** 音频秒数（上游 usage.duration，计费口径） */
  duration: number | null;
}

/**
 * 创建识别任务并**同步**执行完（POST /api/listen 内 await，识别快，不值得异步轮询）。
 * 与 TTS 任务一致：全程落库，录音归档到 output/ 便于回放核对识别质量。
 *
 * @param audio 音频二进制（调用方已完成 base64 解码与大小校验）
 * @param format 音频封装格式（wav/mp3/...），决定归档扩展名；识别时按扩展名声明给上游
 * @throws 识别失败时任务标记 failed 并向上抛出（路由层转 502）
 */
export async function createListenTask(audio: Buffer, format?: string): Promise<ListenOutcome> {
  const id = randomUUID();
  insertTask({ id, type: 'asr', model: resolveASRConfig().model });
  updateTask(id, { status: 'processing' });
  try {
    const ext = format || 'wav';
    const out = path.join(OUTPUT_DIR, `asr-${id}.${ext}`);
    fs.writeFileSync(out, audio);
    // 识别归档文件：扩展名即 format 声明值，真实格式由服务端自动探测兜底
    const result = await recognizeSpeech(out);
    updateTask(id, { status: 'done', filePath: out, bytes: audio.length, text: result.text });
    console.log(
      `[task ${id}] done: ${audio.length} bytes -> ${out}, text: ${JSON.stringify(result.text)}`,
    );
    return { taskId: id, text: result.text, duration: result.usage?.duration ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateTask(id, { status: 'failed', error: message });
    console.error(`[task ${id}] failed: ${message}`);
    throw err;
  }
}

/** 内部记录 → 对外视图：隐藏服务器本地路径，只给相对的媒体 URL */
function toView(t: TaskRecord): TaskView {
  return {
    id: t.id,
    status: t.status,
    audioUrl: t.filePath ? `/media/${path.basename(t.filePath)}` : undefined,
    text: t.text ?? undefined,
    error: t.error ?? null,
  };
}

/** 查询单个任务（不存在返回 undefined → 路由层转 404） */
export function getTaskView(id: string): TaskView | undefined {
  const t = getTask(id);
  return t ? toView(t) : undefined;
}

/** 最近的任务列表（web 端做历史记录用） */
export function listTaskViews(limit = 20): TaskView[] {
  return listTasks(limit).map(toView);
}
