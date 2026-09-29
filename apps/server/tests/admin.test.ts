// 管理后台测试：查询参数解析（纯函数）+ AdminService 聚合/过滤（真实 SQLite 临时库）+ SystemController 元信息。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../src/database/database.service.js';
import { TasksRepository } from '../src/database/tasks.repository.js';
import { ChatRepository } from '../src/database/chat.repository.js';
import { LogsRepository } from '../src/database/logs.repository.js';
import { AdminService } from '../src/admin/admin.service.js';
import { parseLogQuery, parseTaskQuery } from '../src/admin/admin.query.js';
import { SystemController } from '../src/system/system.controller.js';
import type { ConfigService } from '../src/config.service.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-test-'));
  const config = {
    dataDir: dir,
    outputDir: dir,
    asr: { model: 'asr-m' },
    llm: { model: 'llm-m' },
    tts: { model: 'tts-m', voice: 'longanlingxin' },
    talk: { model: 'talk-m', avatarDir: dir, avatarId: 'default', maxTextChars: 60 },
  } as unknown as ConfigService;
  const db = new DatabaseService(config);
  db.onModuleInit();
  const tasks = new TasksRepository(db);
  const chat = new ChatRepository(db);
  const logs = new LogsRepository(db);
  return { dir, config, tasks, chat, logs, svc: new AdminService(tasks, chat, logs) };
}

describe('parseLogQuery', () => {
  it('缺省 limit=100，空关键字视为不过滤', () => {
    assert.deepEqual(parseLogQuery({ q: '   ' }), { limit: 100 });
  });

  it('合法参数原样解析（关键字去首尾空白）', () => {
    assert.deepEqual(parseLogQuery({ level: 'error', scope: 'Tasks', q: ' boom ', before: '12', limit: '20' }), {
      level: 'error',
      scope: 'Tasks',
      q: 'boom',
      before: 12,
      limit: 20,
    });
  });

  it('limit 超范围夹取到 [1, 200]', () => {
    assert.equal(parseLogQuery({ limit: '999' }).limit, 200);
    assert.equal(parseLogQuery({ limit: '0' }).limit, 1);
  });

  it('非法参数抛 400', () => {
    for (const raw of [
      { level: 'fatal' },
      { limit: 'abc' },
      { before: '-1' },
      { before: '1.5' },
      { q: 'x'.repeat(101) },
      { scope: 's'.repeat(65) },
      { level: ['info', 'error'] }, // ?level=a&level=b
    ]) {
      assert.throws(() => parseLogQuery(raw), BadRequestException, JSON.stringify(raw));
    }
  });
});

describe('parseTaskQuery', () => {
  it('缺省 limit=50；类型/状态白名单校验', () => {
    assert.deepEqual(parseTaskQuery({}), { limit: 50 });
    assert.deepEqual(parseTaskQuery({ type: 'talking', status: 'failed', limit: '5' }), {
      type: 'talking',
      status: 'failed',
      limit: 5,
    });
    assert.throws(() => parseTaskQuery({ type: 'video' }), BadRequestException);
    assert.throws(() => parseTaskQuery({ status: 'running' }), BadRequestException);
  });
});

