// tasks.service.ts 口播流水线的单元测试：用假仓库/假能力验证状态机（不碰 SQLite 真库、不碰真实网络）。
// 流水线契约（docs/lipsync-design.md §4.3）：
//   queued → processing(stage=tts) → processing(stage=lipsync) → done(audioUrl+videoUrl)
//   TTS 失败 → failed（无音频）；口播失败 → failed 但保留已合成的音频
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { TasksService } from '../src/tasks/tasks.service.js';
import type { TasksRepository } from '../src/database/tasks.repository.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-test-'));

/** 假仓库：内存 Map（存的是仓库层驼峰 TaskRecord，非 DB 行）；updateTask 语义与真库一致（patch 里出现的键才写，undefined 不动） */
class FakeRepo {
  rows = new Map<string, Record<string, unknown>>();

  insertTask(t: { id: string; type: string; text?: string | null; voice?: string | null; model?: string | null }): void {
    this.rows.set(t.id, {
      id: t.id, type: t.type, text: t.text ?? null, voice: t.voice ?? null, model: t.model ?? null,
      filePath: null, bytes: null, videoPath: null, stage: null, status: 'queued', error: null, createdAt: 'now',
    });
  }

  updateTask(
    id: string,
    patch: { status: string; filePath?: string | null; bytes?: number | null; text?: string | null; videoPath?: string | null; stage?: string | null; error?: string | null },
  ): void {
    const row = this.rows.get(id);
    assert.ok(row, `任务应存在: ${id}`);
    row.status = patch.status;
    if ('filePath' in patch) row.filePath = patch.filePath ?? null;
    if ('videoPath' in patch) row.videoPath = patch.videoPath ?? null;
    if ('bytes' in patch) row.bytes = patch.bytes ?? null;
    if ('text' in patch) row.text = patch.text ?? null;
    if ('stage' in patch) row.stage = patch.stage ?? null;
    row.error = patch.error ?? null;
  }

  getTask(id: string) {
    return this.rows.get(id);
  }

  listTasks(limit = 20) {
    return [...this.rows.values()].slice(0, limit);
  }
}

/** 假 ConfigService（只暴露 TasksService 用到的字段） */
function fakeConfig() {
  return {
    outputDir: dir,
    dataDir: dir,
    asr: { model: 'asr-m' },
    talk: { avatarDir: dir, avatarId: 'default', maxTextChars: 60 },
  } as unknown as import('../src/config.service.js').ConfigService;
}

/** 假能力集合 */
function fakeTts() {
  return {
    synthesizeToFile: async (text: string, opts: { out: string }) => {
      fs.writeFileSync(opts.out, 'mp3-data');
      return { outFile: opts.out, bytes: 8 };
    },
  };
}

function fakeLipsync(impl?: (opts: { imagePath: string; audioPath: string; out: string }) => Promise<unknown>) {
  return {
    generateToFile:
      impl ??
      (async (opts: { imagePath: string; audioPath: string; out: string }) => {
        fs.writeFileSync(opts.out, 'mp4-data');
        return { outFile: opts.out, bytes: 9, durationSec: 12, fps: 30, ratio: '9:16', remoteTaskId: 'tid' };
      }),
  };
}

function makeService(overrides: { tts?: unknown; lipsync?: unknown } = {}) {
  const repo = new FakeRepo();
  const svc = new TasksService(
    fakeConfig(),
    repo as unknown as TasksRepository,
    (overrides.tts ?? fakeTts()) as never,
    {} as never, // asr：本组测试用不到
    (overrides.lipsync ?? fakeLipsync()) as never,
  );
  return { repo, svc };
}

/** 等待任务到达终态（fire-and-forget 流水线是异步的） */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('等待任务终态超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('TasksService.create（纯 TTS，行为不变）', () => {
  it('默认仍只合成音频：done 且无视频产物', async () => {
    const { repo, svc } = makeService();
    const id = svc.create('你好');
    await until(() => repo.getTask(id)?.status === 'done');
    const row = repo.getTask(id)!;
    assert.equal(row.type, 'tts');
    assert.ok(String(row.filePath).endsWith(`tts-${id}.mp3`));
    assert.equal(row.videoPath, null);
  });
});

describe('TasksService.create（withVideo 口播流水线）', () => {
  it('全链路成功：stage 走 tts→lipsync，done 双产物（mp3+mp4），视图带 videoUrl', async () => {
    const stages: (string | null)[] = [];
    const repo = new FakeRepo();
    // 原始 updateTask 包一层，记录 stage 轨迹
    const origUpdate = repo.updateTask.bind(repo);
    repo.updateTask = (id, patch) => {
      if ('stage' in patch) stages.push(patch.stage ?? null);
      origUpdate(id, patch);
    };
    const svc = new TasksService(fakeConfig(), repo as unknown as TasksRepository, fakeTts() as never, {} as never, fakeLipsync() as never);

    const id = svc.create('新品上架，今天限时八折。', undefined, true);
    await until(() => repo.getTask(id)?.status === 'done');

    const row = repo.getTask(id)!;
    assert.equal(row.type, 'talking');
    assert.ok(String(row.filePath).endsWith(`tts-${id}.mp3`));
    assert.ok(String(row.videoPath).endsWith(`talking-${id}.mp4`));
    assert.equal(row.stage, null, 'done 后 stage 应清空');
    assert.deepEqual(stages.filter((s, i, a) => s !== a[i - 1]), ['tts', 'lipsync', null]);

    const view = svc.getView(id)!;
    assert.equal(view.audioUrl, `/media/tts-${id}.mp3`);
    assert.equal(view.videoUrl, `/media/talking-${id}.mp4`);
    assert.equal(view.stage, undefined);
  });

  it('TTS 失败：failed 且无任何产物，stage 停在 tts', async () => {
    const { repo, svc } = makeService({
      tts: { synthesizeToFile: async () => { throw new Error('TTS 挂了'); } },
    });
    const id = svc.create('内容', undefined, true);
    await until(() => repo.getTask(id)?.status === 'failed');

    const row = repo.getTask(id)!;
    assert.match(String(row.error), /TTS 挂了/);
    assert.equal(row.stage, 'tts');
    assert.equal(row.filePath, null);
    assert.equal(row.videoPath, null);
  });

  it('口播失败：failed 但保留已合成的音频（音频是已付费产物）', async () => {
    const { repo, svc } = makeService({
      lipsync: fakeLipsync(async () => { throw new Error('wan3.0 任务失败'); }),
    });
    const id = svc.create('内容', undefined, true);
    await until(() => repo.getTask(id)?.status === 'failed');

    const row = repo.getTask(id)!;
    assert.match(String(row.error), /wan3.0 任务失败/);
    assert.equal(row.stage, 'lipsync');
    assert.ok(String(row.filePath).endsWith(`tts-${id}.mp3`), '音频应保留');
    assert.equal(row.videoPath, null);
    const view = svc.getView(id)!;
    assert.ok(view.audioUrl, '失败任务仍可播放音频');
    assert.equal(view.videoUrl, undefined);
  });
});

describe('TasksService.getView（stage 字段映射）', () => {
  it('processing 期间暴露 stage，供前端区分阶段文案', () => {
    const { repo, svc } = makeService();
    const id = 'manual-id';
    repo.insertTask({ id, type: 'talking', text: 'x' });
    repo.updateTask(id, { status: 'processing', stage: 'lipsync' });
    const view = svc.getView(id)!;
    assert.equal(view.status, 'processing');
    assert.equal(view.stage, 'lipsync');
  });
});
