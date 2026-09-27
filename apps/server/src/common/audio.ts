// base64 音频的公共校验/解码（/api/listen 与聊天轮次共用），错误语义与重构前一致：
//   /api/listen 严格校验（非空 + base64 字符合法性 + 解码非空 + 大小上限）；
//   聊天轮次宽松处理（不做字符合法性校验，异常编码交给 ASR 失败兜底，轮次按 failed 落库）。
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/** 单个音频的解码后大小上限（10MB；1 分钟 16kHz 单声道 wav 约 1.9MB，余量充足） */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/**
 * 解码 base64 → Buffer（不做字符合法性校验）。
 * @throws 解码为空 400 / 超过大小上限 413
 */
export function decodeAudio(audioBase64: string): Buffer {
  const audio = Buffer.from(audioBase64.replace(/\s/g, ''), 'base64');
  if (audio.length === 0) throw new BadRequestException('audioBase64 解码后为空');
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new PayloadTooLargeException(`音频超过大小上限（${MAX_AUDIO_BYTES / 1024 / 1024}MB）`);
  }
  return audio;
}

/** /api/listen 专用：先校验非空与 base64 字符合法性，再解码 */
export function decodeListenAudio(audioBase64: string | undefined): Buffer {
  if (!audioBase64 || !audioBase64.trim()) throw new BadRequestException('audioBase64 不能为空');
  // btoa 产出标准 base64；兼容 URL-safe 变体（-_）与省略的 padding
  if (!/^[A-Za-z0-9+/=_-]+$/.test(audioBase64.replace(/\s/g, ''))) {
    throw new BadRequestException('audioBase64 不是合法的 base64');
  }
  return decodeAudio(audioBase64);
}
