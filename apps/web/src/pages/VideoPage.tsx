/**
 * 数字人视频页：
 *   文本框输入/按住说话 → POST /api/speak 拿 taskId → 每秒轮询 GET /api/tasks/:id
 *   → done 后播放：「口播视频」任务播 <video>（带 AI 生成角标），「仅语音」任务播 <audio>
 * 布局：左侧文案编辑（字数计数 + 模式切换 + 按住说话），右侧 9:16 预览（阶段进度 / 成片）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ListenResponse, SpeakResponse, TaskView } from '@human-lab/shared';
import { MicRecorder } from '../recorder';
import { useMeta } from '../lib/api';
import { pipelineSteps } from '../lib/video';
import { AvatarImage, Badge, ErrorBanner, Spinner } from '../components/ui';
import { IconCheck, IconClock, IconMic, IconSparkles, IconVideo, IconVolume } from '../components/Icons';

/** 单次录音上限（秒），到时自动截断送识别，防止误触长录 */
const MAX_RECORD_SECONDS = 60;
/** 口播视频字数上限兜底值（/api/meta 未返回时使用，与 server LIPSYNC_TEXT_MAX_CHARS 默认一致） */
const FALLBACK_VIDEO_TEXT_CHARS = 60;

export default function VideoPage() {
  const meta = useMeta();
  const maxChars = meta?.limits.videoTextMaxChars ?? FALLBACK_VIDEO_TEXT_CHARS;

  const [text, setText] = useState('你好，我是你的专属数字人，很高兴认识你。');
  const [withVideo, setWithVideo] = useState(false); // 口播视频（分钟级）/ 仅语音（秒级）
  const [taskId, setTaskId] = useState<string | null>(null); // 当前轮询的任务
  const [task, setTask] = useState<TaskView | null>(null); // 最近一次查询到的任务状态
  const [taskWithVideo, setTaskWithVideo] = useState(false); // 当前任务提交时的模式（进度条步骤用）
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null); // 轮询定时器句柄（清理用）

  // —— 语音识别（按住说话）——
  const [recording, setRecording] = useState(false); // 正在按住录音
  const [listening, setListening] = useState(false); // 录音已结束，识别中
  const [recSeconds, setRecSeconds] = useState(0); // 录音计时（显示用）
  const [listenNote, setListenNote] = useState<string | null>(null); // 识别的提示（如空结果）
  const recorderRef = useRef<MicRecorder | null>(null);
  const recTickRef = useRef<number | null>(null); // 录音计时器句柄
  const recSecondsRef = useRef(0); // 计时器闭包读不到最新 state，用 ref 判断是否到上限

  const charCount = text.trim().length;
  const overLimit = withVideo && charCount > maxChars;

  /** 提交合成/口播任务（vite 已把 /api 代理到后端:3101，所以直接写相对路径） */
  async function handleSpeak() {
    setError(null);
    setTask(null);
    setTaskId(null);
    if (overLimit) {
      setError(`口播视频单条最长约 15 秒：请把文案控制在 ${maxChars} 字以内（当前 ${charCount} 字）`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, withVideo }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `提交失败（HTTP ${res.status}）`);
      }
      const data = (await res.json()) as SpeakResponse;
      setTaskWithVideo(withVideo);
      setStartedAt(Date.now());
      setElapsed(0);
      setTaskId(data.taskId); // 触发下方 useEffect 开始轮询
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  /** 按下麦克风：开始录音（出错时给出可操作的提示） */
  async function startRec() {
    if (recording || listening || submitting) return;
    setError(null);
    setListenNote(null);
    try {
      const rec = new MicRecorder();
      recorderRef.current = rec;
      await rec.start();
      setRecording(true);
      recSecondsRef.current = 0;
      setRecSeconds(0);
      recTickRef.current = window.setInterval(() => {
        recSecondsRef.current += 1;
        setRecSeconds(recSecondsRef.current);
        if (recSecondsRef.current >= MAX_RECORD_SECONDS) void stopAndSend(); // 到上限自动截断
      }, 1000);
    } catch (e) {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? '麦克风权限被拒绝：请在浏览器地址栏允许使用麦克风后重试'
          : e instanceof Error
            ? `无法开始录音：${e.message}`
            : String(e),
      );
    }
  }

  /** 松开麦克风：停止录音 → 上传识别 → 文字追加到文本框 */
  async function stopAndSend() {
    const rec = recorderRef.current;
    if (!rec) return;
    if (recTickRef.current !== null) {
      window.clearInterval(recTickRef.current);
      recTickRef.current = null;
    }
    setRecording(false);
    recorderRef.current = null;
    setListening(true);
    try {
      const data = await rec.stop();
      if (!data) throw new Error('录音数据为空');
      if (data.durationMs < 300) {
        setListenNote('录音太短，按住按钮说话后再松开');
        return;
      }
      const res = await fetch('/api/listen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: data.wavBase64, format: 'wav' }),
      });
      const body = (await res.json().catch(() => null)) as (ListenResponse & { error?: string }) | null;
      if (!res.ok) {
        // 按住但没说话（上游未检测到语音）不算故障，给引导性提示即可
        if (body?.error?.includes('ASR_RESPONSE_HAVE_NO_WORDS')) {
          setListenNote('没有听清：按住按钮后请对着麦克风说话');
          return;
        }
        throw new Error(body?.error ?? `识别失败（HTTP ${res.status}）`);
      }
      if (!body?.text) {
        setListenNote('没有听清，没识别到内容');
        return;
      }
      setText((prev) => (prev ? prev + body.text : body.text)); // 追加，可改后合成
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setListening(false);
    }
  }

  // 组件卸载时清理录音与计时器
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      if (recTickRef.current !== null) window.clearInterval(recTickRef.current);
    },
    [],
  );

  // 轮询任务状态：taskId 存在时每 1s 查一次，直到 done / failed
  useEffect(() => {
    if (!taskId) return;
    let stopped = false;

    const stop = () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const poll = async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`);
        if (!res.ok) throw new Error(`查询失败（HTTP ${res.status}）`);
        const data = (await res.json()) as TaskView;
        if (stopped) return;
        setTask(data);
        if (data.status === 'done' || data.status === 'failed') stop(); // 终态，停止轮询
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e.message : String(e));
        stop();
      }
    };

    void poll(); // 立刻查一次，不等 1s
    timerRef.current = window.setInterval(poll, 1000);

    // 组件卸载 / taskId 变化时清理定时器
    return () => {
      stopped = true;
      stop();
    };
  }, [taskId]);

  const busy = taskId !== null && task !== null && (task.status === 'queued' || task.status === 'processing');
  // 已提交、首次轮询结果未到（轮询出错则不算，避免进度卡在排队）
  const pending = taskId !== null && task === null && !error;

  // 进行中计时（仅展示用）
  useEffect(() => {
    if (!(busy || pending) || startedAt === null) return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [busy, pending, startedAt]);

  // 阶段进度：仅语音跳过「生成视频」；只在已提交后渲染（pending || task）
  const steps = pipelineSteps(taskWithVideo, task);
  const failed = task?.status === 'failed';

  const doneVideo = task?.status === 'done' ? task.videoUrl : undefined;
  const doneAudio = task?.status === 'done' && !task.videoUrl ? task.audioUrl : undefined;
  const controlsLocked = busy || pending || submitting;

  return (
    <div className="video-layout">
      {/* —— 文案编辑 —— */}
      <section className="card composer-card" aria-labelledby="video-title">
        <div className="card-head">
          <div>
            <h1 id="video-title" className="card-title">
              数字人视频
            </h1>
            <p className="card-sub">输入文案或按住说话，生成数字人口播视频或语音</p>
          </div>
        </div>

        <div className="segmented" role="radiogroup" aria-label="生成类型">
          <button
            type="button"
            role="radio"
            aria-checked={withVideo}
            className={`segment${withVideo ? ' on' : ''}`}
            onClick={() => setWithVideo(true)}
            disabled={controlsLocked}
          >
            <IconVideo size={16} />
            口播视频
            <span className="segment-hint">约 1 分钟</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!withVideo}
            className={`segment${!withVideo ? ' on' : ''}`}
            onClick={() => setWithVideo(false)}
            disabled={controlsLocked}
          >
            <IconVolume size={16} />
            仅语音
            <span className="segment-hint">数秒</span>
          </button>
        </div>

        <label className="field">
          <span className="field-label">文案</span>
          <textarea
            className={`textarea${overLimit ? ' invalid' : ''}`}
            value={text}
            rows={6}
            onChange={(e) => setText(e.target.value)}
            placeholder="输入要让数字人说的话，或按住下方按钮说话…"
            aria-invalid={overLimit}
            aria-describedby="text-count"
          />
          <span id="text-count" className={`field-foot${overLimit ? ' over' : ''}`}>
            {withVideo ? (
              <>
                {overLimit ? `超出 ${charCount - maxChars} 字，口播单条最长约 15 秒` : '口播单条最长约 15 秒'}
                <span className="count">
                  {charCount} / {maxChars}
                </span>
              </>
            ) : (
              <>
                仅语音模式不限字数
                <span className="count">{charCount} 字</span>
              </>
            )}
          </span>
        </label>

        {listenNote && <p className="note">{listenNote}</p>}
        {error && <ErrorBanner>出错了：{error}</ErrorBanner>}

        <div className="actions">
          <button
            className={`btn btn-secondary mic-btn${recording ? ' recording' : ''}`}
            disabled={listening || controlsLocked}
            onPointerDown={(e) => {
              e.preventDefault(); // 避免按住时选中文本/触发拖拽
              void startRec();
            }}
            onPointerUp={() => {
              if (recording) void stopAndSend();
            }}
            onPointerCancel={() => {
              if (recording) void stopAndSend();
            }}
            onContextMenu={(e) => e.preventDefault()} // 长按弹出系统菜单会打断 pointerup
          >
            {listening ? <Spinner /> : <IconMic size={16} />}
            {recording
              ? `录音中 0:${String(recSeconds).padStart(2, '0')} · 松开结束`
              : listening
                ? '识别中…'
                : '按住说话'}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSpeak}
            disabled={controlsLocked || recording || listening || !text.trim()}
          >
            {controlsLocked ? <Spinner /> : withVideo ? <IconSparkles size={16} /> : <IconVolume size={16} />}
            {submitting ? '提交中…' : busy || pending ? (taskWithVideo ? '生成中…' : '合成中…') : withVideo ? '生成口播视频' : '合成语音'}
          </button>
        </div>
      </section>

      {/* —— 预览 —— */}
      <section className="card preview-card" aria-label="预览">
        <div className="card-head">
          <h2 className="card-title">预览</h2>
          {task && (
            <span className="task-id">
              任务 <code>{task.id.slice(0, 8)}</code>
            </span>
          )}
        </div>

        {(pending || task) && (
          <ol className="steps" aria-label="生成进度">
            {steps.map((s) => {
              const st = s.state;
              return (
                <li key={s.key} className={`step step-${st}`} aria-current={st === 'doing' ? 'step' : undefined}>
                  <span className="step-dot" aria-hidden>
                    {st === 'done' ? <IconCheck size={14} /> : st === 'doing' ? <Spinner /> : null}
                  </span>
                  <span className="step-label">{s.label}</span>
                </li>
              );
            })}
          </ol>
        )}

        <div className="frame">
          {doneVideo ? (
            <div className="frame-media" key={doneVideo}>
              <video className="frame-video" controls autoPlay playsInline src={doneVideo} />
              <span className="ai-badge">AI 生成</span>
            </div>
          ) : (
            <div className={`frame-placeholder${busy || pending ? ' busy' : ''}`}>
              <AvatarImage src={meta?.avatar.imageUrl} size="lg" />
              <div className="frame-caption" aria-live="polite">
                {busy || pending ? (
                  <>
                    <Badge tone="info">
                      <Spinner />
                      {task?.stage === 'lipsync'
                        ? '口播视频生成中，约 1 分钟'
                        : task?.status === 'processing'
                          ? '合成中…'
                          : '排队中…'}
                    </Badge>
                    <span className="elapsed">
                      <IconClock size={14} />
                      已用时 {elapsed}s
                    </span>
                  </>
                ) : failed ? (
                  <Badge tone="danger">生成失败：{task?.error ?? '未知错误'}</Badge>
                ) : doneAudio ? (
                  <Badge tone="success">语音已生成</Badge>
                ) : (
                  <span className="frame-hint">生成结果会出现在这里</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* key 使新任务自动替换旧播放器 */}
        {doneAudio && <audio className="audio-player" controls autoPlay src={doneAudio} key={doneAudio} />}
      </section>
    </div>
  );
}
