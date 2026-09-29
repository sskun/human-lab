// app_logs 表读写：运行日志的持久化与查询（AppLogger 写入，管理后台只读查询）。
import { Injectable } from '@nestjs/common';
import type { LogLevel } from '@human-lab/shared';
import { DatabaseService } from './database.service.js';

export interface LogRecord {
  id: number;
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  meta: string | null;
}

/** 日志查询条件（调用方已完成参数校验与 limit 夹取） */
export interface LogQuery {
  level?: LogLevel;
  scope?: string;
  /** 关键字：对 message 做字面子串匹配（% _ 不作通配符） */
  q?: string;
  /** 游标：只取 id 小于它的记录（上一页最后一条的 id） */
  before?: number;
  limit: number;
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function rowToLog(row: Record<string, unknown>): LogRecord {
  return {
    id: Number(row.id),
    ts: String(row.ts),
    level: (LEVELS as readonly string[]).includes(String(row.level)) ? (row.level as LogLevel) : 'info',
    scope: String(row.scope ?? ''),
    message: String(row.message ?? ''),
    meta: (row.meta as string) ?? null,
  };
}

/** LIKE 字面匹配：转义通配符与转义符本身（配合 ESCAPE '\'） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class LogsRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(entry: { level: LogLevel; scope: string; message: string; meta?: string | null }): void {
    this.db
      .prepare('INSERT INTO app_logs (level, scope, message, meta) VALUES (?, ?, ?, ?)')
      .run(entry.level, entry.scope, entry.message, entry.meta ?? null);
  }

  /** 按条件查询，id 倒序（新的在前） */
  query(q: LogQuery): LogRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.level) {
      where.push('level = ?');
      args.push(q.level);
    }
    if (q.scope) {
      where.push('scope = ?');
      args.push(q.scope);
    }
    if (q.q) {
      where.push("message LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(q.q)}%`);
    }
    if (q.before !== undefined) {
      where.push('id < ?');
      args.push(q.before);
    }
    args.push(q.limit);
    const sql = `SELECT * FROM app_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToLog);
  }

  /** 出现过的模块名（去重、排序；后台筛选下拉用） */
  scopes(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT scope FROM app_logs WHERE scope <> '' ORDER BY scope")
      .all() as Record<string, unknown>[];
    return rows.map((r) => String(r.scope));
  }

  /** 最近 24 小时各级别条数（没有的级别补 0） */
  countByLevelLast24h(): Record<LogLevel, number> {
    const rows = this.db
      .prepare(
        `SELECT level, COUNT(*) AS n FROM app_logs
         WHERE ts >= strftime('%Y-%m-%d %H:%M:%f', 'now', 'localtime', '-1 day') GROUP BY level`,
      )
      .all() as Record<string, unknown>[];
    const out: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const r of rows) {
      const level = String(r.level) as LogLevel;
      if (level in out) out[level] = Number(r.n);
    }
    return out;
  }

  /** 裁剪：只保留最新 maxRows 行（防止日志表无限增长） */
  prune(maxRows: number): void {
    this.db.prepare('DELETE FROM app_logs WHERE id <= (SELECT MAX(id) FROM app_logs) - ?').run(maxRows);
  }
}
