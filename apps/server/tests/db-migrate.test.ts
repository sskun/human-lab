// database.service.ts 的 tasks 表迁移测试：video_path/stage 两列
//   全新库：CREATE TABLE 直接带新列；存量库：onModuleInit 自动 ALTER 且旧数据保留。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseService } from '../src/database/database.service.js';

function fakeConfig(dataDir: string) {
  return { dataDir } as unknown as import('../src/config.service.js').ConfigService;
}

function columnNames(svc: DatabaseService): string[] {
  return (svc.prepare('PRAGMA table_info(tasks)').all() as Record<string, unknown>[]).map((r) => String(r.name));
}

describe('DatabaseService tasks 表迁移', () => {
  it('全新库：tasks 表自带 video_path / stage 列', () => {
    const svc = new DatabaseService(fakeConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'db-fresh-'))));
    svc.onModuleInit();
    const cols = columnNames(svc);
    assert.ok(cols.includes('video_path'), '应有 video_path 列');
    assert.ok(cols.includes('stage'), '应有 stage 列');
    // 新列可写
    svc.prepare(`INSERT INTO tasks (id, type, status, video_path, stage) VALUES ('t1', 'talking', 'queued', '/x/v.mp4', 'tts')`).run();
    const row = svc.prepare('SELECT video_path, stage FROM tasks WHERE id = ?').get('t1') as Record<string, unknown>;
    assert.equal(row.video_path, '/x/v.mp4');
    assert.equal(row.stage, 'tts');
  });

  it('存量库（旧 schema）自动 ALTER 补列，旧数据保留', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-legacy-'));
    // 预置旧版表（无 video_path/stage）和一行旧数据
    const legacy = new DatabaseSync(path.join(dir, 'human-lab.db'));
    legacy.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, text TEXT, voice TEXT, model TEXT,
      file_path TEXT, bytes INTEGER, status TEXT NOT NULL, error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );`);
    legacy.prepare(`INSERT INTO tasks (id, type, text, status) VALUES ('legacy-1', 'tts', '旧任务', 'done')`).run();
    legacy.close();

    const svc = new DatabaseService(fakeConfig(dir));
    svc.onModuleInit();
    const cols = columnNames(svc);
    assert.ok(cols.includes('video_path') && cols.includes('stage'), '迁移后应有新列');
    const row = svc.prepare('SELECT id, text, status FROM tasks WHERE id = ?').get('legacy-1') as Record<string, unknown>;
    assert.equal(row.text, '旧任务');
    assert.equal(row.status, 'done');
  });

  it('重复初始化幂等（不重复加列）', () => {
    const svc = new DatabaseService(fakeConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'db-idem-'))));
    svc.onModuleInit();
    svc.onModuleInit();
    const cols = columnNames(svc);
    assert.equal(cols.filter((c) => c === 'video_path').length, 1);
  });
});
