// SQLite 任务存储：数据库文件固定在 <仓库根>/data/human-lab.db
// 用 Node 内置的 node:sqlite（Node 22.5+，24 起无需实验开关），零第三方依赖。
// 这里只负责"任务的持久化"，不做任何 AI 能力；tasks.ts 是它的主要调用方。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TaskStatus } from '@human-lab/shared';
import { DATA_DIR } from './config.js';

export const DB_PATH = path.join(DATA_DIR, 'human-lab.db');

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

let db: DatabaseSync | null = null;

/** 打开（并初始化）数据库，进程内单例 */
export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      text       TEXT,
      voice      TEXT,
      model      TEXT,
      file_path  TEXT,
      bytes      INTEGER,
      status     TEXT NOT NULL,
      error      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- 实时聊天：会话（点击「开始聊天」建一行，「结束聊天」写 ended_at）
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id         TEXT PRIMARY KEY,
      status     TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      ended_at   TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0
    );

    -- 实时聊天：每轮对话的输入/输出明细（ASR 文本、LLM 回复、双方音频归档）
    CREATE TABLE IF NOT EXISTS chat_turns (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      idx          INTEGER NOT NULL,
      input_type   TEXT NOT NULL,
      input_text   TEXT,
      output_text  TEXT,
      input_audio  TEXT,
      output_audio TEXT,
      input_bytes  INTEGER,
      asr_duration REAL,
      llm_usage    TEXT,
      status       TEXT NOT NULL DEFAULT 'processing',
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);
  return db;
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

/** 新建任务（status='queued'，created_at 由数据库默认值生成本地时间） */
export function insertTask(t: {
  id: string;
  type: string;
  text?: string | null;
  voice?: string | null;
  model?: string | null;
}): void {
  getDb()
    .prepare(`INSERT INTO tasks (id, type, text, voice, model, status) VALUES (?, ?, ?, ?, ?, 'queued')`)
    .run(t.id, t.type, t.text ?? null, t.voice ?? null, t.model ?? null);
}

/**
 * 更新任务状态/结果（其余字段保留）。filePath/bytes/text 传 null 或不传时保留原值（COALESCE）。
 * text 的语义随任务类型而变：tts 任务入队时写入待合成文本，asr 任务完成时写入识别结果。
 */
