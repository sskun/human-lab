// 管理后台只读接口：
//   GET /api/admin/overview      概览统计（任务/会话/轮次/24h 日志分级/系统信息）
//   GET /api/admin/logs          运行日志 ?level=&scope=&q=&before=&limit=（id 倒序，游标分页）
//   GET /api/admin/logs/scopes   日志里出现过的模块名
//   GET /api/admin/tasks         任务记录 ?type=&status=&limit=
// ⚠️ 当前无鉴权（与现有 /api 一致，仅适合本机/内网演示）；对外部署前需加访问控制，见 docs/product-plan.md。
import { Controller, Get, Query } from '@nestjs/common';
import type { AdminOverview, AdminTaskView, LogListResponse } from '@human-lab/shared';
import { AdminService } from './admin.service.js';
import { parseLogQuery, parseTaskQuery } from './admin.query.js';

@Controller('api/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview(): AdminOverview {
    return this.admin.overview();
  }

  @Get('logs')
  logs(@Query() raw: Record<string, unknown>): LogListResponse {
    return this.admin.listLogs(parseLogQuery(raw));
  }

  @Get('logs/scopes')
  scopes(): string[] {
    return this.admin.logScopes();
  }

  @Get('tasks')
  tasks(@Query() raw: Record<string, unknown>): AdminTaskView[] {
    return this.admin.listTasks(parseTaskQuery(raw));
  }
}
