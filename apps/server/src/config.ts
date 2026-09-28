// server 配置：环境变量 > 向上查找仓库根目录 .env > 默认值
// 仓库根目录的 .env 是唯一的密钥/配置来源（已在 .gitignore 排除，不会提交）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 仓库根目录。
 * 无论从 src 还是编译后的 dist 运行，本文件都位于 <root>/apps/server/{src|dist}/ 下，
 * 向上三级即仓库根。
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', '..');

/** 生成文件的存储目录（语音 mp3、口型视频 mp4 都写这里），可用环境变量 OUTPUT_DIR 覆盖 */
export const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(REPO_ROOT, 'output');

/** SQLite 数据库目录（数据库文件固定为 data/human-lab.db），可用环境变量 DATA_DIR 覆盖 */
export const DATA_DIR = process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data');

/**
 * 从 startDir 逐级向上查找 .env（在 monorepo 任意子包里运行都能共享根目录的 .env）
 */
export function findEnvFile(startDir = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    const f = path.join(dir, '.env');
    if (fs.existsSync(f)) return f;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 加载 .env（不覆盖已有环境变量）。默认自动查找；也可显式传入文件路径。
 * @returns 实际加载的 .env 路径（没找到返回 null）
 */
export function loadDotEnv(file?: string): string | null {
  const envFile = file ?? findEnvFile();
  if (!envFile || !fs.existsSync(envFile)) return null;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
  return envFile;
}

/** TTS 能力的配置项（全部可由 .env / 环境变量提供） */
export interface TTSConfig {
  apiKey?: string;
  wsUrl: string;
  model: string;
  voice: string;
  format: string;
  sampleRate: number;
}

/**
 * 解析 TTS 配置（不抛错，缺 apiKey 在客户端构造时校验）
 */
export function resolveTTSConfig(env: NodeJS.ProcessEnv = process.env): TTSConfig {
  return {
    apiKey: env.DASHSCOPE_API_KEY,
    wsUrl: env.DASHSCOPE_WS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    model: env.TTS_MODEL || 'qwen-audio-3.0-tts-plus',
    // qwen-audio-3.0-tts-plus 仅支持 longanlingxin（女）/ longanlufeng（男），音色不能跨模型混用
    voice: env.TTS_VOICE || 'longanlingxin',
    format: env.TTS_FORMAT || 'mp3', // mp3 | wav | pcm | opus
    sampleRate: Number(env.TTS_SAMPLE_RATE || 22050),
  };
}

/** ASR（语音识别）能力的配置项（全部可由 .env / 环境变量提供） */
export interface ASRConfig {
  apiKey?: string;
  /** HTTP 推理端点（与 TTS 同一专属实例，协议为 multimodal-generation） */
  url: string;
  model: string;
  timeoutMs?: number;
}

/**
 * 解析 ASR 配置（不抛错，缺 apiKey 在客户端构造时校验）
 */
export function resolveASRConfig(env: NodeJS.ProcessEnv = process.env): ASRConfig {
  return {
    apiKey: env.DASHSCOPE_API_KEY,
    url:
      env.DASHSCOPE_ASR_URL ||
      'https://llm-bp3e6hufsqhewhcr.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    model: env.ASR_MODEL || 'qwen-audio-3.1-asr-flash',
    timeoutMs: env.ASR_TIMEOUT_MS ? Number(env.ASR_TIMEOUT_MS) : undefined,
  };
}

/** LLM（对话回复）能力的配置项（全部可由 .env / 环境变量提供） */
export interface LLMConfig {
  apiKey?: string;
  /** OpenAI 兼容模式根地址（不含 /chat/completions），可用环境变量 LLM_BASE_URL 覆盖 */
  baseUrl: string;
  model: string;
  /** 聊天数字人的 system 人设（实时聊天编排用，可用环境变量 LLM_SYSTEM 覆盖） */
  chatSystem?: string;
  timeoutMs?: number;
}

/**
 * 解析 LLM 配置（不抛错，缺 apiKey 在客户端构造时校验）
 */
export function resolveLLMConfig(env: NodeJS.ProcessEnv = process.env): LLMConfig {
  return {
    apiKey: env.DASHSCOPE_API_KEY,
    baseUrl:
      env.LLM_BASE_URL ||
      'https://llm-bp3e6hufsqhewhcr.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    model: env.LLM_MODEL || 'qwen3.8-flash',
    chatSystem: env.LLM_SYSTEM || undefined,
    timeoutMs: env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : undefined,
  };
}

/** 口播视频（wan3.0-video-prime 全能参考）能力的配置项（docs/lipsync-design.md §4.6） */
export interface TalkConfig {
  apiKey?: string;
  /** wan3.0 异步任务端点根（与 TTS/ASR/LLM 同一专属实例） */
  baseUrl: string;
  /** 百炼临时文件上传端点根（公网，P2 探测确认） */
  uploadsBaseUrl: string;
  model: string;
  /** 输出分辨率档位：480P | 720P | 1080P */
  resolution: string;
  /** 画幅：口播/带货默认竖屏 9:16 */
  ratio: string;
  /** 视频秒数：[2,30] 整数；-1 = 智能时长（按参考音频对齐） */
  duration: number;
  /** prompt 智能改写：口播模板是精确指令，默认关闭 */
  promptExtend: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  /** 形象资产目录与默认形象 id（assets/avatars/<id>/image.png） */
  avatarDir: string;
  avatarId: string;
  /** withVideo 任务允许的最大口播字数（对应参考音频 ≤15s，P4 标定） */
  maxTextChars: number;
}

/**
 * 解析口播能力配置（不抛错，缺 apiKey 在客户端构造时校验）
 */
export function resolveTalkConfig(env: NodeJS.ProcessEnv = process.env): TalkConfig {
  return {
    apiKey: env.DASHSCOPE_API_KEY,
    baseUrl:
      env.MAAS_BASE_URL ||
      'https://llm-bp3e6hufsqhewhcr.cn-beijing.maas.aliyuncs.com/api/v1',
    uploadsBaseUrl: env.DASHSCOPE_UPLOADS_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1',
    model: env.TALK_MODEL || 'wan3.0-video-prime',
    resolution: env.TALK_RESOLUTION || '480P',
    ratio: env.TALK_RATIO || '9:16',
    duration: env.TALK_DURATION ? Number(env.TALK_DURATION) : -1,
    promptExtend: (env.TALK_PROMPT_EXTEND ?? 'false') === 'true',
    pollIntervalMs: Number(env.TALK_POLL_INTERVAL_MS || 15_000),
    timeoutMs: Number(env.TALK_TIMEOUT_MS || 600_000),
    avatarDir: env.AVATAR_DIR || path.join(REPO_ROOT, 'assets', 'avatars'),
    avatarId: env.AVATAR_ID || 'default',
    maxTextChars: Number(env.LIPSYNC_TEXT_MAX_CHARS || 60),
  };
}