describe('AdminService', () => {
  it('overview：任务按类型/状态聚合、会话与轮次计数、24h 日志分级、系统信息', () => {
    const { tasks, chat, logs, svc } = setup();
    tasks.insertTask({ id: 't1', type: 'tts', text: 'a' });
    tasks.updateTask('t1', { status: 'done' });
    tasks.insertTask({ id: 't2', type: 'talking', text: 'b' });
    tasks.updateTask('t2', { status: 'failed', error: 'x' });
    tasks.insertTask({ id: 't3', type: 'asr' });
    chat.insertChatSession('s1');
    chat.insertChatSession('s2');
    chat.endChatSession('s2');
    chat.insertChatTurn({ id: 'u1', sessionId: 's1', idx: 1, inputType: 'text' });
    chat.updateChatTurn('u1', { status: 'done' });
    chat.insertChatTurn({ id: 'u2', sessionId: 's1', idx: 2, inputType: 'voice' });
    chat.updateChatTurn('u2', { status: 'failed', error: 'asr' });
    logs.insert({ level: 'error', scope: 'Tasks', message: 'boom' });
    logs.insert({ level: 'info', scope: 'Tasks', message: 'ok' });

    const o = svc.overview();
    assert.equal(o.tasks.total, 3);
    assert.deepEqual(o.tasks.byType, { tts: 1, talking: 1, asr: 1 });
    assert.deepEqual(o.tasks.byStatus, { queued: 1, processing: 0, done: 1, failed: 1 });
    assert.deepEqual(o.chat, { sessions: 2, activeSessions: 1, turns: 2, failedTurns: 1 });
    assert.deepEqual(o.logs.last24h, { debug: 0, info: 1, warn: 0, error: 1 });
    assert.equal(o.system.nodeVersion, process.version);
    assert.ok(o.system.uptimeSec >= 0);
    assert.ok(!Number.isNaN(Date.parse(o.system.startedAt)));
  });

  it('overview：空库全部为 0（byStatus 四个状态都在）', () => {
    const { svc } = setup();
    const o = svc.overview();
    assert.equal(o.tasks.total, 0);
    assert.deepEqual(o.tasks.byType, {});
    assert.deepEqual(o.tasks.byStatus, { queued: 0, processing: 0, done: 0, failed: 0 });
    assert.deepEqual(o.chat, { sessions: 0, activeSessions: 0, turns: 0, failedTurns: 0 });
  });

  it('listLogs：满页给 nextCursor（最后一条 id），不满页为 null', () => {
    const { logs, svc } = setup();
    for (let i = 1; i <= 3; i++) logs.insert({ level: 'info', scope: 'X', message: `m${i}` });
    const page1 = svc.listLogs({ limit: 2 });
    assert.deepEqual(page1.items.map((i) => i.message), ['m3', 'm2']);
    assert.equal(page1.nextCursor, page1.items[1].id);
    const page2 = svc.listLogs({ limit: 2, before: page1.nextCursor! });
    assert.deepEqual(page2.items.map((i) => i.message), ['m1']);
    assert.equal(page2.nextCursor, null);
  });

  it('listTasks：按类型/状态过滤，视图带 type/createdAt 与 /media 相对地址（不暴露本地路径）', () => {
    const { dir, tasks, svc } = setup();
    tasks.insertTask({ id: 'a', type: 'tts', text: '你好', voice: 'longanlingxin' });
    tasks.updateTask('a', { status: 'done', filePath: path.join(dir, 'tts-a.mp3'), bytes: 10 });
    tasks.insertTask({ id: 'b', type: 'talking', text: '口播' });
    tasks.updateTask('b', {
      status: 'done',
      filePath: path.join(dir, 'tts-b.mp3'),
      videoPath: path.join(dir, 'talking-b.mp4'),
    });
    tasks.insertTask({ id: 'c', type: 'talking', text: '失败' });
    tasks.updateTask('c', { status: 'failed', error: 'wan 挂了' });

    const talking = svc.listTasks({ type: 'talking', limit: 10 });
    assert.deepEqual(talking.map((t) => t.id).sort(), ['b', 'c']);
    const done = svc.listTasks({ type: 'talking', status: 'done', limit: 10 });
    assert.equal(done.length, 1);
    assert.equal(done[0].videoUrl, '/media/talking-b.mp4');
    assert.equal(done[0].audioUrl, '/media/tts-b.mp3');

    const [tts] = svc.listTasks({ type: 'tts', limit: 10 });
    assert.equal(tts.type, 'tts');
    assert.equal(tts.voice, 'longanlingxin');
    assert.equal(tts.bytes, 10);
    assert.match(tts.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(!JSON.stringify(tts).includes(dir), '不应暴露服务器本地路径');
    assert.equal(svc.listTasks({ limit: 2 }).length, 2);
  });
});

describe('SystemController', () => {
  it('meta：形象/音色/模型/字数上限来自配置，不含密钥', () => {
    const { config } = setup();
    const meta = new SystemController(config).meta();
    assert.deepEqual(meta, {
      avatar: { id: 'default', imageUrl: '/api/avatar/image' },
      voice: 'longanlingxin',
      models: { asr: 'asr-m', llm: 'llm-m', tts: 'tts-m', talk: 'talk-m' },
      limits: { videoTextMaxChars: 60 },
    });
  });

  it('avatarImage：形象图存在则 sendFile 绝对路径，缺失则 404', () => {
    const { dir, config } = setup();
    const ctrl = new SystemController(config);
    const res = { sent: '' as string, sendFile(p: string) { this.sent = p; } };
    assert.throws(() => ctrl.avatarImage(res as never), NotFoundException);

    fs.mkdirSync(path.join(dir, 'default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'default', 'image.png'), 'png');
    ctrl.avatarImage(res as never);
    assert.equal(res.sent, path.join(dir, 'default', 'image.png'));
  });
});
