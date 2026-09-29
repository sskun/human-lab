// 实时聊天的持久化：会话（chat_sessions）与轮次明细（chat_turns）两张表。
import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service.js';

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

@Injectable()
export class ChatRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 新建聊天会话（点击「开始聊天」） */
  insertChatSession(id: string): void {
    this.db.prepare('INSERT INTO chat_sessions (id) VALUES (?)').run(id);
  }

  /** 结束聊天会话（点击「结束聊天」，写 ended_at） */
  endChatSession(id: string): void {
    this.db
      .prepare(
        `UPDATE chat_sessions SET status = 'ended', ended_at = datetime('now', 'localtime') WHERE id = ? AND status = 'active'`,
      )
      .run(id);
  }

  getChatSession(id: string): ChatSessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSession(row) : undefined;
  }

  /** 最近的聊天会话（新的在前） */
  listChatSessions(limit = 20): ChatSessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_sessions ORDER BY started_at DESC, id LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  /** 会话内已有轮次数（分配下一轮 idx 用） */
  countChatTurns(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chat_turns WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return Number(row.n);
  }

  /** 新建一轮（status='processing'，明细字段由编排过程逐段回填） */
  insertChatTurn(t: {
    id: string;
    sessionId: string;
    idx: number;
    inputType: 'voice' | 'text';
    inputBytes?: number | null;
  }): void {
    this.db
      .prepare('INSERT INTO chat_turns (id, session_id, idx, input_type, input_bytes) VALUES (?, ?, ?, ?, ?)')
      .run(t.id, t.sessionId, t.idx, t.inputType, t.inputBytes ?? null);
  }

  /**
   * 回填一轮的明细字段（传 null/不传的字段保留原值）。
   * 编排各阶段逐步写入：ASR 后回填 input_text，LLM 后回填 output_text，TTS 后回填 output_audio。
   */
  updateChatTurn(
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
    this.db
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
  listChatTurns(sessionId: string): ChatTurnRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_turns WHERE session_id = ? ORDER BY idx')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToTurn);
  }

  /** 会话轮次计数 +1（插入轮次后调用，与 chat_turns 实际行数保持一致，含失败轮次） */
  bumpChatTurnCount(sessionId: string): void {
    this.db.prepare('UPDATE chat_sessions SET turn_count = turn_count + 1 WHERE id = ?').run(sessionId);
  }

  /** 会话与轮次计数（管理后台概览用） */
  stats(): { sessions: number; activeSessions: number; turns: number; failedTurns: number } {
    const s = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(status = 'active'), 0) AS active FROM chat_sessions`)
      .get() as Record<string, unknown>;
    const t = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(status = 'failed'), 0) AS failed FROM chat_turns`)
      .get() as Record<string, unknown>;
    return {
      sessions: Number(s.n),
      activeSessions: Number(s.active),
      turns: Number(t.n),
      failedTurns: Number(t.failed),
    };
  }

  /** 按轮次 id 查单轮（编排过程中回填明细用） */
  getChatTurn(id: string): ChatTurnRecord | undefined {
    const row = this.db.prepare('SELECT * FROM chat_turns WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTurn(row) : undefined;
  }
}
