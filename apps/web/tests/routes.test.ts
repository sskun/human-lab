// 路由解析纯函数：路径归一、未知回落、后台子页
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, isPlainLeftClick } from '../src/lib/routes.ts';

test('根路径与未知路径回落到实时聊天', () => {
  assert.deepEqual(resolveRoute('/'), { page: 'chat', path: '/chat' });
  assert.deepEqual(resolveRoute(''), { page: 'chat', path: '/chat' });
  assert.deepEqual(resolveRoute('/nope'), { page: 'chat', path: '/chat' });
});

test('前台两个业务页，容忍尾斜杠与大小写', () => {
  assert.deepEqual(resolveRoute('/chat'), { page: 'chat', path: '/chat' });
  assert.deepEqual(resolveRoute('/video/'), { page: 'video', path: '/video' });
  assert.deepEqual(resolveRoute('/VIDEO'), { page: 'video', path: '/video' });
});

test('后台：默认概览，子页可直达，未知子页回落概览', () => {
  assert.deepEqual(resolveRoute('/admin'), { page: 'admin', tab: 'overview', path: '/admin' });
  assert.deepEqual(resolveRoute('/admin/logs'), { page: 'admin', tab: 'logs', path: '/admin/logs' });
  assert.deepEqual(resolveRoute('/admin/tasks/'), { page: 'admin', tab: 'tasks', path: '/admin/tasks' });
  assert.deepEqual(resolveRoute('/admin/sessions'), { page: 'admin', tab: 'sessions', path: '/admin/sessions' });
  assert.deepEqual(resolveRoute('/admin/xxx'), { page: 'admin', tab: 'overview', path: '/admin' });
});

test('只有无修饰键的左键点击才走前端路由', () => {
  const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(isPlainLeftClick(base), true);
  assert.equal(isPlainLeftClick({ ...base, button: 1 }), false);
  assert.equal(isPlainLeftClick({ ...base, metaKey: true }), false);
  assert.equal(isPlainLeftClick({ ...base, ctrlKey: true }), false);
  assert.equal(isPlainLeftClick({ ...base, shiftKey: true }), false);
  assert.equal(isPlainLeftClick({ ...base, altKey: true }), false);
});
