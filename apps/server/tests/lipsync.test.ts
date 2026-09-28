// capabilities/lipsync.ts 的单元测试：wan3.0-video-prime 异步任务协议 + 一行封装（mock fetch，不碰真实网络）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  buildTalkPrompt,
  generateTalkingVideo,
  WanTalkVideo,
  type TalkConfig,
} from '../src/capabilities/lipsync.js';
import type { UploadPolicy } from '../src/capabilities/upload.js';

/** 构造 JSON Response */
function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** 记录请求的 fetch 桩 */
type CapturedCall = { url: string; init: RequestInit };
function stubFetch(handler: (url: string, init: RequestInit, call: number) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = calls.length;
    calls.push({ url: String(url), init: init ?? {} });
    return await handler(String(url), init ?? {}, call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const CFG: TalkConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://maas.example.com/api/v1',
  uploadsBaseUrl: 'https://dashscope.example.com/api/v1',
  model: 'wan3.0-video-prime',
  resolution: '480P',
  ratio: '9:16',
  duration: -1,
  promptExtend: false,
  pollIntervalMs: 1,
  timeoutMs: 5_000,
};

/** getPolicy 的真实响应形状（蛇形字段，mock 用） */
const POLICY_RESPONSE = {
  policy: 'P',
  signature: 'S',
  upload_dir: 'oss://dashscope-instant/x/',
  upload_host: 'https://oss.example.com',
  oss_access_key_id: 'AKID',
};

describe('buildTalkPrompt', () => {
  it('口播模板引用 图1 与 音频1，且不包含口播稿原文（内容由音频承载）', () => {
    const p = buildTalkPrompt();
    assert.ok(p.includes('图1'), '应引用形象图');
    assert.ok(p.includes('音频1'), '应引用音频');
    assert.ok(p.includes('口型'), '应约束口型同步');
  });

  it('带货模板额外引用 图2（商品图）', () => {
    const p = buildTalkPrompt({ product: true });
    assert.ok(p.includes('图1') && p.includes('图2'));
  });
});

describe('WanTalkVideo.createTask', () => {
  it('POST {base}/services/aigc/video-generation/video-synthesis，Async 头 + media 类型/参数齐全', async () => {
    const { calls, fetchImpl } = stubFetch(() => jsonRes({ output: { task_id: 'tid-1', task_status: 'PENDING' }, request_id: 'r' }));
    const client = new WanTalkVideo(CFG, { fetchImpl });
    const { taskId } = await client.createTask({ imageUrl: 'oss://x/img.png', audioUrl: 'oss://x/aud.mp3' });

    assert.equal(taskId, 'tid-1');
    assert.equal(calls[0].url, 'https://maas.example.com/api/v1/services/aigc/video-generation/video-synthesis');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-DashScope-Async'], 'enable');
    assert.equal(headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.model, 'wan3.0-video-prime');
    assert.ok(body.input.prompt.includes('音频1'));
    assert.deepEqual(body.input.media, [
      { type: 'reference_image', url: 'oss://x/img.png' },
      { type: 'reference_audio', url: 'oss://x/aud.mp3' },
    ]);
    assert.deepEqual(body.parameters, {
      resolution: '480P',
      ratio: '9:16',
      duration: -1,
      audio: true,
      prompt_extend: false,
      watermark: false,
    });
  });

  it('传商品图时 media 为三张（形象图、商品图、音频）', async () => {
    const { calls, fetchImpl } = stubFetch(() => jsonRes({ output: { task_id: 't' } }));
    const client = new WanTalkVideo(CFG, { fetchImpl });
    await client.createTask({ imageUrl: 'oss://x/img.png', audioUrl: 'oss://x/a.mp3', productImageUrl: 'oss://x/goods.png' });
    const body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(
      body.input.media.map((m: { type: string }) => m.type),
      ['reference_image', 'reference_image', 'reference_audio'],
    );
  });

  it('上游返回 output.code → 抛错并带 code/message', async () => {
    const { fetchImpl } = stubFetch(() => jsonRes({ output: { code: 'InvalidParameter', message: 'bad input' } }));
    const client = new WanTalkVideo(CFG, { fetchImpl });
    await assert.rejects(() => client.createTask({ imageUrl: 'i', audioUrl: 'a' }), /InvalidParameter.*bad input/);
  });
});

describe('WanTalkVideo.generate（create → poll → download）', () => {
  it('轮询到 SUCCEEDED 并下载视频，usage 映射完整', async () => {
    const { calls, fetchImpl } = stubFetch((url, _init, call) => {
      if (call === 0) return jsonRes({ output: { task_id: 'tid-9', task_status: 'PENDING' } });
      if (call === 1) return jsonRes({ output: { task_status: 'PENDING' } });
      if (call === 2) return jsonRes({ output: { task_status: 'RUNNING' } });
      if (call === 3) {
        return jsonRes({
          output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example.com/v.mp4' },
          usage: { video_count: 1, duration: 12.5, output_video_duration: 12.5, fps: 30, SR: 480, ratio: '9:16' },
        });
      }
      // 下载视频
      assert.equal(url, 'https://cdn.example.com/v.mp4');
      return new Response(new Uint8Array([1, 2, 3, 4]));
    });
    const client = new WanTalkVideo(CFG, { fetchImpl, sleep: async () => {} });
    const result = await client.generate({ imageUrl: 'oss://x/img.png', audioUrl: 'oss://x/aud.mp3' });

    assert.ok(calls.some((c) => c.url.includes('/api/v1/tasks/tid-9')), '应轮询任务状态');
    assert.equal(result.remoteTaskId, 'tid-9');
    assert.deepEqual([...result.video], [1, 2, 3, 4]);
    assert.equal(result.bytes, 4);
    assert.equal(result.durationSec, 12.5);
    assert.equal(result.fps, 30);
    assert.equal(result.ratio, '9:16');
  });

  it('FAILED 状态 → 抛错带 output.message', async () => {
    let call = 0;
    const { fetchImpl } = stubFetch(() => {
      if (call++ === 0) return jsonRes({ output: { task_id: 'tid', task_status: 'PENDING' } });
      return jsonRes({ output: { task_status: 'FAILED', code: 'InternalError', message: '生成失败' } });
    });
    const client = new WanTalkVideo(CFG, { fetchImpl, sleep: async () => {} });
    await assert.rejects(() => client.generate({ imageUrl: 'i', audioUrl: 'a' }), /生成失败/);
  });

  it('超时未完成 → 抛"超时"', async () => {
    let call = 0;
    const { fetchImpl } = stubFetch(() => {
      if (call++ === 0) return jsonRes({ output: { task_id: 'tid', task_status: 'PENDING' } });
      return jsonRes({ output: { task_status: 'RUNNING' } });
    });
    const client = new WanTalkVideo({ ...CFG, timeoutMs: 30 }, { fetchImpl, sleep: async () => {} });
    await assert.rejects(() => client.generate({ imageUrl: 'i', audioUrl: 'a' }), /超时/);
  });
});

describe('generateTalkingVideo（一行封装：本地文件进、本地 mp4 出）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-test-'));
  const imagePath = path.join(dir, 'avatar.png');
  const audioPath = path.join(dir, 'tts.mp3');
  const outPath = path.join(dir, 'talking.mp4');
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('读本地图/音频 → 上传 → 生成 → 写 out 文件', async () => {
    fs.writeFileSync(imagePath, Buffer.from('fake-png'));
    fs.writeFileSync(audioPath, Buffer.from('fake-mp3'));

    const { calls, fetchImpl } = stubFetch((url, _init, call) => {
      if (url.includes('/uploads?action=getPolicy')) return jsonRes({ data: POLICY_RESPONSE });
      if (url === 'https://oss.example.com') return new Response('', { status: 200 });
      // call 0=getPolicy，1/2=两次上传，3=创建任务，4=轮询
      if (call === 3) return jsonRes({ output: { task_id: 'tid-2', task_status: 'PENDING' } });
      if (call === 4) {
        return jsonRes({
          output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example.com/v.mp4' },
          usage: { duration: 10, fps: 30, SR: 480, ratio: '9:16' },
        });
      }
      return new Response(new Uint8Array([9, 8, 7]));
    });

    const result = await generateTalkingVideo({
      imagePath,
      audioPath,
      out: outPath,
      config: CFG,
      fetchImpl,
      sleep: async () => {},
    });

    assert.equal(result.remoteTaskId, 'tid-2');
    assert.equal(result.outFile, outPath);
    assert.ok(fs.existsSync(outPath), '视频应写盘');
    assert.deepEqual([...fs.readFileSync(outPath)], [9, 8, 7]);
    // 两次上传：形象图 + 音频（表单 key 为裸键，返回值为 oss:// URL）
    const uploadKeys = calls
      .filter((c) => c.url === 'https://oss.example.com')
      .map((c) => (c.init.body as FormData).get('key'));
    assert.deepEqual(uploadKeys, ['dashscope-instant/x/avatar.png', 'dashscope-instant/x/tts.mp3']);
  });
});
