/**
 * 实时聊天页（会话制 + 连续对话）：
 *   点击「开始聊天」→ 创建会话并开启免按键倾听（VAD 自动断句，直接说话即可）
 *   → 每轮 ASR → LLM → TTS → 气泡展示 + 自动播放回复
 *   → 回答播放期间自动暂停收音（防止把喇叭里的回答录进去），播完自动恢复倾听
 *   → 点击「结束聊天」关闭会话。历史会话明细在后台「会话记录」查看。
 *   也可随时打字，或点「暂停倾听」闭麦。
 * 布局：左侧数字人舞台（形象 + 当前状态 + 会话控制），右侧对话区。
 */
import { useEffect, useRef, useState } from 'react';
import type { ChatSessionView, ChatTurnView } from '@human-lab/shared';
import { AutoRecorder, type ListenState } from '../recorder';
import { prefersReducedMotion, useMeta } from '../lib/api';
import { AvatarImage, Badge, EmptyState, ErrorBanner, Spinner, type Tone } from '../components/ui';
import { IconChat, IconMic, IconMicOff, IconPlay, IconSend, IconSquare, IconType } from '../components/Icons';

/** 处理一轮时（ASR→LLM→TTS）打字指示器轮换的阶段文案 */
const TYPING_STAGES = ['正在听你说话…', '正在思考…', '准备开口说…'];

/** 回复生成中的打字指示器：三点跳动 + 阶段文案轮换 */
function TypingBubble({ avatarUrl }: { avatarUrl?: string }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setStage((s) => (s + 1) % TYPING_STAGES.length), 1800);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="msg assistant">
      <AvatarImage src={avatarUrl} size="sm" alt="" />
      <div className="bubble assistant typing" role="status">
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

