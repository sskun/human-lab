// 运行日志持久化测试：LogsRepository（app_logs 表读写/过滤/游标/裁剪）与 AppLogger（打印同时落库）。
// 用真实 SQLite（临时目录），不碰网络。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseService } from '../src/database/database.service.js';
import { LogsRepository } from '../src/database/logs.repository.js';
import { AppLogger } from '../src/logging/app-logger.js';

function freshRepo(): { db: DatabaseService; repo: LogsRepository } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-test-'));
  const db = new DatabaseService({ dataDir } as unknown as import('../src/config.service.js').ConfigService);
  db.onModuleInit();
  return { db, repo: new LogsRepository(db) };
}

describe('LogsRepository', () => {
  it('写入后按 id 倒序返回，ts 为本地毫秒时间', () => {
    const { repo } = freshRepo();
    repo.insert({ level: 'info', scope: 'Tasks', message: 'first' });
    repo.insert({ level: 'error', scope: 'Chat', message: 'second', meta: 'stack...' });
    const items = repo.query({ limit: 10 });
    assert.deepEqual(
      items.map((i) => [i.message, i.level, i.scope, i.meta]),
      [
        ['second', 'error', 'Chat', 'stack...'],
        ['first', 'info', 'Tasks', null],
      ],
    );
    assert.match(items[0].ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    assert.ok(items[0].id > items[1].id);
  });

  it('按级别 / 模块 / 关键字过滤；关键字里的 % _ 按字面匹配', () => {
    const { repo } = freshRepo();
    repo.insert({ level: 'info', scope: 'Tasks', message: '[task a] done 100%' });
    repo.insert({ level: 'error', scope: 'Tasks', message: '[task b] failed' });
    repo.insert({ level: 'info', scope: 'Chat', message: '[chat c] 回复' });
    repo.insert({ level: 'info', scope: 'Chat', message: 'progress 100 percent' });

    assert.deepEqual(repo.query({ level: 'error', limit: 10 }).map((i) => i.message), ['[task b] failed']);
    assert.equal(repo.query({ scope: 'Chat', limit: 10 }).length, 2);
    assert.deepEqual(repo.query({ q: '100%', limit: 10 }).map((i) => i.message), ['[task a] done 100%']);
    assert.deepEqual(repo.query({ q: 'task', scope: 'Tasks', level: 'info', limit: 10 }).length, 1);
  });

  it('before 游标翻页 + limit 截断', () => {
    const { repo } = freshRepo();
    for (let i = 1; i <= 5; i++) repo.insert({ level: 'info', scope: 'X', message: `m${i}` });
    const page1 = repo.query({ limit: 2 });
    assert.deepEqual(page1.map((i) => i.message), ['m5', 'm4']);
    const page2 = repo.query({ limit: 2, before: page1[1].id });
    assert.deepEqual(page2.map((i) => i.message), ['m3', 'm2']);
  });

  it('scopes 去重排序；countByLevelLast24h 各级别计数（缺省为 0）', () => {
    const { repo } = freshRepo();
    repo.insert({ level: 'info', scope: 'Tasks', message: 'a' });
    repo.insert({ level: 'warn', scope: 'Chat', message: 'b' });
    repo.insert({ level: 'error', scope: 'Chat', message: 'c' });
    repo.insert({ level: 'error', scope: 'Http', message: 'd' });
    assert.deepEqual(repo.scopes(), ['Chat', 'Http', 'Tasks']);
    assert.deepEqual(repo.countByLevelLast24h(), { debug: 0, info: 1, warn: 1, error: 2 });
  });

  it('prune(max) 只保留最新 max 行', () => {
    const { repo } = freshRepo();
    for (let i = 1; i <= 6; i++) repo.insert({ level: 'info', scope: 'X', message: `m${i}` });
    repo.prune(3);
    assert.deepEqual(repo.query({ limit: 10 }).map((i) => i.message), ['m6', 'm5', 'm4']);
  });
});

describe('AppLogger', () => {
  it('log / warn / debug / verbose 落库，级别映射为 info / warn / debug / debug，context 作为 scope', () => {
    const { repo } = freshRepo();
    const logger = new AppLogger(repo);
    logger.setLogLevels(['log', 'warn', 'error', 'debug', 'verbose', 'fatal']);
    logger.log('hello', 'Tasks');
    logger.warn('careful', 'Chat');
    logger.debug('dbg', 'Db');
    logger.verbose('verb', 'Db');
    const items = repo.query({ limit: 10 }).reverse();
    assert.deepEqual(
      items.map((i) => [i.level, i.scope, i.message]),
      [
        ['info', 'Tasks', 'hello'],
        ['warn', 'Chat', 'careful'],
        ['debug', 'Db', 'dbg'],
        ['debug', 'Db', 'verb'],
      ],
    );
  });

  it('error 带堆栈：message 为文本，堆栈进 meta；fatal 映射为 error', () => {
    const { repo } = freshRepo();
    const logger = new AppLogger(repo);
    const err = new Error('boom');
    logger.error(err.message, err.stack, 'Chat');
    logger.fatal('dead', 'Bootstrap');
    const [fatal, error] = repo.query({ limit: 10 });
    assert.equal(error.level, 'error');
    assert.equal(error.scope, 'Chat');
    assert.equal(error.message, 'boom');
    assert.match(String(error.meta), /Error: boom/);
    assert.equal(fatal.level, 'error');
    assert.equal(fatal.message, 'dead');
  });

  it('对象消息序列化为 JSON；无 context 时 scope 为空串', () => {
    const { repo } = freshRepo();
    const logger = new AppLogger(repo);
    logger.log({ a: 1 });
    const [item] = repo.query({ limit: 1 });
    assert.equal(item.message, '{"a":1}');
    assert.equal(item.scope, '');
  });

  it('落库失败不抛错（日志永远不能影响业务）', () => {
    const broken = {
      insert: () => {
        throw new Error('db down');
      },
      prune: () => undefined,
    } as unknown as LogsRepository;
    const logger = new AppLogger(broken);
    assert.doesNotThrow(() => logger.log('still fine', 'Tasks'));
    assert.doesNotThrow(() => logger.error('still fine', undefined, 'Tasks'));
  });
});
