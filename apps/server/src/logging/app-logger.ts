// 全局日志器：控制台输出与 Nest 默认格式一致，同时把每条日志写入 app_logs（管理后台查看）。
//
// 接入方式（main.ts）：bufferLogs 启动 → app.init() 完成建表 → app.useLogger(app.get(AppLogger))
// 回放缓冲日志。业务代码照常用 `new Logger('Tasks')`，Nest 会把调用转发到这里。
import { ConsoleLogger, Injectable, type LogLevel as NestLogLevel } from '@nestjs/common';
import type { LogLevel } from '@human-lab/shared';
import { LogsRepository } from '../database/logs.repository.js';

/** Nest 级别 → 后台展示的四级 */
const LEVEL_MAP: Record<NestLogLevel, LogLevel> = {
  log: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
  debug: 'debug',
  verbose: 'debug',
};

@Injectable()
export class AppLogger extends ConsoleLogger {
  /** app_logs 最多保留行数 */
  private static readonly MAX_ROWS = 20_000;
  /** 每写入多少条裁剪一次（裁剪是一次 DELETE，不必每条都做） */
  private static readonly PRUNE_EVERY = 500;
  private writes = 0;

  constructor(private readonly logs: LogsRepository) {
    super();
  }

  // 所有级别方法解析完 context/stack 后都会走到这里，是最小且完整的拦截点
  protected override printMessages(
    messages: unknown[],
    context = '',
    logLevel: NestLogLevel = 'log',
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ): void {
    super.printMessages(messages, context, logLevel, writeStreamType, errorStack);
    for (const message of messages) this.persist(logLevel, context, message, errorStack);
  }

  private persist(logLevel: NestLogLevel, context: string, message: unknown, errorStack: unknown): void {
    try {
      const stack = typeof errorStack === 'string' ? errorStack : message instanceof Error ? message.stack : undefined;
      this.logs.insert({
        level: LEVEL_MAP[logLevel] ?? 'info',
        scope: context,
        message: stringify(message),
        meta: stack ?? null,
      });
      this.writes += 1;
      if (this.writes % AppLogger.PRUNE_EVERY === 0) this.logs.prune(AppLogger.MAX_ROWS);
    } catch {
      // 落库失败（库未就绪/磁盘满等）只丢这条持久化记录：控制台已打印，且绝不能反过来影响业务。
      // 这里也不能再调用日志器，否则会递归。
    }
  }
}

/** 日志消息转文本：字符串原样；Error 取 message；其余尽量 JSON 序列化 */
function stringify(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    return String(message);
  }
}
