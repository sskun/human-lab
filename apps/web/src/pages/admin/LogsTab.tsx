// 运行日志：级别 / 模块 / 关键字过滤，游标分页（加载更多），自动刷新，展开附加信息
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogLevel, LogListResponse } from '@human-lab/shared';
import { getJSON, useFetch } from '../../lib/api';
import { mergeLatest } from '../../lib/logs';
import { withQuery } from '../../lib/query';
import { formatClock } from '../../lib/format';
import { EmptyState, ErrorBanner, Spinner } from '../../components/ui';
import { IconChevronDown, IconFile, IconSearch } from '../../components/Icons';
import { LevelBadge, RefreshButton } from './shared';

const PAGE_SIZE = 50;
const AUTO_REFRESH_MS = 5000;
const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

export default function LogsTab() {
  const [level, setLevel] = useState<LogLevel | ''>('');
  const [scope, setScope] = useState('');
  const [keyword, setKeyword] = useState(''); // 输入框即时值
  const [q, setQ] = useState(''); // 去抖后生效的关键字
  const [auto, setAuto] = useState(false);

  // 已加载的日志与翻页游标放在一起更新，自动刷新合并时两者保持一致
  const [page, setPage] = useState<LogListResponse>({ items: [], nextCursor: null });
  const { items, nextCursor } = page;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const reqRef = useRef(0); // 过滤条件变化后丢弃旧请求的结果

  const scopes = useFetch<string[]>('/api/admin/logs/scopes');

  // 关键字去抖 300ms，避免每敲一个字发一次请求
  useEffect(() => {
    const t = window.setTimeout(() => setQ(keyword.trim()), 300);
    return () => window.clearTimeout(t);
  }, [keyword]);

  const url = useCallback(
    (before?: number) => withQuery('/api/admin/logs', { level, scope, q, before, limit: PAGE_SIZE }),
    [level, scope, q],
  );

  /** 重新加载第一页（过滤条件变化 / 手动刷新） */
  const loadFirst = useCallback(async () => {
    const id = ++reqRef.current;
    setLoading(true);
    try {
      const res = await getJSON<LogListResponse>(url());
      if (id !== reqRef.current) return;
      setPage(res);
      setError(null);
    } catch (e) {
      if (id === reqRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setOpen(new Set());
    void loadFirst();
  }, [loadFirst]);

  /** 自动刷新：只把比当前最新一条更新的日志插到顶部，保留已翻出的历史页（合并规则见 mergeLatest） */
  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(async () => {
      const id = reqRef.current;
      try {
        const res = await getJSON<LogListResponse>(url());
        if (id !== reqRef.current) return;
        setPage((prev) => mergeLatest(prev, res, PAGE_SIZE));
      } catch {
        // 自动刷新失败静默跳过，下一轮再试；手动刷新会展示错误
      }
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [auto, url]);

  async function loadMore() {
    if (nextCursor === null) return;
    const id = reqRef.current;
    setLoadingMore(true);
    try {
      const res = await getJSON<LogListResponse>(url(nextCursor));
      if (id !== reqRef.current) return;
      // 游标是 id，翻页结果与已加载的不会重叠；过滤一次防御自动刷新重置列表时的并发
      setPage((prev) => {
        const seen = new Set(prev.items.map((i) => i.id));
        return { items: [...prev.items, ...res.items.filter((i) => !seen.has(i.id))], nextCursor: res.nextCursor };
      });
    } catch (e) {
      if (id === reqRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  function toggle(id: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = level !== '' || scope !== '' || q !== '';

  return (
    <div className="tab-body">
      <div className="toolbar">
        <h2 className="section-title">运行日志</h2>
        <div className="toolbar-actions">
          <label className="switch">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span className="switch-track" aria-hidden />
            自动刷新
          </label>
          <RefreshButton onClick={() => void loadFirst()} loading={loading} />
        </div>
      </div>

      <div className="filters">
        <label className="filter">
          <span className="filter-label">级别</span>
          <select className="select" value={level} onChange={(e) => setLevel(e.target.value as LogLevel | '')}>
            <option value="">全部</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span className="filter-label">模块</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">全部</option>
            {(scopes.data ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="filter filter-grow">
          <span className="filter-label">关键字</span>
          <span className="search">
            <IconSearch size={15} className="search-icon" />
            <input
              className="input"
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索日志内容"
              maxLength={100}
            />
          </span>
        </label>
      </div>

      {error && <ErrorBanner>加载失败：{error}</ErrorBanner>}

      <div className="card table-card">
        {loading && items.length === 0 ? (
          <div className="loading-block">
            <Spinner /> 加载中…
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<IconFile size={24} />} title={filtered ? '没有匹配的日志' : '暂无日志'} hint={filtered ? '换个过滤条件试试。' : undefined} />
        ) : (
          <ul className="log-list" aria-busy={loading}>
            {items.map((l) => {
              const expanded = open.has(l.id);
              const row = (
                <>
                  <span className="log-time mono">{formatClock(l.ts)}</span>
                  <LevelBadge level={l.level} />
                  <span className="scope">{l.scope}</span>
                  <span className="log-msg">{l.message}</span>
                  {l.meta && <IconChevronDown size={16} className={`chev${expanded ? ' up' : ''}`} />}
                </>
              );
              return (
                <li key={l.id} className={`log-item level-${l.level}`}>
                  {l.meta ? (
                    <button className="log-row" onClick={() => toggle(l.id)} aria-expanded={expanded}>
                      {row}
                    </button>
                  ) : (
                    <div className="log-row">{row}</div>
                  )}
                  {expanded && l.meta && <pre className="log-meta">{l.meta}</pre>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {nextCursor !== null && items.length > 0 && (
        <div className="more">
          <button className="btn btn-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Spinner />}
            加载更多
          </button>
        </div>
      )}
    </div>
  );
}
