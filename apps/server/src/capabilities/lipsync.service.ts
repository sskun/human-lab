// 口播视频能力的 DI 封装（能力层 lipsync.ts 保持不变，lego CLI 与探测脚本直接引用）。
import { Injectable } from '@nestjs/common';
import { generateTalkingVideo, type TalkConfig, type TalkingVideoResult } from './lipsync.js';

@Injectable()
export class LipsyncService {
  /**
   * 生成数字人口播视频并写入 out 指定的文件（目录不存在会自动创建）。
   * 内部：上传形象图/音频 → wan3.0 异步任务 → 轮询 → 下载转存（分钟级耗时）。
   */
  generateToFile(opts: {
    imagePath: string;
    audioPath: string;
    productImagePath?: string;
    out: string;
    config?: Partial<TalkConfig>;
  }): Promise<TalkingVideoResult & { outFile: string }> {
    return generateTalkingVideo({
      imagePath: opts.imagePath,
      audioPath: opts.audioPath,
      productImagePath: opts.productImagePath,
      out: opts.out,
      config: opts.config,
    });
  }
}
