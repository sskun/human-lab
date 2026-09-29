// 运行日志自动刷新：最新一页与已加载列表的合并
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntryView } from '@human-lab/shared';
import { mergeLatest } from '../src/lib/logs.ts';

const log = (id: number): LogEntryView => ({ id, ts: '2026-09-29 10:00:00.000', level: 'info', scope: 'Test', message: `m${id}`, meta: null });
const ids = (items: LogEntryView[]) => items.map((i) => i.id);

test('当前为空：直接用最新一页', () => {
  const latest = { items: [log(3), log(2)], nextCursor: null };
  assert.deepEqual(mergeLatest({ items: [], nextCursor: null }, latest, 2), latest);
});

test('没有新日志：返回原对象（不触发重渲染），保留已翻的页', () => {
  const current = { items: [log(5), log(4), log(3)], nextCursor: 3 };
  assert.equal(mergeLatest(current, { items: [log(5), log(4)], nextCursor: 4 }, 2), current);
});

test('有重叠：新日志插到前面，保留原游标', () => {
  const current = { items: [log(5), log(4)], nextCursor: 4 };
  const merged = mergeLatest(current, { items: [log(7), log(6), log(5)], nextCursor: 5 }, 3);
  assert.deepEqual(ids(merged.items), [7, 6, 5, 4]);
  assert.equal(merged.nextCursor, 4);
});

test('最新一页不满：说明已拿全，同样合并', () => {
  const current = { items: [log(5)], nextCursor: null };
  const merged = mergeLatest(current, { items: [log(6), log(5)], nextCursor: null }, 100);
  assert.deepEqual(ids(merged.items), [6, 5]);
});

test('满页且与已加载无重叠：中间可能漏数据，整体重置为最新一页', () => {
  const current = { items: [log(5), log(4)], nextCursor: 4 };
  const latest = { items: [log(9), log(8)], nextCursor: 8 };
  assert.deepEqual(mergeLatest(current, latest, 2), latest);
});
