// LLM 能力：对话回复（OpenAI 兼容 chat/completions 协议直连，SSE 流式解析，不依赖官方 SDK）
//
// 端点：<专属实例>/compatible-mode/v1/chat/completions（Bearer 鉴权，同 DASHSCOPE_API_KEY）
// 请求体：{ model, messages, stream, enable_thinking, stream_options:{include_usage:true}, ... }
// 流式响应：SSE——每行 `data: {json}`，delta.reasoning_content=思考增量、delta.content=回答增量，
//          `data: [DONE]` 结束（OpenAI 协议标准）。
//
// 设计（docs/asr-design.md 同款约定）：能力层纯粹——不碰 HTTP 路由、不写 DB，
// server 内任意模块 / lego CLI / 冒烟测试都可直接 import；多轮对话靠调用方持有 messages 数组。
// 为实时聊天回复做的准备：chatStream() 提供增量回调，回答与思考过程分开回调。
import { loadDotEnv, resolveLLMConfig, type LLMConfig } from '../config.js';

export { loadDotEnv, resolveLLMConfig } from '../config.js';
export type { LLMConfig } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /**
   * 思考模式（qwen3 系混合思考模型，默认 true，与官方示例一致）：
   *   true  = 先思考再回答；协议要求必须走流式，chat() 内部也会转流式聚合
   *   false = 直接回答（支持非流式，延迟最低，适合程序内快速调用）
   */
  thinking?: boolean;
  /** 可选 system 提示词（前置到 messages） */
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

/** 流式增量回调（chatStream 用）：思考过程与正式回答分开 */
export interface ChatStreamCallbacks {
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
}

export interface ChatResult {
  /** 完整回答 */
  content: string;
  /** 思考过程全文（thinking 关闭时为空串） */
  reasoning: string;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class DashScopeLLM {
  constructor(private cfg: LLMConfig) {
    if (!cfg.apiKey) throw new Error('apiKey 不能为空：请通过环境变量 DASHSCOPE_API_KEY 或配置对象传入');
    if (!cfg.baseUrl) throw new Error('baseUrl 不能为空');
    if (!cfg.model) throw new Error('model 不能为空');
  }

  /**
   * 对话：传入完整 messages（多轮对话时由调用方维护并追加本结果的 content），
   * 返回聚合后的完整回答。
   */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    // 思考模式下协议要求流式，这里转 chatStream 静默聚合；关思考走非流式（延迟最低）
    if (opts.thinking !== false) return this.chatStream(messages, opts);
    return this.requestOnce(this.buildBody(messages, { ...opts, thinking: false, stream: false }));
  }

  /**
   * 流式对话：边生成边回调（实时聊天回复用），同时返回聚合结果。
   *
   * @example
   *   const llm = new DashScopeLLM(resolveLLMConfig());
   *   const result = await llm.chatStream(messages, {
   *     onContent: (d) => process.stdout.write(d),      // 实时显示回答
   *     onReasoning: (d) => process.stderr.write(d),    // 实时显示思考
   *   });
   */
  async chatStream(messages: ChatMessage[], opts: ChatOptions & ChatStreamCallbacks = {}): Promise<ChatResult> {
    const { onReasoning, onContent, ...rest } = opts;
    // 流式与思考是两个正交开关：本方法恒为流式（增量回调是它的契约），thinking 默认开
    const body = this.buildBody(messages, { ...rest, thinking: opts.thinking ?? true, stream: true });

    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
    });
    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
      throw new Error(`LLM 失败 HTTP ${res.status}: ${err?.error?.message ?? res.statusText}`);
    }

    // 解析 SSE：按行拆，`data:` 开头的才是事件帧，`[DONE]` 结束
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const result: ChatResult = { content: '', reasoning: '' };
    let buf = '';

    const handleEvent = (payload: string): void => {
      if (payload === '[DONE]') return;
      let json: {
        choices?: Array<{ delta?: { reasoning_content?: string; content?: string }; finish_reason?: string | null }>;
        usage?: ChatResult['usage'];
      };
      try {
        json = JSON.parse(payload);
      } catch {
        return; // 容忍个别非 JSON 帧
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta ?? {};
      if (delta.reasoning_content) {
        result.reasoning += delta.reasoning_content;
        onReasoning?.(delta.reasoning_content);
      }
      if (delta.content) {
        result.content += delta.content;
        onContent?.(delta.content);
      }
      if (choice?.finish_reason) result.finishReason = choice.finish_reason;
      if (json.usage) result.usage = json.usage;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
      }
    }
    return result;
  }

  /** 组装请求体（stream 与 thinking 是两个开关：开思考必须流式；stream_options 必须与 stream 成对出现） */
  private buildBody(messages: ChatMessage[], opts: ChatOptions & { thinking: boolean; stream: boolean }): Record<string, unknown> {
    const all: ChatMessage[] = opts.system ? [{ role: 'system', content: opts.system }, ...messages] : messages;
    return {
      model: this.cfg.model,
      messages: all,
      stream: opts.stream,
      enable_thinking: opts.thinking,
      ...(opts.stream && { stream_options: { include_usage: true } }),
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
    };
  }

  /** 非流式单发（thinking=false 专用路径） */
  private async requestOnce(body: Record<string, unknown>): Promise<ChatResult> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
    });
    const json = (await res.json().catch(() => null)) as
      | {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
          usage?: ChatResult['usage'];
          error?: { message?: string; code?: string };
        }
      | null;
    if (!res.ok) {
      throw new Error(`LLM 失败 HTTP ${res.status}: ${json?.error?.message ?? res.statusText}`);
    }
    const msg = json?.choices?.[0]?.message;
    return {
      content: msg?.content ?? '',
      reasoning: msg?.reasoning_content ?? '',
      finishReason: json?.choices?.[0]?.finish_reason,
      usage: json?.usage,
    };
  }
}

/**
 * 一行调用对话能力（自动加载 .env 配置；能力层保持纯粹，不写数据库）。
 * @param prompt 一句提问，或完整 messages 数组（多轮对话由调用方持有并追加回复）
 *
 * @example
 *   await chat('你是谁');                       // 单句
 *   await chat(history, { thinking: false });   // 多轮：history 由调用方维护
 *   const history: ChatMessage[] = [];
 *   for (const q of questions) {
 *     history.push({ role: 'user', content: q });
 *     const { content } = await chat(history);
 *     history.push({ role: 'assistant', content }); // 下一轮带着上下文
 *   }
 */
export async function chat(
  prompt: string | ChatMessage[],
  opts: ChatOptions & ChatStreamCallbacks = {},
): Promise<ChatResult> {
  loadDotEnv();
  const llm = new DashScopeLLM(resolveLLMConfig());
  const messages: ChatMessage[] =
    typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
  return opts.onContent || opts.onReasoning ? llm.chatStream(messages, opts) : llm.chat(messages, opts);
}
