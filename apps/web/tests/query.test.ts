// 查询串拼装：空值不带、数字转字符串、特殊字符编码
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withQuery } from '../src/lib/query.ts';

test('withQuery：无参数或全为空值时返回原路径', () => {
  assert.equal(withQuery('/api/admin/logs', {}), '/api/admin/logs');
  assert.equal(withQuery('/api/admin/logs', { level: '', scope: undefined, q: null }), '/api/admin/logs');
});

test('withQuery：保留非空参数（含数字 0 以外的数字）并编码', () => {
  assert.equal(withQuery('/api/admin/logs', { level: 'error', before: 120, limit: 50 }), '/api/admin/logs?level=error&before=120&limit=50');
  assert.equal(withQuery('/x', { q: '失败 a&b' }), '/x?q=%E5%A4%B1%E8%B4%A5+a%26b');
});
