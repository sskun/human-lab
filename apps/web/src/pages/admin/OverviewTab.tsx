// 后台概览：关键指标卡 + 系统配置 + 最近错误
import type { AdminOverview, AppMeta, LogListResponse } from '@human-lab/shared';
import { useFetch } from '../../lib/api';
import { formatClock, formatUptime } from '../../lib/format';
import { Link } from '../../lib/router';
import { EmptyState } from '../../components/ui';
import { IconCheck } from '../../components/Icons';
import { LoadState, RefreshButton, TASK_TYPE_LABEL } from './shared';

function Stat({ label, value, foot, tone }: { label: string; value: number | string; foot?: string; tone?: 'danger' | 'warning' }) {
  return (
    <div className={`stat card${tone ? ` stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {foot && <span className="stat-foot">{foot}</span>}
    </div>
  );
}

export default function OverviewTab() {
  const ov = useFetch<AdminOverview>('/api/admin/overview');
  const meta = useFetch<AppMeta>('/api/meta');
  const errs = useFetch<LogListResponse>('/api/admin/logs?level=error&limit=5');

  const reload = () => {
    ov.reload();
    meta.reload();
    errs.reload();
  };
  const d = ov.data;
  const typeSummary = d
    ? Object.entries(d.tasks.byType)
        .map(([k, n]) => `${TASK_TYPE_LABEL[k] ?? k} ${n}`)
        .join(' · ') || '暂无'
    : '';

  return (
    <div className="tab-body">
      <div className="toolbar">
        <h2 className="section-title">概览</h2>
        <RefreshButton onClick={reload} loading={ov.loading} />
      </div>
      <LoadState loading={ov.loading} error={ov.error} hasData={!!d} />

      {d && (
        <div className="stats">
          <Stat label="任务总数" value={d.tasks.total} foot={`完成 ${d.tasks.byStatus.done} · 失败 ${d.tasks.byStatus.failed}`} />
          <Stat label="聊天会话" value={d.chat.sessions} foot={`进行中 ${d.chat.activeSessions}`} />
          <Stat label="对话轮次" value={d.chat.turns} foot={`失败 ${d.chat.failedTurns}`} />
          <Stat
            label="24h 错误 / 告警"
            value={`${d.logs.last24h.error} / ${d.logs.last24h.warn}`}
            foot={`信息 ${d.logs.last24h.info}`}
            tone={d.logs.last24h.error > 0 ? 'danger' : d.logs.last24h.warn > 0 ? 'warning' : undefined}
          />
        </div>
      )}

      <div className="overview-grid">
        <section className="card panel">
          <h3 className="panel-title">系统配置</h3>
          {meta.error && <p className="note">元信息加载失败：{meta.error}</p>}
          <dl className="kv">
            {meta.data && (
              <>
                <dt>形象</dt>
                <dd>{meta.data.avatar.id}</dd>
                <dt>默认音色</dt>
                <dd>{meta.data.voice}</dd>
                <dt>识别模型</dt>
                <dd>{meta.data.models.asr}</dd>
                <dt>对话模型</dt>
                <dd>{meta.data.models.llm}</dd>
                <dt>语音模型</dt>
                <dd>{meta.data.models.tts}</dd>
                <dt>口播模型</dt>
                <dd>{meta.data.models.talk}</dd>
                <dt>口播字数上限</dt>
                <dd>{meta.data.limits.videoTextMaxChars} 字</dd>
              </>
            )}
            {d && (
              <>
                <dt>任务分布</dt>
                <dd>{typeSummary}</dd>
                <dt>已运行</dt>
                <dd>{formatUptime(d.system.uptimeSec)}</dd>
                <dt>启动于</dt>
                <dd>{new Date(d.system.startedAt).toLocaleString('zh-CN', { hour12: false })}</dd>
                <dt>Node</dt>
                <dd>{d.system.nodeVersion}</dd>
              </>
            )}
          </dl>
        </section>

        <section className="card panel">
          <div className="panel-head">
            <h3 className="panel-title">最近错误</h3>
            <Link to="/admin/logs" className="text-link">
              查看全部日志
            </Link>
          </div>
          {errs.error && <p className="note">加载失败：{errs.error}</p>}
          {errs.data && errs.data.items.length === 0 && (
            <EmptyState icon={<IconCheck size={24} />} title="暂无错误" hint="运行平稳。" />
          )}
          {errs.data && errs.data.items.length > 0 && (
            <ul className="err-list">
              {errs.data.items.map((l) => (
                <li key={l.id}>
                  <span className="mono muted">{formatClock(l.ts)}</span>
                  <span className="scope">{l.scope}</span>
                  <span className="err-msg">{l.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
