// 管理后台查询参数解析（纯函数，便于单测）：白名单 + 长度限制，非法即 400；limit 超范围夹取而非报错。
import { BadRequestException } from '@nestjs/common';
import type { LogLevel, TaskStatus, TaskType } from '@human-lab/shared';
import type { LogQuery } from '../database/logs.repository.js';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const TASK_TYPES: readonly TaskType[] = ['tts', 'asr', 'talking'];
const TASK_STATUSES: readonly TaskStatus[] = ['queued', 'processing', 'done', 'failed'];

const MAX_LIMIT = 200;

export interface TaskQuery {
  type?: TaskType;
  status?: TaskStatus;
  limit: number;
}

type Raw = Record<string, unknown>;

/** 取单值字符串参数：缺省/空白 → undefined；重复参数（数组）等非字符串 → 400 */
function str(raw: Raw, key: string, maxLen: number): string | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new BadRequestException(`${key} 参数格式不正确`);
  const s = v.trim();
  if (!s) return undefined;
  if (s.length > maxLen) throw new BadRequestException(`${key} 最长 ${maxLen} 个字符`);
  return s;
}

function oneOf<T extends string>(raw: Raw, key: string, allowed: readonly T[]): T | undefined {
  const s = str(raw, key, 32);
  if (s === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(s)) {
    throw new BadRequestException(`${key} 只能是 ${allowed.join(' / ')}`);
  }
  return s as T;
}

/** 正整数参数（before 游标） */
function positiveInt(raw: Raw, key: string): number | undefined {
  const s = str(raw, key, 16);
  if (s === undefined) return undefined;
  if (!/^\d+$/.test(s) || Number(s) < 1) throw new BadRequestException(`${key} 必须是正整数`);
  return Number(s);
}

/** limit：必须是整数，超出 [1, MAX_LIMIT] 时夹取 */
function limit(raw: Raw, fallback: number): number {
  const s = str(raw, 'limit', 16);
  if (s === undefined) return fallback;
  if (!/^-?\d+$/.test(s)) throw new BadRequestException('limit 必须是整数');
  return Math.min(MAX_LIMIT, Math.max(1, Number(s)));
}

/** GET /api/admin/logs 的查询参数 */
export function parseLogQuery(raw: Raw): LogQuery {
  const q: LogQuery = { limit: limit(raw, 100) };
  const level = oneOf(raw, 'level', LOG_LEVELS);
  const scope = str(raw, 'scope', 64);
  const keyword = str(raw, 'q', 100);
  const before = positiveInt(raw, 'before');
  if (level) q.level = level;
  if (scope) q.scope = scope;
  if (keyword) q.q = keyword;
  if (before !== undefined) q.before = before;
  return q;
}

/** GET /api/admin/tasks 的查询参数 */
export function parseTaskQuery(raw: Raw): TaskQuery {
  const q: TaskQuery = { limit: limit(raw, 50) };
  const type = oneOf(raw, 'type', TASK_TYPES);
  const status = oneOf(raw, 'status', TASK_STATUSES);
  if (type) q.type = type;
  if (status) q.status = status;
  return q;
}