export function updateTask(
  id: string,
  patch: {
    status: TaskStatus;
    filePath?: string | null;
    bytes?: number | null;
    text?: string | null;
    error?: string | null;
  },
): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = ?, file_path = COALESCE(?, file_path), bytes = COALESCE(?, bytes),
       text = COALESCE(?, text), error = ? WHERE id = ?`,
    )
    .run(patch.status, patch.filePath ?? null, patch.bytes ?? null, patch.text ?? null, patch.error ?? null, id);
}

/** 按 id 查任务 */
export function getTask(id: string): TaskRecord | undefined {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : undefined;
}

/** 最近的生成记录（新的在前） */
export function listTasks(limit = 20): TaskRecord[] {
  const rows = getDb().prepare('SELECT * FROM tasks ORDER BY created_at DESC, id LIMIT ?').all(limit) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

// ———— 实时聊天：会话与轮次 ————

export interface ChatSessionRecord {
  id: string;
  status: 'active' | 'ended';
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
}

export interface ChatTurnRecord {
  id: string;
  sessionId: string;
  idx: number;
  inputType: 'voice' | 'text';
  inputText: string | null;
  outputText: string | null;
  inputAudio: string | null;
  outputAudio: string | null;
  inputBytes: number | null;
  asrDuration: number | null;
  llmUsage: string | null;
  status: 'processing' | 'done' | 'failed';
  error: string | null;
  createdAt: string;
}

function rowToSession(row: Record<string, unknown>): ChatSessionRecord {
  return {
    id: String(row.id),
    status: row.status === 'ended' ? 'ended' : 'active',
    startedAt: String(row.started_at),
    endedAt: (row.ended_at as string) ?? null,
    turnCount: Number(row.turn_count ?? 0),
  };
}

function rowToTurn(row: Record<string, unknown>): ChatTurnRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    idx: Number(row.idx),
    inputType: row.input_type === 'text' ? 'text' : 'voice',
    inputText: (row.input_text as string) ?? null,
    outputText: (row.output_text as string) ?? null,
    inputAudio: (row.input_audio as string) ?? null,
    outputAudio: (row.output_audio as string) ?? null,
    inputBytes: (row.input_bytes as number) ?? null,
    asrDuration: (row.asr_duration as number) ?? null,
    llmUsage: (row.llm_usage as string) ?? null,
    status: row.status === 'done' ? 'done' : row.status === 'failed' ? 'failed' : 'processing',
    error: (row.error as string) ?? null,
    createdAt: String(row.created_at),
  };
}

/** 新建聊天会话（点击「开始聊天」） */
export function insertChatSession(id: string): void {
  getDb().prepare('INSERT INTO chat_sessions (id) VALUES (?)').run(id);
}

/** 结束聊天会话（点击「结束聊天」，写 ended_at） */
export function endChatSession(id: string): void {
  getDb()
    .prepare(`UPDATE chat_sessions SET status = 'ended', ended_at = datetime('now', 'localtime') WHERE id = ? AND status = 'active'`)
    .run(id);
}

export function getChatSession(id: string): ChatSessionRecord | undefined {
  const row = getDb().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

/** 最近的聊天会话（新的在前） */
export function listChatSessions(limit = 20): ChatSessionRecord[] {
  const rows = getDb().prepare('SELECT * FROM chat_sessions ORDER BY started_at DESC, id LIMIT ?').all(limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** 会话内已有轮次数（分配下一轮 idx 用） */
export function countChatTurns(sessionId: string): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM chat_turns WHERE session_id = ?').get(sessionId) as { n: number };
  return Number(row.n);
}

/** 新建一轮（status='processing'，明细字段由编排过程逐段回填） */
export function insertChatTurn(t: {
  id: string;
  sessionId: string;
  idx: number;
  inputType: 'voice' | 'text';
  inputBytes?: number | null;
}): void {
  getDb()
    .prepare('INSERT INTO chat_turns (id, session_id, idx, input_type, input_bytes) VALUES (?, ?, ?, ?, ?)')
    .run(t.id, t.sessionId, t.idx, t.inputType, t.inputBytes ?? null);
}

/**
 * 回填一轮的明细字段（传 null/不传的字段保留原值）。
 * 编排各阶段逐步写入：ASR 后回填 input_text，LLM 后回填 output_text，TTS 后回填 output_audio。
 */
export function updateChatTurn(
  id: string,
  patch: {
    inputText?: string | null;
    outputText?: string | null;
    inputAudio?: string | null;
    outputAudio?: string | null;
    asrDuration?: number | null;
    llmUsage?: string | null;
    status?: 'processing' | 'done' | 'failed';
    error?: string | null;
  },
): void {
  getDb()
    .prepare(
      `UPDATE chat_turns SET
       input_text = COALESCE(?, input_text), output_text = COALESCE(?, output_text),
       input_audio = COALESCE(?, input_audio), output_audio = COALESCE(?, output_audio),
       asr_duration = COALESCE(?, asr_duration), llm_usage = COALESCE(?, llm_usage),
       status = COALESCE(?, status), error = ? WHERE id = ?`,
    )
    .run(
      patch.inputText ?? null,
      patch.outputText ?? null,
      patch.inputAudio ?? null,
      patch.outputAudio ?? null,
      patch.asrDuration ?? null,
      patch.llmUsage ?? null,
      patch.status ?? null,
      patch.error ?? null, // error 可显式置 null（done 时清掉），与 COALESCE 字段语义不同
      id,
    );
}

/** 会话内全部轮次（按轮次序号，历史回放/详情用） */
export function listChatTurns(sessionId: string): ChatTurnRecord[] {
  const rows = getDb().prepare('SELECT * FROM chat_turns WHERE session_id = ? ORDER BY idx').all(sessionId) as Record<string, unknown>[];
  return rows.map(rowToTurn);
}

/** 会话轮次计数 +1（插入轮次后调用，与 chat_turns 实际行数保持一致，含失败轮次） */
export function bumpChatTurnCount(sessionId: string): void {
  getDb().prepare('UPDATE chat_sessions SET turn_count = turn_count + 1 WHERE id = ?').run(sessionId);
}

/** 按轮次 id 查单轮（编排过程中回填明细用） */
export function getChatTurn(id: string): ChatTurnRecord | undefined {
  const row = getDb().prepare('SELECT * FROM chat_turns WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToTurn(row) : undefined;
}
