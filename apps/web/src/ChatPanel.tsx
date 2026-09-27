/**
 * 实时聊天面板（会话制 + 连续对话）：
 *   点击「开始聊天」→ 创建会话并开启免按键倾听（VAD 自动断句，直接说话即可）
 *   → 每轮 ASR → LLM → TTS → 气泡展示 + 自动播放回复
 *   → 回答播放期间自动暂停收音（防止把喇叭里的回答录进去），播完自动恢复倾听
 *   → 点击「结束聊天」关闭会话；下方可展开历史会话的输入/输出明细。
 *   也可随时用文字输入，或点「暂停倾听」让小泡泡闭麦。
 */
import { useEffect, useRef, useState } from 'react';
import type { ChatSessionView, ChatTurnView } from '@human-lab/shared';
import { AutoRecorder, type ListenState } from './recorder';
import './App.css';

const LISTEN_STATE_LABEL: Record<ListenState, string> = {
  calibrating: '🎧 正在适应环境音…',
  listening: '🎧 倾听中 · 停顿后自动发送',
  speaking: '🎤 你在说话…',
};

/** 处理一轮时（ASR→LLM→TTS）打字指示器轮换的阶段文案 */
const TYPING_STAGES = ['正在听你说话…', '小泡泡在想…', '准备开口说…'];

/** 回复生成中的打字指示器：三点跳动 + 阶段文案轮换 */
function TypingBubble() {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setStage((s) => (s + 1) % TYPING_STAGES.length), 1800);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="row assistant">
      <span className="avatar" aria-hidden>
        🫧
      </span>
      <div className="bubble assistant typing">
        <span className="typing-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="typing-stage" key={stage}>
          {TYPING_STAGES[stage]}
        </span>
      </div>
    </div>
  );
}

