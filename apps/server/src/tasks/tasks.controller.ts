// 任务相关 HTTP 接口：
//   POST /api/speak       受理合成任务（异步，202 + taskId，轮询取结果）
//   POST /api/listen      语音识别（同步）
//   GET  /api/tasks/:id   任务状态查询（web 端轮询直到 done/failed）
//   GET  /api/tasks       最近任务列表
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import type { ListenRequest, SpeakRequest, TaskView } from '@human-lab/shared';
import { ConfigService } from '../config.service.js';
import { TasksService } from './tasks.service.js';
import { decodeListenAudio } from '../common/audio.js';

@Controller('api')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly config: ConfigService,
  ) {}

  // 受理合成任务：校验参数 → 入库（queued）→ 后台执行 → 立即返回 taskId
  // withVideo=true 时走口播流水线（分钟级），口播稿按参考音频 ≤15s 上限限长（P4 标定）
  @Post('speak')
  @HttpCode(HttpStatus.ACCEPTED)
  speak(@Body() body?: SpeakRequest): { taskId: string } {
    const { text, voice, withVideo } = body ?? {};
    if (!text || !text.trim()) throw new BadRequestException('text 不能为空');
    const trimmed = text.trim();
    if (withVideo) {
      const max = this.config.talk.maxTextChars;
      if (trimmed.length > max) {
        throw new BadRequestException(
          `口播视频单条最长约 15 秒：请把文案控制在 ${max} 字以内（当前 ${trimmed.length} 字）`,
        );
      }
    }
    return { taskId: this.tasks.create(trimmed, voice, withVideo === true) };
  }

  // 语音识别（同步）：校验 base64 → 落库 → 归档录音 → 调 ASR 能力 → 返回文字；
  // 上游失败转 502（识别任务已按 failed 落库）
  @Post('listen')
  async listen(@Body() body?: ListenRequest) {
    const { audioBase64, format } = body ?? ({} as ListenRequest);
    const audio = decodeListenAudio(audioBase64);
    try {
      return await this.tasks.createListen(audio, format);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpException(`识别失败：${message}`, HttpStatus.BAD_GATEWAY);
    }
  }

  // 最近任务列表
  @Get('tasks')
  list(): TaskView[] {
    return this.tasks.listViews(20);
  }

  // 查询单个任务状态（web 端每秒轮询这个接口直到 done/failed）
  @Get('tasks/:id')
  get(@Param('id') id: string): TaskView {
    const view = this.tasks.getView(id);
    if (!view) throw new NotFoundException('任务不存在');
    return view;
  }
}
