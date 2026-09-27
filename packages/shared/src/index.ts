// @human-lab/shared：server/web 共享的 API 契约（纯类型，无运行时代码、零依赖）
//
// 分层约定（方案一）：
//   - 这里只放"两边都要认的字段定义"，防止 server 和 web 各写一份导致不一致
//   - 能力实现（TTS/口型）与存储（SQLite）内聚在 apps/server/src —— 见根 README
export type {
  TaskStatus,
  TaskView,
  SpeakRequest,
  SpeakResponse,
  ListenRequest,
  ListenResponse,
  ChatSessionStatus,
  ChatSessionView,
  ChatTurnView,
  ChatTurnRequest,
} from './types.js';
