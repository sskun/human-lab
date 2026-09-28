// 能力模块：TTS/ASR/LLM/口播 四个能力的 Nest 服务封装。
// capabilities/*.ts 本体保持纯函数能力层（不碰 HTTP 不碰 DB），lego CLI 与冒烟测试直接引用；
// 这里的 Service 是它们进入 DI 世界的入口。
import { Module } from '@nestjs/common';
import { TtsService } from './tts.service.js';
import { AsrService } from './asr.service.js';
import { LlmService } from './llm.service.js';
import { LipsyncService } from './lipsync.service.js';

@Module({
  providers: [TtsService, AsrService, LlmService, LipsyncService],
  exports: [TtsService, AsrService, LlmService, LipsyncService],
})
export class CapabilitiesModule {}
