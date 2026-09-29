// 会话记录：聊天会话列表，展开查看每轮输入/输出明细（原前台「聊天记录」迁移至此）
import { useState } from 'react';
import type { ChatSessionView, ChatTurnView } from '@human-lab/shared';
import { getJSON, useFetch } from '../../lib/api';
import { formatClock } from '../../lib/format';
import { Badge, EmptyState, ErrorBanner, Spinner } from '../../components/ui';
import { IconChat, IconChevronDown, IconExternal, IconMic, IconType } from '../../components/Icons';
import { LoadState, RefreshButton } from './shared';

export default function SessionsTab() {
  const { data, error, loading, reload } = useFetch<ChatSessionView[]>('/api/chat/sessions');
  const [turns, setTurns] = useState<Record<string, ChatTurnView[]>>({}); // sessionId → 明细（已加载的缓存）
  const [open, setOpen] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);

  /** 展开/收起某个会话的明细（先展开再拉取，拉取中显示加载态） */
  async function toggle(id: string) {
    setTurnError(null);
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    if (!turns[id]) {
      try {
        const list = await getJSON<ChatTurnView[]>(`/api/chat/sessions/${id}/turns`);
        setTurns((prev) => ({ ...prev, [id]: list }));
      } catch (e) {
        setTurnError(e instanceof Error ? e.message : String(e));
        setOpen(null);
      }
    }
  }

  return (
    <div className="tab-body">
      <div className="toolbar">
        <h2 className="section-title">会话记录</h2>
        <RefreshButton
          onClick={() => {
            setTurns({}); // 刷新时清掉明细缓存，进行中的会话轮次可能已变化
            reload();
          }}
          loading={loading}
        />
      </div>
      <LoadState loading={loading} error={error} hasData={!!data} />
      {turnError && <ErrorBanner>读取明细失败：{turnError}</ErrorBanner>}

      {data && data.length === 0 && (
        <div className="card">
          <EmptyState icon={<IconChat size={24} />} title="暂无会话" hint="在「实时聊天」开始一场对话后，这里会出现记录。" />
        </div>
      )}

      {data && data.length > 0 && (
        <ul className="session-list">
          {data.map((s) => {
            const expanded = open === s.id;
            const list = turns[s.id];
            return (
              <li key={s.id} className="card session-item">
                <button className="session-head" onClick={() => void toggle(s.id)} aria-expanded={expanded}>
                  <code>{s.id.slice(0, 8)}</code>
                  <Badge tone={s.status === 'active' ? 'success' : 'neutral'}>{s.status === 'active' ? '进行中' : '已结束'}</Badge>
                  <span className="session-time mono">
                    {formatClock(s.startedAt)}
                    {s.endedAt ? ` ~ ${formatClock(s.endedAt)}` : ''}
                  </span>
                  <span className="session-count">{s.turnCount} 轮</span>
                  <IconChevronDown size={16} className={`chev${expanded ? ' up' : ''}`} />
                </button>
                {expanded && (
                  <div className="session-body">
                    {!list && (
                      <div className="loading-block">
                        <Spinner /> 加载明细中…
                      </div>
                    )}
                    {list && list.length === 0 && <p className="note">本场没有轮次明细。</p>}
                    {list?.map((t) => (
                      <div key={t.id} className="turn-row">
                        <span className="turn-idx">#{t.idx}</span>
                        <div className="turn-io">
                          <p>
                            <span className="io-tag">
                              {t.inputType === 'voice' ? <IconMic size={12} /> : <IconType size={12} />}
                              {t.inputType === 'voice' ? '语音' : '打字'}
                            </span>
                            {t.inputText || <span className="muted">（没听清）</span>}
                            {t.inputAudioUrl && (
                              <a className="text-link" href={t.inputAudioUrl} target="_blank" rel="noreferrer">
                                原声 <IconExternal size={12} />
                              </a>
                            )}
                          </p>
                          <p>
                            <span className="io-tag io-out">回复</span>
                            {t.outputText ?? <span className="muted">（无）</span>}
                            {t.outputAudioUrl && (
                              <a className="text-link" href={t.outputAudioUrl} target="_blank" rel="noreferrer">
                                回复音频 <IconExternal size={12} />
                              </a>
                            )}
                          </p>
                          {t.error && <p className="cell-error">失败：{t.error}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
