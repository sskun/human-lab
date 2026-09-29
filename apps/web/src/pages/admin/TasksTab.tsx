// 任务记录：按类型 / 状态过滤，展示文本、模型、产物与错误
import { useState } from 'react';
import type { AdminTaskView, TaskStatus, TaskType } from '@human-lab/shared';
import { useFetch } from '../../lib/api';
import { withQuery } from '../../lib/query';
import { formatBytes, formatClock } from '../../lib/format';
import { EmptyState } from '../../components/ui';
import { IconExternal, IconList } from '../../components/Icons';
import { LoadState, RefreshButton, StatusBadge, TASK_TYPE_LABEL } from './shared';

const TYPES: TaskType[] = ['tts', 'asr', 'talking'];
const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: 'queued', label: '排队中' },
  { value: 'processing', label: '处理中' },
  { value: 'done', label: '完成' },
  { value: 'failed', label: '失败' },
];

export default function TasksTab() {
  const [type, setType] = useState<TaskType | ''>('');
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const { data, error, loading, reload } = useFetch<AdminTaskView[]>(
    withQuery('/api/admin/tasks', { type, status, limit: 100 }),
  );
  const filtered = type !== '' || status !== '';

  return (
    <div className="tab-body">
      <div className="toolbar">
        <h2 className="section-title">任务记录</h2>
        <RefreshButton onClick={reload} loading={loading} />
      </div>

      <div className="filters">
        <label className="filter">
          <span className="filter-label">类型</span>
          <select className="select" value={type} onChange={(e) => setType(e.target.value as TaskType | '')}>
            <option value="">全部</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {TASK_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span className="filter-label">状态</span>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | '')}>
            <option value="">全部</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <LoadState loading={loading} error={error} hasData={!!data} />

      {data && (
        <div className="card table-card">
          {data.length === 0 ? (
            <EmptyState icon={<IconList size={24} />} title={filtered ? '没有匹配的任务' : '暂无任务'} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">时间</th>
                    <th scope="col">类型</th>
                    <th scope="col">状态</th>
                    <th scope="col">文本</th>
                    <th scope="col">模型 / 音色</th>
                    <th scope="col" className="num">
                      大小
                    </th>
                    <th scope="col">产物</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((t) => (
                    <tr key={t.id}>
                      <td className="mono nowrap">{formatClock(t.createdAt)}</td>
                      <td className="nowrap">{TASK_TYPE_LABEL[t.type] ?? t.type}</td>
                      <td>
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="cell-text">
                        <span className="clamp" title={t.text ?? undefined}>
                          {t.text || <span className="muted">—</span>}
                        </span>
                        {t.error && <span className="cell-error">{t.error}</span>}
                      </td>
                      <td className="cell-sub">
                        {t.model ?? '—'}
                        {t.voice && <span className="muted"> / {t.voice}</span>}
                      </td>
                      <td className="num mono nowrap">{formatBytes(t.bytes)}</td>
                      <td className="nowrap">
                        {t.videoUrl && (
                          <a className="text-link" href={t.videoUrl} target="_blank" rel="noreferrer">
                            视频 <IconExternal size={12} />
                          </a>
                        )}
                        {t.audioUrl && (
                          <a className="text-link" href={t.audioUrl} target="_blank" rel="noreferrer">
                            音频 <IconExternal size={12} />
                          </a>
                        )}
                        {!t.videoUrl && !t.audioUrl && <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
