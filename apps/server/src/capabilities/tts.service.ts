// TTS 能力的 DI 封装（能力层 tts.ts 保持不变，lego CLI 与冒烟测试直接引用）。
import { Injectable } from '@nestjs/common';
import { synthesizeSpeech, type SynthesizeResult, type TTSConfig } from './tts.js';

@Injectable()
export class TtsService {
  /**
   * 合成语音并把音频写入 out 指定的文件（目录不存在会自动创建）。
   * @param opts.config 覆盖配置（如 { voice: 'longanlufeng' }），缺省用 .env 的 TTS_* 配置
   * @param opts.onAudio 流式音频回调（做实时播放用）
   */
  synthesizeToFile(
    text: string,
    opts: { out: string; config?: Partial<TTSConfig>; onAudio?: (chunk: Buffer) => void } = { out: '' },
  ): Promise<SynthesizeResult & { outFile: string }> {
    return synthesizeSpeech(text, { out: opts.out, config: opts.config, onAudio: opts.onAudio });
  }
}