export default function ChatPage() {
  const meta = useMeta();
  const avatarUrl = meta?.avatar.imageUrl;

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
  const playingRef = useRef(false); // 回复音频播放中（ref 供回调读写，state 驱动状态显示）
  const capTimerRef = useRef<number | null>(null); // 播放结束的兜底恢复定时器

  // 文字输入
  const [inputText, setInputText] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null); // 对话区（自动滚到底）

  // 轮次变化 / 发送状态变化时把对话区滚到底（只滚容器，不带动整页）
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
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
      // 失败轮次服务端也会返回 turn（带 error），照常追加展示
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

  // 组件卸载（含切换页面）：关麦清定时器
  useEffect(
    () => () => {
      recorderRef.current?.stop();
      clearCapTimer();
    },
    [],
  );

  const lastTurnId = turns[turns.length - 1]?.id;
  const micOn = active && listenState !== null && !paused; // 麦克风在采集链路上（显示音量条）

  // 舞台状态：优先级 播放 > 思考 > 暂停 > 倾听子状态
  let stage: { tone: Tone; label: string; live: boolean };
  if (!session) stage = { tone: 'neutral', label: '未开始', live: false };
  else if (!active) stage = { tone: 'neutral', label: '会话已结束', live: false };
  else if (playing) stage = { tone: 'primary', label: '正在回答', live: true };
  else if (sending) stage = { tone: 'info', label: '思考中', live: true };
  else if (paused) stage = { tone: 'neutral', label: '已暂停倾听', live: false };
  else if (listenState === 'speaking') stage = { tone: 'warning', label: '你在说话', live: true };
  else if (listenState === 'calibrating') stage = { tone: 'info', label: '正在适应环境音', live: true };
  else if (listenState === 'listening') stage = { tone: 'success', label: '倾听中 · 停顿后自动发送', live: true };
  else stage = { tone: 'neutral', label: '麦克风未开启 · 可打字', live: false };

  const startButton = (label: string) => (
    <button className="btn btn-primary btn-lg" onClick={startChat} disabled={starting}>
      {starting ? <Spinner /> : <IconPlay size={16} />}
      {starting ? '创建中…' : label}
    </button>
  );

  return (
    <div className="chat-layout">
      {/* —— 数字人舞台 —— */}
      <section className="card stage" aria-label="数字人状态">
        <div className={`stage-avatar${stage.live ? ' live' : ''} tone-${stage.tone}`}>
          <AvatarImage src={avatarUrl} size="lg" />
        </div>
        <div className="stage-meta">
          <h1 className="stage-title">实时聊天</h1>
          <p className="stage-sub">直接说话，停顿约一秒自动接话</p>
        </div>

        <div className="stage-status" aria-live="polite">
          <Badge tone={stage.tone}>
            {stage.live && <span className="dot" aria-hidden />}
            {sending && <Spinner />}
            {stage.label}
          </Badge>
          {micOn && (
            <span className="level-meter" title="实时音量，超过刻度线判定为在说话" aria-hidden>
              <span className="level-fill" ref={levelFillRef} />
              <span className="level-mark" ref={levelMarkRef} />
            </span>
          )}
        </div>

        {session && !active && (
          <p className="stage-note">
            会话 <code>{session.id.slice(0, 8)}</code> 共 {session.turnCount} 轮，已于 {session.endedAt} 结束
          </p>
        )}

        <div className="stage-actions">
          {!session && startButton('开始聊天')}
          {active && (
            <>
              <button className="btn btn-secondary" onClick={togglePause} aria-pressed={paused}>
                {paused ? <IconMic size={16} /> : <IconMicOff size={16} />}
                {paused ? '继续倾听' : '暂停倾听'}
              </button>
              <button className="btn btn-danger" onClick={endChat}>
                <IconSquare size={14} />
                结束聊天
              </button>
            </>
          )}
          {session && !active && startButton('再来一场')}
        </div>

        {meta && (
          <dl className="stage-models">
            <div>
              <dt>识别</dt>
              <dd>{meta.models.asr}</dd>
            </div>
            <div>
              <dt>对话</dt>
              <dd>{meta.models.llm}</dd>
            </div>
            <div>
              <dt>语音</dt>
              <dd>{meta.models.tts}</dd>
            </div>
          </dl>
        )}
      </section>

      {/* —— 对话区 —— */}
      <section className="card convo" aria-label="对话">
        {error && <ErrorBanner>出错了：{error}</ErrorBanner>}

        <div className="convo-list" ref={listRef}>
          {!session && (
            <EmptyState
              icon={<IconChat size={26} />}
              title="准备好了就开始吧"
              hint="点击「开始聊天」并允许麦克风：直接说话，停顿约一秒自动接话；也可以随时打字。"
            />
          )}
          {session && turns.length === 0 && !active && <p className="convo-note">本场没有对话。</p>}
          {session && turns.length === 0 && active && (
            <EmptyState
              icon={<IconMic size={26} />}
              title="开始说点什么吧"
              hint="直接说话，停顿约一秒就会回答；也可以在下方打字。"
            />
          )}
          {turns.map((t) => (
            <div key={t.id} className="turn">
              {/* 输入气泡（用户） */}
              <div className="msg user">
                <div className={`bubble user${t.status === 'failed' && !t.inputText ? ' failed' : ''}`}>
                  {t.inputType === 'voice' && (
                    <span className="bubble-tag" title="语音输入">
                      <IconMic size={12} />
                      <span className="sr-only">语音：</span>
                    </span>
                  )}
                  {t.inputText || <span className="muted">（没听清）</span>}
                </div>
              </div>
              {/* 输出气泡（数字人） */}
              {t.outputText && (
                <div className="msg assistant">
                  <AvatarImage src={avatarUrl} size="sm" alt="" />
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
                <div className="msg assistant">
                  <AvatarImage src={avatarUrl} size="sm" alt="" />
                  <div className="bubble assistant failed">本轮失败：{t.error}</div>
                </div>
              )}
            </div>
          ))}
          {sending && <TypingBubble avatarUrl={avatarUrl} />}
        </div>

        {/* 文字输入行（倾听/暂停时都可打字） */}
        <div className="composer">
          <label className="composer-field">
            <IconType size={16} className="composer-icon" />
            <span className="sr-only">打字发言</span>
            <input
              className="composer-input"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void sendText();
              }}
              placeholder={active ? '也可以打字，Enter 发送' : '开始聊天后可打字'}
              disabled={!active}
            />
          </label>
          <button
            className="btn btn-primary btn-icon"
            onClick={() => void sendText()}
            disabled={!active || sending || !inputText.trim()}
            aria-label="发送"
          >
            <IconSend size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
