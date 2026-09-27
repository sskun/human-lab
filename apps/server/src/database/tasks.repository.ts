// tasks 表读写：只负责"任务的持久化"，不做任何 AI 能力（tasks.service 是它的主要调用方）。
import { Injectable } from '@nestjs/common';
import type { TaskStatus } from '@human-lab/shared';
import { DatabaseService } from './database.service.js';

/** tasks 表一行记录（列名蛇形命名，读出后映射为驼峰） */
export interface TaskRecord {
  id: string;
  /** 能力类型：'tts' | 'lipsync' | ... */
  type: string;
  text: string | null;
  voice: string | null;
  model: string | null;
  filePath: string | null;
  bytes: number | null;
  status: TaskStatus;
  error: string | null;
  createdAt: string;
}

/** 蛇形列名 → 驼峰字段 */
function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    text: (row.text as string) ?? null,
    voice: (row.voice as string) ?? null,
    model: (row.model as string) ?? null,
    filePath: (row.file_path as string) ?? null,
    bytes: (row.bytes as number) ?? null,
    status: String(row.status) as TaskStatus,
    error: (row.error as string) ?? null,
    createdAt: String(row.created_at),
  };
}

@Injectable()
export class TasksRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 新建任务（status='queued'，created_at 由数据库默认值生成本地时间） */
  insertTask(t: {
    id: string;
    type: string;
    text?: string | null;
    voice?: string | null;
    model?: string | null;
  }): void {
    this.db
      .prepare(`INSERT INTO tasks (id, type, text, voice, model, status) VALUES (?, ?, ?, ?, ?, 'queued')`)
      .run(t.id, t.type, t.text ?? null, t.voice ?? null, t.model ?? null);
  }

  /**
   * 更新任务状态/结果（其余字段保留）。filePath/bytes/text 传 null 或不传时保留原值（COALESCE）。
   * text 的语义随任务类型而变：tts 任务入队时写入待合成文本，asr 任务完成时写入识别结果。
   */
  updateTask(
    id: string,
    patch: {
      status: TaskStatus;
      filePath?: string | null;
      bytes?: number | null;
      text?: string | null;
      error?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, file_path = COALESCE(?, file_path), bytes = COALESCE(?, bytes),
         text = COALESCE(?, text), error = ? WHERE id = ?`,
      )
      .run(patch.status, patch.filePath ?? null, patch.bytes ?? null, patch.text ?? null, patch.error ?? null, id);
  }

  /** 按 id 查任务 */
  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /** 最近的生成记录（新的在前） */
  listTasks(limit = 20): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC, id LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }
}
