// 后台各子页共用：级别/状态的徽标映射、刷新按钮、加载与错误占位
import type { LogLevel, TaskStatus } from '@human-lab/shared';
import { Badge, ErrorBanner, Spinner, type Tone } from '../../components/ui';
import { IconRefresh } from '../../components/Icons';

const LEVEL_TONE: Record<LogLevel, Tone> = { debug: 'neutral', info: 'info', warn: 'warning', error: 'danger' };

export function LevelBadge({ level }: { level: LogLevel }) {
  return <Badge tone={LEVEL_TONE[level] ?? 'neutral'}>{level.toUpperCase()}</Badge>;
}

const STATUS_META: Record<TaskStatus, { tone: Tone; label: string }> = {
  queued: { tone: 'neutral', label: '排队中' },
  processing: { tone: 'info', label: '处理中' },
  done: { tone: 'success', label: '完成' },
  failed: { tone: 'danger', label: '失败' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const m = STATUS_META[status] ?? { tone: 'neutral' as Tone, label: status };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export const TASK_TYPE_LABEL: Record<string, string> = { tts: '语音合成', asr: '语音识别', talking: '口播视频' };

export function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <button className="btn btn-secondary btn-sm" onClick={onClick} disabled={loading}>
      {loading ? <Spinner /> : <IconRefresh size={14} />}
      刷新
    </button>
  );
}

/** 首次加载占位 / 错误提示；有数据时返回 null 交给调用方渲染 */
export function LoadState({ loading, error, hasData }: { loading: boolean; error: string | null; hasData: boolean }) {
  if (error) return <ErrorBanner>加载失败：{error}</ErrorBanner>;
  if (loading && !hasData)
    return (
      <div className="loading-block">
        <Spinner /> 加载中…
      </div>
    );
  return null;
}
