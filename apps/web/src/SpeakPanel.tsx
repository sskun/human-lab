/**
 * 朗读模式（原 Demo 主界面）：
 *   文本框输入/按住说话 → POST /api/speak 拿 taskId → 每秒轮询 GET /api/tasks/:id
 *   → done 后播放：纯音频任务播 <audio>；勾选「口播视频」的任务播 <video>（带 AI 生成角标）
 */
import { useEffect, useRef, useState } from 'react';
import type { ListenResponse, SpeakResponse, TaskView } from '@human-lab/shared';
import { MicRecorder } from './recorder';
import './App.css';

/** 单次录音上限（秒），到时自动截断送识别，防止误触长录 */
const MAX_RECORD_SECONDS = 60;
/** 口播视频单条的字数上限（对应参考音频 ≤15s，与 server LIPSYNC_TEXT_MAX_CHARS 一致） */
const MAX_VIDEO_TEXT_CHARS = 60;

export default function SpeakPanel() {
  const [text, setText] = useState('你好，我是你的专属数字人，很高兴认识你。');
  const [withVideo, setWithVideo] = useState(false); // 勾选：生成数字人口播视频（分钟级）
  const [taskId, setTaskId] = useState<string | null>(null); // 当前轮询的任务
  const [task, setTask] = useState<TaskView | null>(null); // 最近一次查询到的任务状态
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

  /** 提交合成/口播任务（vite 已把 /api 代理到后端:3001，所以直接写相对路径） */
  async function handleSpeak() {
    setError(null);
    setTask(null);
    setTaskId(null);
    if (withVideo && text.trim().length > MAX_VIDEO_TEXT_CHARS) {
      setError(`口播视频单条最长约 15 秒：请把文案控制在 ${MAX_VIDEO_TEXT_CHARS} 字以内（当前 ${text.trim().length} 字）`);
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

  /** 松开麦克风：停止录音 → 上传识别 → 文字回填文本框 */
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
      const body = (await res.json().catch(() => null)) as ListenResponse & { error?: string } | null;
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

  return (
    <>
      <textarea
        className="input"
        value={text}
        rows={4}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入要让数字人说的话，或按住下方麦克风说话…"
      />

      <div className="btn-row">
        <button className="btn" onClick={handleSpeak} disabled={submitting || busy || recording || listening || !text.trim()}>
          {submitting ? (
            <>
              <span className="spinner" /> 提交中…
            </>
          ) : busy ? (
            <>
              <span className="spinner" /> {withVideo ? '生成中…' : '合成中…'}
            </>
          ) : (
            '合成语音'
          )}
        </button>
        <label className="video-toggle" title="用 wan3.0 生成数字人口播视频，耗时约 1 分钟">
          <input
            type="checkbox"
            checked={withVideo}
            onChange={(e) => setWithVideo(e.target.checked)}
            disabled={busy || submitting}
          />
          生成数字人口播视频
        </label>
        <button
          className={`btn mic-btn${recording ? ' recording' : ''}`}
          disabled={listening || busy || submitting}
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
          {recording ? (
            `● 录音中 0:${String(recSeconds).padStart(2, '0')}，松开结束`
          ) : listening ? (
            <>
              <span className="spinner" /> 识别中…
            </>
          ) : (
            '🎤 按住说话'
          )}
        </button>
      </div>

      {error && <p className="error-banner">⚠️ 出错了：{error}</p>}
      {listenNote && <p className="status">{listenNote}</p>}

      {task && (
        <div className="status task-status">
          <span className="pill pill-ended">
            任务 <code>{task.id.slice(0, 8)}</code>
          </span>
          {task.status === 'queued' && (
            <span className="pill pill-thinking">
              <span className="spinner" />
              排队中…
            </span>
          )}
          {task.status === 'processing' && (
            <span className="pill pill-thinking">
              <span className="spinner" />
              {task.stage === 'lipsync'
                ? '口播视频生成中，约 1 分钟，请稍候…'
                : task.stage === 'tts'
                  ? '合成中…'
                  : '处理中…'}
            </span>
          )}
          {task.status === 'failed' && <span className="pill pill-failed">失败（{task.error}）</span>}
          {task.status === 'done' && <span className="pill pill-listening">完成 ✔</span>}
        </div>
      )}

      {/* done 后展示播放器；key 使新任务自动替换旧播放器。口播任务优先播视频（叠加 AI 生成角标） */}
      {task?.status === 'done' && task.videoUrl && (
        <div className="video-wrap" key={task.videoUrl}>
          <video className="player" controls autoPlay playsInline src={task.videoUrl} />
          <span className="ai-badge">AI 生成</span>
        </div>
      )}
      {task?.status === 'done' && !task.videoUrl && task.audioUrl && (
        <audio className="player" controls autoPlay src={task.audioUrl} key={task.audioUrl} />
      )}
    </>
  );
}
