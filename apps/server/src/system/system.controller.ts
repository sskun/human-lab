// 系统元信息（前台展示用）：
//   GET /api/meta          当前形象、默认音色、各能力模型、口播字数上限（不含任何密钥）
//   GET /api/avatar/image  当前形象图（assets/avatars/<AVATAR_ID>/image.png）
import fs from 'node:fs';
import path from 'node:path';
import { Controller, Get, NotFoundException, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AppMeta } from '@human-lab/shared';
import { ConfigService } from '../config.service.js';

@Controller('api')
export class SystemController {
  constructor(private readonly config: ConfigService) {}

  @Get('meta')
  meta(): AppMeta {
    const { asr, llm, tts, talk } = this.config;
    return {
      avatar: { id: talk.avatarId, imageUrl: '/api/avatar/image' },
      voice: tts.voice,
      models: { asr: asr.model, llm: llm.model, tts: tts.model, talk: talk.model },
      limits: { videoTextMaxChars: talk.maxTextChars },
    };
  }

  // 路径只由服务端配置拼出（不接受客户端参数），不存在路径穿越问题
  @Get('avatar/image')
  avatarImage(@Res() res: Response): void {
    const file = path.resolve(this.config.talk.avatarDir, this.config.talk.avatarId, 'image.png');
    if (!fs.existsSync(file)) throw new NotFoundException('形象图不存在');
    res.sendFile(file);
  }
}
