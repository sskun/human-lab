// 管理后台（只读）：概览统计、运行日志查询、任务记录查询。只读仓库，不改任何业务状态。
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import type {
  AdminOverview,
  AdminTaskView,
  LogListResponse,
  TaskStatus,
} from '@human-lab/shared';
import { TasksRepository, type TaskRecord } from '../database/tasks.repository.js';
import { ChatRepository } from '../database/chat.repository.js';
import { LogsRepository, type LogQuery } from '../database/logs.repository.js';
import type { TaskQuery } from './admin.query.js';

@Injectable()
export class AdminService {
  /** 服务启动时间（本服务单例随应用创建，近似进程启动时间） */
  private readonly startedAt = new Date();

  constructor(
    private readonly tasks: TasksRepository,
    private readonly chat: ChatRepository,
    private readonly logs: LogsRepository,
  ) {}

  overview(): AdminOverview {
    const byType: Record<string, number> = {};
    const byStatus: Record<TaskStatus, number> = { queued: 0, processing: 0, done: 0, failed: 0 };
    let total = 0;
    for (const { type, status, n } of this.tasks.countByTypeAndStatus()) {
      byType[type] = (byType[type] ?? 0) + n;
      if (status in byStatus) byStatus[status] += n;
      total += n;
    }
    return {
      tasks: { total, byType, byStatus },
      chat: this.chat.stats(),
      logs: { last24h: this.logs.countByLevelLast24h() },
      system: {
        startedAt: this.startedAt.toISOString(),
        uptimeSec: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
        nodeVersion: process.version,
      },
    };
  }

  /** 满页时 nextCursor = 本页最后一条 id（传给 before 取下一页）；不满页说明到底了 */
  listLogs(query: LogQuery): LogListResponse {
    const items = this.logs.query(query);
    return { items, nextCursor: items.length === query.limit ? items[items.length - 1].id : null };
  }

  logScopes(): string[] {
    return this.logs.scopes();
  }

  listTasks(query: TaskQuery): AdminTaskView[] {
    return this.tasks.listTasks(query.limit, { type: query.type, status: query.status }).map(toAdminView);
  }
}

/** 与 TasksService.toView 同一口径：只给 /media 相对地址，不暴露服务器本地路径 */
function toAdminView(t: TaskRecord): AdminTaskView {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    stage: (t.stage as 'tts' | 'lipsync') ?? undefined,
    text: t.text ?? undefined,
    voice: t.voice,
    model: t.model,
    bytes: t.bytes,
    audioUrl: t.filePath ? `/media/${path.basename(t.filePath)}` : undefined,
    videoUrl: t.videoPath ? `/media/${path.basename(t.videoPath)}` : undefined,
    error: t.error,
    createdAt: t.createdAt,
  };
}
