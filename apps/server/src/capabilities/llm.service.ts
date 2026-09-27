// LLM 能力的 DI 封装（能力层 llm.ts 保持不变，lego CLI 与冒烟测试直接引用）。
import { Injectable } from '@nestjs/common';
import { chat, type ChatMessage, type ChatOptions, type ChatResult } from './llm.js';

@Injectable()
export class LlmService {
  /**
   * 对话回复：messages 由调用方持有（多轮上下文），返回聚合后的完整回答。
   */
  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    return chat(messages, opts);
  }
}
