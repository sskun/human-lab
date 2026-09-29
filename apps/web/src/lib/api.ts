// 通用 GET 请求 + 系统元信息缓存。
// 聊天发送、语音识别仍用原始 fetch：它们要处理"失败轮次也返回 turn""没听清"等特殊分支。
import { useEffect, useState } from 'react';
import type { AppMeta } from '@human-lab/shared';

/** GET 并解析 JSON；非 2xx 时抛出服务端返回的 { error } 文案 */
export async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg = (body as { error?: unknown } | null)?.error;
    throw new Error(typeof msg === 'string' && msg ? msg : `请求失败（HTTP ${res.status}）`);
  }
  return body as T;
}

// 元信息整个会话内不变，模块级缓存一次；失败时清空缓存，下次挂载可重试
let metaPromise: Promise<AppMeta> | null = null;

function loadMeta(): Promise<AppMeta> {
  metaPromise ??= getJSON<AppMeta>('/api/meta').catch((e: unknown) => {
    metaPromise = null;
    throw e;
  });
  return metaPromise;
}

/** 当前形象、模型与限制；加载中或失败时为 null（调用方需自备兜底值） */
export function useMeta(): AppMeta | null {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  useEffect(() => {
    let alive = true;
    loadMeta()
      .then((m) => alive && setMeta(m))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return meta;
}

export interface FetchState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** 重新请求（保留旧数据直到新数据到达，避免刷新时闪空） */
  reload: () => void;
}

/** 按 url 拉取 JSON；url 变化或 reload 时重新请求，旧请求会被中止 */
export function useFetch<T>(url: string): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    getJSON<T>(url, ctrl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [url, nonce]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

/** 用户是否偏好减少动效（JS 触发的平滑滚动需要单独判断） */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
