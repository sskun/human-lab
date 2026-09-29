// 展示格式化纯函数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatUptime, formatClock } from '../src/lib/format.ts';

test('formatUptime：秒 → 天/时/分', () => {
  assert.equal(formatUptime(0), '0 分钟');
  assert.equal(formatUptime(59), '0 分钟');
  assert.equal(formatUptime(125), '2 分钟');
  assert.equal(formatUptime(3 * 3600 + 5 * 60), '3 小时 5 分钟');
  assert.equal(formatUptime(2 * 86400 + 3600), '2 天 1 小时');
  assert.equal(formatUptime(-5), '0 分钟');
});

test('formatBytes：空值显示横线，按 1024 进位', () => {
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3.5 * 1024 * 1024), '3.5 MB');
});

test('formatClock：日志时间截成 月-日 时:分:秒，非预期格式原样返回', () => {
  assert.equal(formatClock('2026-09-29 14:03:22.123'), '09-29 14:03:22');
  assert.equal(formatClock('2026-09-29T14:03:22.000Z'), '09-29 14:03:22');
  assert.equal(formatClock('bad'), 'bad');
});
