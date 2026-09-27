// ASR 能力的 DI 封装（能力层 asr.ts 保持不变，lego CLI 与冒烟测试直接引用）。
import { Injectable } from '@nestjs/common';
import { recognizeSpeech, type ASRResult } from './asr.js';

@Injectable()
export class AsrService {
  /**
   * 识别一段音频。
   * @param input 音频来源：公网 URL / 本地文件路径 / Buffer
   * @param opts.format 音频封装格式；不传则按文件扩展名推断，最终由服务端兜底探测
   */
  recognize(input: string | Buffer, opts: { format?: string } = {}): Promise<ASRResult> {
    return recognizeSpeech(input, opts);
  }
}
