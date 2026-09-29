// 数字人视频页：生成进度步骤推导
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineSteps } from '../src/lib/video.ts';

const states = (steps: ReturnType<typeof pipelineSteps>) => steps.map((s) => `${s.key}:${s.state}`);

test('口播视频四步、仅语音跳过「生成视频」', () => {
  assert.deepEqual(
    pipelineSteps(true, null).map((s) => s.label),
    ['排队', '合成语音', '生成视频', '完成'],
  );
  assert.deepEqual(
    pipelineSteps(false, null).map((s) => s.label),
    ['排队', '合成语音', '完成'],
  );
});

test('进行中：按 status / stage 推进当前步', () => {
  // 已提交、首次轮询结果未到
  assert.deepEqual(states(pipelineSteps(true, null)), ['queue:doing', 'tts:todo', 'lipsync:todo', 'done:todo']);
  assert.deepEqual(states(pipelineSteps(true, { status: 'queued' })), ['queue:doing', 'tts:todo', 'lipsync:todo', 'done:todo']);
  assert.deepEqual(states(pipelineSteps(true, { status: 'processing', stage: 'tts' })), ['queue:done', 'tts:doing', 'lipsync:todo', 'done:todo']);
  assert.deepEqual(states(pipelineSteps(true, { status: 'processing', stage: 'lipsync' })), ['queue:done', 'tts:done', 'lipsync:doing', 'done:todo']);
  // 仅语音任务服务端不写 stage
  assert.deepEqual(states(pipelineSteps(false, { status: 'processing' })), ['queue:done', 'tts:doing', 'done:todo']);
});

test('完成：全部 done', () => {
  assert.ok(pipelineSteps(true, { status: 'done' }).every((s) => s.state === 'done'));
  assert.ok(pipelineSteps(false, { status: 'done' }).every((s) => s.state === 'done'));
});

test('失败：按服务端保留的 stage 标在出错的那一步（不依赖轮询是否观察到中间态）', () => {
  assert.deepEqual(states(pipelineSteps(true, { status: 'failed', stage: 'lipsync' })), ['queue:done', 'tts:done', 'lipsync:failed', 'done:todo']);
  assert.deepEqual(states(pipelineSteps(true, { status: 'failed', stage: 'tts' })), ['queue:done', 'tts:failed', 'lipsync:todo', 'done:todo']);
  assert.deepEqual(states(pipelineSteps(false, { status: 'failed' })), ['queue:done', 'tts:failed', 'done:todo']);
});
