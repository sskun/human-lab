// 实时聊天编排：会话制（点击开始 → 多轮「说话→听懂→回答→合成」→ 点击结束）
//
// 一轮的流水线（runChatTurn，同步执行，明细逐段落库 chat_turns）：
//   voice 输入: 归档录音 → ASR(input_text/asr_duration) → LLM(output_text/llm_usage) → TTS(output_audio) → done
//   text  输入: 直接作为 input_text → LLM → TTS → done
// 某一阶段失败：轮次标记 failed 并保留已完成阶段的明细（如 ASR 成功但 LLM 失败，input_text 仍在），
// 会话不受影响可继续发言。
// LLM 上下文：取本会话已完成轮次的 input/output 组成多轮 messages（上限 10 轮，防 token 膨胀）。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatSessionView, ChatTurnView } from '@human-lab/shared';
import { OUTPUT_DIR } from './config.js';
import { resolveLLMConfig } from './config.js';
import { recognizeSpeech } from './capabilities/asr.js';
import { chat, type ChatMessage } from './capabilities/llm.js';
import { synthesizeSpeech } from './capabilities/tts.js';
import {
  insertChatSession,
  endChatSession as endSession,
  getChatSession,
  getChatTurn,
  listChatSessions,
  countChatTurns,
  bumpChatTurnCount,
  insertChatTurn,
  updateChatTurn,
  listChatTurns,
  type ChatSessionRecord,
  type ChatTurnRecord,
} from './db.js';

/** 数字人的系统人设（可用 .env 的 LLM_SYSTEM 覆盖）；口语化短回复适合对话+朗读节奏 */
const DEFAULT_CHAT_SYSTEM = '你是数字人小泡泡。用口语化中文对话，回复简短（通常一到三句话），不要用 markdown 格式。';

/** LLM 参与上下文的最大历史轮数 */
const MAX_HISTORY_TURNS = 10;

/** 业务性错误（路由层按 status 映射 HTTP 状态码） */
export class ChatError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function toSessionView(s: ChatSessionRecord): ChatSessionView {
  return { id: s.id, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, turnCount: s.turnCount };
}

function toTurnView(t: ChatTurnRecord): ChatTurnView {
  // DB 存绝对路径；对外的 URL 相对 OUTPUT_DIR（server 把 output/ 挂在 /media）
  const media = (abs: string | null): string | undefined =>
    abs ? `/media/${path.relative(OUTPUT_DIR, abs).split(path.sep).join('/')}` : undefined;
  return {
    id: t.id,
    sessionId: t.sessionId,
    idx: t.idx,
    inputType: t.inputType,
    inputText: t.inputText,
    outputText: t.outputText,
    inputAudioUrl: media(t.inputAudio),
    outputAudioUrl: media(t.outputAudio),
    status: t.status,
    error: t.error,
    createdAt: t.createdAt,
  };
}

/** 点击「开始聊天」：创建会话 */
export function startChatSession(): ChatSessionView {
  const id = randomUUID();
  insertChatSession(id);
  const session = getChatSession(id);
  if (!session) throw new Error('会话创建失败');
  return toSessionView(session);
}

/** 点击「结束聊天」：关闭会话（已结束/不存在返回 undefined → 路由层 404/409） */
export function stopChatSession(id: string): ChatSessionView | undefined {
  const session = getChatSession(id);
  if (!session) return undefined;
  endSession(id);
  return toSessionView(getChatSession(id)!);
}

export function getChatSessionView(id: string): ChatSessionView | undefined {
  const s = getChatSession(id);
  return s ? toSessionView(s) : undefined;
}

export function listChatSessionViews(limit = 20): ChatSessionView[] {
  return listChatSessions(limit).map(toSessionView);
}

export function listChatTurnViews(sessionId: string): ChatTurnView[] {
  return listChatTurns(sessionId).map(toTurnView);
}

/**
 * 会话中说一轮（同步执行整条流水线）。
 * @param input voice（音频 Buffer + format）或 text 二选一
 * @returns 轮次视图（failed 时 status/error 已填，调用方直接展示）
 */
