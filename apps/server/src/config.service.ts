// 运行时配置的单一注入点：进程启动时解析一次（环境变量在 main.ts 已由 loadDotEnv 填充）。
import { Injectable } from '@nestjs/common';
import {
  DATA_DIR,
  OUTPUT_DIR,
  resolveASRConfig,
  resolveLLMConfig,
  resolveTTSConfig,
  type ASRConfig,
  type LLMConfig,
  type TTSConfig,
} from './config.js';

@Injectable()
export class ConfigService {
  /** 生成文件的存储目录（语音 mp3、口型视频 mp4 都写这里） */
  readonly outputDir = OUTPUT_DIR;
  /** SQLite 数据库目录（数据库文件固定为 human-lab.db） */
  readonly dataDir = DATA_DIR;
  readonly tts: TTSConfig = resolveTTSConfig();
  readonly asr: ASRConfig = resolveASRConfig();
  readonly llm: LLMConfig = resolveLLMConfig();
}