export default function ChatPanel() {
  // 当前会话
  const [session, setSession] = useState<ChatSessionView | null>(null);
  const [turns, setTurns] = useState<ChatTurnView[]>([]);
  const [starting, setStarting] = useState(false);
  const active = session?.status === 'active';

  // 连续倾听
  const [listenState, setListenState] = useState<ListenState | null>(null); // null = 麦克风未开
  const [paused, setPaused] = useState(false); // 用户主动暂停
  const [sending, setSending] = useState(false); // 一轮处理中（ASR→LLM→TTS）
  const [playing, setPlaying] = useState(false); // 回复音频播放中（收音闸门关闭中）
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<AutoRecorder | null>(null);
  const sessionRef = useRef<ChatSessionView | null>(null); // 供录音回调读取（state 闭包会过期）
  const levelFillRef = useRef<HTMLSpanElement | null>(null); // 实时音量条（直改 DOM，不走 setState）
  const levelMarkRef = useRef<HTMLSpanElement | null>(null); // 阈值刻度
  const pausedRef = useRef(false);
  const sendingRef = useRef(false);
  const playingRef = useRef(false); // 回复音频播放中（ref 供回调读写，state 驱动状态条显示）
  const capTimerRef = useRef<number | null>(null); // 播放结束的兜底恢复定时器

  // 文字输入
  const [inputText, setInputText] = useState('');

  // 历史
  const [history, setHistory] = useState<ChatSessionView[]>([]);
  const [historyTurns, setHistoryTurns] = useState<Record<string, ChatTurnView[]>>({}); // sessionId → 明细
  const [openHistory, setOpenHistory] = useState<string | null>(null); // 展开中的会话 id
  const bottomRef = useRef<HTMLDivElement | null>(null); // 聊天区自动滚到底

  const refreshHistory = () => {
    void fetch('/api/chat/sessions')
      .then((r) => r.json())
      .then((list: ChatSessionView[]) => setHistory(list))
      .catch(() => undefined);
  };
  useEffect(refreshHistory, []);

  // 轮次变化 / 发送状态变化时滚到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, sending]);

  /** 收音闸门：用户暂停 / 处理中 / 回答播放中 任一成立就停止采集（防自问自答），其余时间倾听 */
  function updateGate(): void {
    const on = !pausedRef.current && !sendingRef.current && !playingRef.current;
    recorderRef.current?.setCapture(on);
  }

  function clearCapTimer(): void {
    if (capTimerRef.current !== null) {
      window.clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
  }

  /** 点击「开始聊天」：建会话 + 开麦倾听 */
  async function startChat() {
    setError(null);
    setStarting(true);
    try {
      const res = await fetch('/api/chat/sessions', { method: 'POST' });
      if (!res.ok) throw new Error(`开始聊天失败（HTTP ${res.status}）`);
      const body = (await res.json()) as { session: ChatSessionView };
      setSession(body.session);
      sessionRef.current = body.session;
      setTurns([]);
      setPaused(false);
      pausedRef.current = false;
      playingRef.current = false;
      refreshHistory();

      // 开麦：VAD 断句，说完整一句（停顿 ~1s）自动发送
      const rec = new AutoRecorder({
        onUtterance: (u) => void sendTurn({ audioBase64: u.wavBase64 }),
        onStateChange: (s) => setListenState(s),
        // 实时电平条：0.25 的 RMS 拉满格，阈值位置画刻度——"为什么不发送"一眼可查
        onLevel: (rms, threshold) => {
          const pct = (v: number) => `${Math.min(100, Math.max(2, (v / 0.25) * 100))}%`;
          if (levelFillRef.current) levelFillRef.current.style.width = pct(rms);
          if (levelMarkRef.current) levelMarkRef.current.style.left = pct(threshold);
        },
      });
      recorderRef.current = rec;
      await rec.start();
      updateGate();
    } catch (e) {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setListenState(null);
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        setError('麦克风权限被拒绝：请在浏览器地址栏允许使用麦克风（仍可打字聊天）');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setStarting(false);
    }
  }

  /** 点击「结束聊天」：关会话 + 关麦 */
  async function endChat() {
    if (!session) return;
    setError(null);
    clearCapTimer();
    recorderRef.current?.stop();
    recorderRef.current = null;
    setListenState(null);
    try {
      const res = await fetch(`/api/chat/sessions/${session.id}/end`, { method: 'POST' });
      if (!res.ok) throw new Error(`结束聊天失败（HTTP ${res.status}）`);
      const body = (await res.json()) as { session: ChatSessionView };
      setSession(body.session);
      sessionRef.current = body.session;
      refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** 提交一轮（VAD 断句的语音 或 打字），轮次明细追加到气泡列表 */
  async function sendTurn(body: { text?: string; audioBase64?: string }) {
    const current = sessionRef.current;
    if (!current) return;
    setError(null);
    setSending(true);
    sendingRef.current = true;
    updateGate(); // 处理期间闭麦
    clearCapTimer();
    try {
      const res = await fetch(`/api/chat/sessions/${current.id}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { turn?: ChatTurnView; error?: string } | null;
      if (data?.turn) {
        setTurns((prev) => [...prev, data.turn!]);
        if (data.turn.outputAudioUrl) {
          playingRef.current = true; // 播放期间闭麦，onEnded/兜底定时器恢复
          setPlaying(true);
          armPlaybackFallback();
        }
      } else if (!res.ok) {
        throw new Error(data?.error ?? `发送失败（HTTP ${res.status}）`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      sendingRef.current = false;
      updateGate();
    }
  }

  /** 兜底：音频元素的 onEnded 万一不触发（如浏览器拦截自动播放），按时长上限恢复收音 */
  function armPlaybackFallback(): void {
    clearCapTimer();
    capTimerRef.current = window.setTimeout(() => {
      if (playingRef.current) {
        playingRef.current = false;
        setPlaying(false);
        updateGate();
      }
    }, 60_000);
  }

  function onReplyAudioMeta(e: React.SyntheticEvent<HTMLAudioElement>): void {
    // 元数据里拿到真实时长，把兜底恢复定时器定到 播完+8s
    const duration = e.currentTarget.duration;
    if (Number.isFinite(duration) && duration > 0) {
      clearCapTimer();
      capTimerRef.current = window.setTimeout(
        () => {
          if (playingRef.current) {
            playingRef.current = false;
            setPlaying(false);
            updateGate();
          }
        },
        (duration + 8) * 1000,
      );
    }
  }

  function onReplyAudioEnded(): void {
    playingRef.current = false;
    setPlaying(false);
    clearCapTimer();
    updateGate();
  }

  /** 暂停/继续倾听（用户主动闭麦） */
  function togglePause(): void {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    updateGate();
  }

  /** 打字发言（Enter 发送） */
  async function sendText() {
    const text = inputText.trim();
    if (!text || !active || sending) return;
    setInputText('');
    await sendTurn({ text });
  }

  /** 展开/收起某个历史会话的明细（先展开再拉取，拉取中显示加载态） */
  async function toggleHistory(id: string) {
    if (openHistory === id) {
      setOpenHistory(null);
      return;
    }
    setOpenHistory(id);
    if (!historyTurns[id]) {
      try {
        const res = await fetch(`/api/chat/sessions/${id}/turns`);
        if (!res.ok) throw new Error(`读取明细失败（HTTP ${res.status}）`);
        const turns = (await res.json()) as ChatTurnView[];
        setHistoryTurns((prev) => ({ ...prev, [id]: turns }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setOpenHistory(null);
      }
    }
  }

  // 组件卸载：关麦清定时器
  useEffect(
    () => () => {
      recorderRef.current?.stop();
      clearCapTimer();
    },
    [],
  );

  const lastTurnId = turns[turns.length - 1]?.id;
  const listeningOn = active && listenState !== null && !paused && !sending; // 麦克风开着

  return (
    <>
      {/* 会话控制条：开始/结束 + 倾听状态 */}
      <div className="session-bar">
        {!session && (
          <button className="btn" onClick={startChat} disabled={starting}>
            {starting ? (
              <>
                <span className="spinner" /> 创建中…
              </>
            ) : (
              '▶ 开始聊天'
            )}
          </button>
        )}
        {session && (
          <>
            <span
              className={`session-dot ${
                listeningOn && listenState === 'speaking' ? 'active' : listeningOn ? 'listening' : ''
              }`}
            />
            {active && listenState !== null && !paused && (
              <span className="level-meter" title="实时音量，超过刻度线判定为在说话">
                <span className="level-fill" ref={levelFillRef} />
                <span className="level-mark" ref={levelMarkRef} />
              </span>
            )}
            <span className="status">
              {active && paused && <span className="pill pill-paused">⏸ 已暂停倾听（打字聊天仍可用）</span>}
              {active && !paused && (
                <span className={`pill ${listenState === 'speaking' ? 'pill-speaking' : 'pill-listening'}`}>
                  {LISTEN_STATE_LABEL[listenState ?? 'listening']}
                </span>
              )}
              {!active && (
                <span className="pill pill-ended">
                  会话 <code>{session.id.slice(0, 8)}</code>（{session.turnCount} 轮）已结束 @ {session.endedAt}
                </span>
              )}
              {active && sending && (
                <span className="pill pill-thinking">
                  <span className="spinner" />
                  小泡泡思考中…
                </span>
              )}
              {active && playing && <span className="pill pill-playing">🔊 回答中</span>}
            </span>
            {active && (
              <>
                <button className="btn mute-btn" onClick={togglePause}>
                  {paused ? '▶ 继续倾听' : '⏸ 暂停倾听'}
                </button>
                <button className="btn end-btn" onClick={endChat}>
                  ■ 结束聊天
                </button>
              </>
            )}
            {!active && (
              <button className="btn" onClick={startChat} disabled={starting}>
                {starting ? (
                  <>
                    <span className="spinner" /> 创建中…
                  </>
                ) : (
                  '▶ 再来一场'
                )}
              </button>
            )}
          </>
        )}
      </div>

      {error && <p className="error-banner">⚠️ 出错了：{error}</p>}

      {/* 未开场：欢迎空状态 */}
      {!session && (
        <div className="empty-state">
          <div className="empty-avatar">🫧</div>
          <p className="empty-title">嗨，我是小泡泡</p>
          <p className="empty-hint">
            点击上方「开始聊天」就能开口聊——直接说话，停顿约一秒我会自动接话；也欢迎随时打字。
          </p>
        </div>
      )}

      {/* 对话气泡区 */}
      {session && (
        <div className="chat-box">
          {turns.length === 0 && !active && <p className="chat-note">本场没有对话。</p>}
          {turns.length === 0 && active && (
            <div className="empty-state compact">
              <div className="empty-avatar">🫧</div>
              <p className="empty-title">开始说点什么吧</p>
              <p className="empty-hint">直接说话，停顿约一秒小泡泡就会回答；也可以在下方打字。</p>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id}>
              {/* 输入气泡（用户） */}
              <div className="row user">
                <div className={`bubble user${t.status === 'failed' && !t.inputText ? ' failed' : ''}`}>
                  {t.inputType === 'voice' && <span className="tag">🎤</span>}
                  {t.inputText || <span className="muted">（没听清）</span>}
                </div>
              </div>
              {/* 输出气泡（小泡泡） */}
              {t.outputText && (
                <div className="row assistant">
                  <span className="avatar" aria-hidden>
                    🫧
                  </span>
                  <div className="bubble assistant">
                    {t.outputText}
                    {t.outputAudioUrl && (
                      <audio
                        className="bubble-audio"
                        controls
                        autoPlay={t.id === lastTurnId} // 只有最新一轮自动播放
                        src={t.outputAudioUrl}
                        onLoadedMetadata={onReplyAudioMeta}
                        onEnded={onReplyAudioEnded}
                        onError={onReplyAudioEnded}
                      />
                    )}
                  </div>
                </div>
              )}
              {t.status === 'failed' && t.error && (
                <div className="row assistant">
                  <span className="avatar" aria-hidden>
                    🫧
                  </span>
                  <div className="bubble assistant failed">（本轮失败：{t.error}）</div>
                </div>
              )}
            </div>
          ))}
          {sending && <TypingBubble />}
          <div ref={bottomRef} />
        </div>
      )}

      {/* 文字输入行（倾听/暂停时都可打字） */}
      {active && (
        <div className="btn-row chat-input-row">
          <input
            className="input chat-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void sendText();
            }}
            placeholder="也可以打字…"
          />
          <button className="btn" onClick={() => void sendText()} disabled={sending || !inputText.trim()}>
            发送
          </button>
        </div>
      )}

      {/* 历史会话（输入/输出明细） */}
      {history.length > 0 && (
        <section className="history">
          <h2>聊天记录</h2>
          {history.map((s) => (
            <div key={s.id} className="history-item">
              <button className="history-head" onClick={() => void toggleHistory(s.id)}>
                <span>
                  <code>{s.id.slice(0, 8)}</code> · {s.startedAt} ~ {s.endedAt ?? '进行中'} · {s.turnCount} 轮
                </span>
                <span>{openHistory === s.id ? '▲ 收起' : '▼ 明细'}</span>
              </button>
              {openHistory === s.id && (
                <>
                  {!historyTurns[s.id] && (
                    <div className="history-loading">
                      <span className="spinner" />
                      加载明细中…
                    </div>
                  )}
                  {(historyTurns[s.id] ?? []).map((t) => (
                    <div key={t.id} className="history-turn">
                      <div>
                        <span className="tag">#{t.idx} 输入({t.inputType})</span> {t.inputText}
                        {t.inputAudioUrl && (
                          <a className="tag" href={t.inputAudioUrl} target="_blank" rel="noreferrer">
                            ▶ 原声
                          </a>
                        )}
                      </div>
                      <div>
                        <span className="tag">输出</span> {t.outputText ?? <span className="muted">（无）</span>}
                        {t.outputAudioUrl && (
                          <a className="tag" href={t.outputAudioUrl} target="_blank" rel="noreferrer">
                            ▶ 回复音频
                          </a>
                        )}
                      </div>
                      {t.error && <div className="error">失败：{t.error}</div>}
                    </div>
                  ))}
                  {historyTurns[s.id] && (historyTurns[s.id] ?? []).length === 0 && (
                    <div className="history-loading">（本场没有轮次明细）</div>
                  )}
                </>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