export async function runChatTurn(
  sessionId: string,
  input: { text?: string; audio?: Buffer; format?: string },
): Promise<ChatTurnView> {
  const session = getChatSession(sessionId);
  if (!session) throw new ChatError(404, '聊天会话不存在');
  if (session.status !== 'active') throw new ChatError(409, '聊天已结束，请重新开始');

  const idx = countChatTurns(sessionId) + 1;
  const turnId = randomUUID();
  const dir = path.join(OUTPUT_DIR, `chat-${sessionId}`);
  fs.mkdirSync(dir, { recursive: true });
  insertChatTurn({
    id: turnId,
    sessionId,
    idx,
    inputType: input.audio ? 'voice' : 'text',
    inputBytes: input.audio?.length ?? null,
  });
  bumpChatTurnCount(sessionId);
  const fail = (err: unknown): ChatTurnView => {
    const message = err instanceof Error ? err.message : String(err);
    updateChatTurn(turnId, { status: 'failed', error: message });
    console.error(`[chat ${sessionId} turn ${idx}] failed: ${message}`);
    return toTurnView(getChatTurn(turnId)!);
  };

  try {
    // ① 输入段：voice 先归档再 ASR；text 直接用
    let inputText: string;
    let asrDuration: number | null = null;
    if (input.audio) {
      const ext = input.format || 'wav';
      const inputAudioPath = path.join(dir, `turn-${idx}-input.${ext}`);
      fs.writeFileSync(inputAudioPath, input.audio);
      try {
        const asr = await recognizeSpeech(inputAudioPath);
        inputText = asr.text;
        asrDuration = asr.usage?.duration ?? null;
      } catch (e) {
        // 归档仍保留（便于排查"这段录音为什么没听懂"），ASR 失败按轮次失败处理
        updateChatTurn(turnId, { inputAudio: inputAudioPath });
        throw e;
      }
      updateChatTurn(turnId, { inputText, asrDuration, inputAudio: inputAudioPath });
    } else {
      inputText = (input.text ?? '').trim();
      if (!inputText) return fail(new ChatError(400, '输入为空：请提供 text 或 audioBase64'));
      updateChatTurn(turnId, { inputText });
    }
    console.log(`[chat ${sessionId} turn ${idx}] 输入(${input.audio ? 'voice' : 'text'}): ${JSON.stringify(inputText)}`);

    // ② LLM 段：本会话已完成轮次作为上下文（上限 10 轮）
    const history: ChatMessage[] = listChatTurns(sessionId)
      .filter((t) => t.id !== turnId && t.status === 'done' && t.inputText && t.outputText)
      .slice(-MAX_HISTORY_TURNS)
      .flatMap((t) => [
        { role: 'user' as const, content: t.inputText! },
        { role: 'assistant' as const, content: t.outputText! },
      ]);
    const llmCfg = resolveLLMConfig();
    const reply = await chat([...history, { role: 'user', content: inputText }], {
      thinking: false,
      system: llmCfg.chatSystem ?? DEFAULT_CHAT_SYSTEM,
    });
    updateChatTurn(turnId, { outputText: reply.content, llmUsage: reply.usage ? JSON.stringify(reply.usage) : null });
    console.log(`[chat ${sessionId} turn ${idx}] 回复: ${JSON.stringify(reply.content)}`);

    // ③ TTS 段：回复合成语音（voice 默认沿用 .env 的 TTS_VOICE）
    const outputAudioPath = path.join(dir, `turn-${idx}-reply.mp3`);
    const tts = await synthesizeSpeech(reply.content, { out: outputAudioPath });
    updateChatTurn(turnId, { outputAudio: tts.outFile, status: 'done' });
    console.log(`[chat ${sessionId} turn ${idx}] done: ${tts.bytes} bytes -> ${tts.outFile}`);

    return toTurnView(getChatTurn(turnId)!);
  } catch (e) {
    return fail(e);
  }
}
