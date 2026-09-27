// 实时聊天 HTTP 接口（会话制）：
//   POST /api/chat/sessions            创建会话（点击「开始聊天」）
//   POST /api/chat/sessions/:id/turns  说一轮（voice 或 text 二选一，同步执行 ASR→LLM→TTS）
//   POST /api/chat/sessions/:id/end    结束会话（点击「结束聊天」）
//   GET  /api/chat/sessions            历史会话列表
//   GET  /api/chat/sessions/:id/turns  某会话的输入/输出明细
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
import type { ChatSessionView, ChatTurnRequest, ChatTurnView } from '@human-lab/shared';
import { ChatService, ChatError } from './chat.service.js';
import { decodeAudio } from '../common/audio.js';

@Controller('api/chat/sessions')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  // 点击「开始聊天」：创建会话
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(): { session: ChatSessionView } {
    return { session: this.chat.startSession() };
  }

  // 历史会话列表
  @Get()
  list(): ChatSessionView[] {
    return this.chat.listSessionViews(20);
  }

  // 会话中说一轮：voice（audioBase64）或 text 二选一；同步执行 ASR→LLM→TTS 并返回轮次明细。
  // 上游失败不抛 5xx——轮次已按 failed 落库，直接把失败的 turn 视图给前端展示（会话可继续）。
  @Post(':id/turns')
  @HttpCode(HttpStatus.OK)
  async turn(@Param('id') id: string, @Body() body?: ChatTurnRequest): Promise<{ turn: ChatTurnView }> {
    const { text, audioBase64, format } = body ?? {};
    const hasAudio = Boolean(audioBase64?.trim());
    if (!text?.trim() && !hasAudio) throw new BadRequestException('输入为空：请提供 text 或 audioBase64');
    // 与重构前一致：聊天轮次不做 base64 字符合法性校验，解码异常交给 ASR 失败兜底
    const audio = hasAudio ? decodeAudio(audioBase64!.trim()) : undefined;
    try {
      return { turn: await this.chat.runTurn(id, { text: text?.trim() || undefined, audio, format }) };
    } catch (err) {
      if (err instanceof ChatError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpException(`聊天轮次执行失败：${message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // 点击「结束聊天」：关闭会话
  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  end(@Param('id') id: string): { session: ChatSessionView } {
    const ended = this.chat.stopSession(id);
    if (!ended) throw new NotFoundException('聊天会话不存在');
    return { session: ended };
  }

  // 某会话的输入/输出明细
  @Get(':id/turns')
  turns(@Param('id') id: string): ChatTurnView[] {
    if (!this.chat.getSessionView(id)) throw new NotFoundException('聊天会话不存在');
    return this.chat.listTurnViews(id);
  }
}
