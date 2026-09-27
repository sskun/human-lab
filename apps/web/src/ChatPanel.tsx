/**
 * 实时聊天面板（会话制 + 连续对话）：
 *   点击「开始聊天」→ 创建会话并开启免按键倾听（VAD 自动断句，直接说话即可）
 *   → 每轮 ASR → LLM（本会话上下文）→ TTS → 气泡展示 + 自动播放回复
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
  listening: '🎧 倾听中——直接说话即可，停顿后自动发送',
  speaking: '● 正在说话…',
};

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

  // 轮次变化时滚到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

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
      setTurns([]);
      setPaused(false);
      pausedRef.current = false;
      playingRef.current = false;
      refreshHistory();

      // 开麦：VAD 断句，说完整一句（停顿 ~1s）自动发送
      const rec = new AutoRecorder({
        onUtterance: (u) => void sendTurn({ audioBase64: u.wavBase64 }),
        onStateChange: (s) => setListenState(s),
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
      refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** 提交一轮（VAD 断句的语音 或 打字），轮次明细追加到气泡列表 */
  async function sendTurn(body: { text?: string; audioBase64?: string }) {
    if (!session) return;
    setError(null);
    setSending(true);
    sendingRef.current = true;
    updateGate(); // 处理期间闭麦
    clearCapTimer();
    try {
      const res = await fetch(`/api/chat/sessions/${session.id}/turns`, {
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

  /** 展开/收起某个历史会话的明细 */
  async function toggleHistory(id: string) {
    if (openHistory === id) {
      setOpenHistory(null);
      return;
    }
    if (!historyTurns[id]) {
      try {
        const res = await fetch(`/api/chat/sessions/${id}/turns`);
        if (!res.ok) throw new Error(`读取明细失败（HTTP ${res.status}）`);
        const turns = (await res.json()) as ChatTurnView[];
        setHistoryTurns((prev) => ({ ...prev, [id]: turns }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setOpenHistory(id);
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
            {starting ? '创建中…' : '▶ 开始聊天'}
          </button>
        )}
        {session && (
          <>
            <span className={`session-dot ${listeningOn && listenState === 'speaking' ? 'active' : listeningOn ? 'listening' : ''}`} />
            <span className="status">
              {active && paused && '⏸ 已暂停倾听（打字聊天仍可用）'}
              {active && !paused && LISTEN_STATE_LABEL[listenState ?? 'listening']}
              {!active && (
                <>
                  会话 <code>{session.id.slice(0, 8)}</code>（{session.turnCount} 轮）已结束 @ {session.endedAt}
                </>
              )}
              {active && sending && ' · 小泡泡思考中…'}
              {active && playing && ' · 回答中'}
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
                ▶ 再来一场
              </button>
            )}
          </>
        )}
      </div>

      {error && <p className="error">出错了：{error}</p>}

      {/* 对话气泡区 */}
      {session && (
        <div className="chat-box">
          {turns.length === 0 && !active && <p className="status">本场没有对话。</p>}
          {turns.length === 0 && active && <p className="status">开始直接说话吧——停顿约一秒小泡泡就会回答；也可以在下方打字。</p>}
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
                  <div className="bubble assistant">
                    {t.outputText}
                    {t.outputAudioUrl && (
                      <audio
                        className="bubble-audio"
                        controls
                        autoPlay={t.id === lastTurnId} // 只有最新一轮自动播放
                        src={t.outputAudioUrl}
                        onEnded={onReplyAudioEnded}
                        onError={onReplyAudioEnded}
                      />
                    )}
                  </div>
                </div>
              )}
              {t.status === 'failed' && t.error && (
                <div className="row assistant">
                  <div className="bubble assistant failed">（本轮失败：{t.error}）</div>
                </div>
              )}
            </div>
          ))}
          {sending && (
            <div className="row assistant">
              <div className="bubble assistant muted">听→想→说…</div>
            </div>
          )}
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
              {openHistory === s.id &&
                (historyTurns[s.id] ?? []).map((t) => (
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
            </div>
          ))}
        </section>
      )}
    </>
  );
}
