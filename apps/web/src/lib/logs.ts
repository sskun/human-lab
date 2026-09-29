// 运行日志列表合并（纯函数，无 DOM 依赖，可直接单测）
import type { LogListResponse } from '@human-lab/shared';

/**
 * 自动刷新：把重新拉到的最新一页并入已加载列表（id 倒序）。
 * - 没有新日志时返回原对象，避免无谓重渲染，也保留用户已翻出的历史页；
 * - 最新一页满页且整页都比已加载的新：两页之间可能还有没拉到的日志，
 *   此时放弃已翻的历史页、重置为最新一页，宁可少显示也不静默漏行。
 */
export function mergeLatest(current: LogListResponse, latest: LogListResponse, pageSize: number): LogListResponse {
  if (current.items.length === 0) return latest;
  const top = current.items[0].id;
  const fresh = latest.items.filter((i) => i.id > top);
  if (fresh.length === 0) return current;
  if (fresh.length === latest.items.length && latest.items.length >= pageSize) return latest;
  return { items: [...fresh, ...current.items], nextCursor: current.nextCursor };
}
