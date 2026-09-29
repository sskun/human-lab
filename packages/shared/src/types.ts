// 共享类型：server 与 web 共用的 API 契约（packages 存在的意义就是让两边引用同一份定义，
// 避免各写一份导致字段不一致）。web 侧用 `import type` 引入，构建时会被整体擦除，不会把
// Node 依赖带进浏览器。

/** 任务生命周期状态 */
export type TaskStatus = 'queued' | 'processing' | 'done' | 'failed';

/**
 * GET /api/tasks/:id 的响应体
 * （对 server 内部 TaskRecord 的裁剪视图：不暴露服务器本地文件路径，只给相对的媒体 URL）
 */
export interface TaskView {
  id: string;
  status: TaskStatus;
  /** status === 'done' 时存在，如 /media/tts-xxx.mp3（经 vite 代理或同源访问）；
   *  asr 任务则指向归档的录音文件（可回放核对识别质量） */
  audioUrl?: string;
  /** 口播任务（withVideo）done 时存在，如 /media/talking-xxx.mp4 */
  videoUrl?: string;
  /** processing 期间的流水线阶段：tts=合成音频（秒级） | lipsync=口播视频生成中（分钟级） */
  stage?: 'tts' | 'lipsync';
  /** 任务相关文本：tts 任务为待合成的输入文本，asr 任务为识别出的文字 */
  text?: string;
  error?: string | null;
}

/** POST /api/speak 请求体 */
export interface SpeakRequest {
  text: string;
  /** 可选音色，缺省用 .env 里的 TTS_VOICE */
  voice?: string;
  /** 勾选后走口播流水线：TTS → wan3.0-video-prime 生成数字人口播视频（分钟级） */
  withVideo?: boolean;
}

/** POST /api/speak 响应体（202，任务已受理，异步处理） */
export interface SpeakResponse {
  taskId: string;
}

/** POST /api/listen 请求体：上传一段音频做识别 */
export interface ListenRequest {
  /** 音频二进制的 base64（不含 data: 前缀，由 server 拼装） */
  audioBase64: string;
  /** 音频封装格式（wav/mp3/...）；缺省按 wav 处理，服务端会自动探测真实格式 */
  format?: string;
}

/** POST /api/listen 响应体（200，同步返回——实测识别延迟亚秒级，无需轮询） */
export interface ListenResponse {
  taskId: string;
  /** 识别出的文字（带标点）；纯静音时为空字符串 */
  text: string;
  /** 音频时长（秒），取自 usage.duration（计费口径） */
  duration: number | null;
}

// ———— 实时聊天（会话制：点击开始 → 多轮对话 → 点击结束；每轮输入输出明细落库） ————

/** 聊天会话状态 */
export type ChatSessionStatus = 'active' | 'ended';

/** GET /api/chat/sessions 列表项 & 建会话响应 */
export interface ChatSessionView {
  id: string;
  status: ChatSessionStatus;
  startedAt: string;
  endedAt?: string | null;
  turnCount: number;
}

/** 一轮对话的明细视图（输入/输出信息都在这里） */
export interface ChatTurnView {
  id: string;
  sessionId: string;
  /** 会话内轮次序号（从 1 起） */
  idx: number;
  /** 输入方式：voice=按住说话（inputText 为 ASR 结果） / text=打字输入 */
  inputType: 'voice' | 'text';
  /** 输入文本（voice 时为 ASR 识别结果） */
  inputText?: string | null;
  /** 输出文本（LLM 回复） */
  outputText?: string | null;
  /** 输入录音回放地址（voice 时存在，/media/...） */
  inputAudioUrl?: string;
  /** 回复音频地址（TTS 产物，/media/...） */
  outputAudioUrl?: string;
  status: 'processing' | 'done' | 'failed';
  error?: string | null;
  createdAt: string;
}

/** POST /api/chat/sessions/:id/turns 请求体：voice 与 text 二选一 */
export interface ChatTurnRequest {
  /** 打字输入（与 audioBase64 二选一） */
  text?: string;
  /** 按住说话的录音（wav base64，裸编码） */
  audioBase64?: string;
  format?: string;
}

// ———— 系统元信息（前台展示用，不含任何密钥） ————

/** GET /api/meta 响应体：当前形象、默认音色、各能力模型与限制 */
export interface AppMeta {
  avatar: {
    id: string;
    /** 当前形象图地址（GET /api/avatar/image） */
    imageUrl: string;
  };
  /** 默认 TTS 音色 */
  voice: string;
  models: { asr: string; llm: string; tts: string; talk: string };
  limits: {
    /** 口播视频单条文案字数上限（与 server LIPSYNC_TEXT_MAX_CHARS 一致） */
    videoTextMaxChars: number;
  };
}

// ———— 管理后台（只读：运行日志 / 任务记录 / 概览统计） ————

/** 运行日志级别（Nest 的 log→info，verbose→debug，fatal→error） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 一条运行日志 */
export interface LogEntryView {
  /** 自增 id，同时作为分页游标 */
  id: number;
  /** 本地时间，格式 YYYY-MM-DD HH:MM:SS.SSS */
  ts: string;
  level: LogLevel;
  /** 模块（Nest Logger context，如 Tasks / Chat / Http） */
  scope: string;
  message: string;
  /** 附加信息（error 的堆栈等），无则为 null */
  meta: string | null;
}

/** GET /api/admin/logs 响应体：id 倒序；nextCursor 传给 before 取下一页，null 表示没有更多 */
export interface LogListResponse {
  items: LogEntryView[];
  nextCursor: number | null;
}

/** 任务类型：tts=语音合成 / asr=语音识别 / talking=口播视频 */
export type TaskType = 'tts' | 'asr' | 'talking';

/** GET /api/admin/tasks 列表项：在 TaskView 基础上补充后台需要的字段 */
export interface AdminTaskView extends TaskView {
  type: string;
  voice?: string | null;
  model?: string | null;
  bytes?: number | null;
  createdAt: string;
}

/** GET /api/admin/overview 响应体 */
export interface AdminOverview {
  tasks: {
    total: number;
    byType: Record<string, number>;
    byStatus: Record<TaskStatus, number>;
  };
  chat: { sessions: number; activeSessions: number; turns: number; failedTurns: number };
  /** 最近 24 小时各级别日志条数 */
  logs: { last24h: Record<LogLevel, number> };
  system: { startedAt: string; uptimeSec: number; nodeVersion: string };
}
