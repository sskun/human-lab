// 数字人视频页：生成进度步骤推导（纯函数，无 DOM 依赖，可直接单测）
import type { TaskView } from '@human-lab/shared';

export type StepState = 'todo' | 'doing' | 'done' | 'failed';

export interface PipelineStep {
  key: 'queue' | 'tts' | 'lipsync' | 'done';
  label: string;
  state: StepState;
}

/**
 * 任务 → 进度步骤。task 为 null 表示已提交、首次轮询结果未到（视为排队中）。
 * 失败时按服务端保留的 stage 定位出错步骤：口播流水线 lipsync 失败会保留 stage='lipsync'，
 * 其余（tts 失败 / 仅语音任务）都算「合成语音」失败——服务端不会在排队阶段失败。
 */
export function pipelineSteps(withVideo: boolean, task: Pick<TaskView, 'status' | 'stage'> | null): PipelineStep[] {
  const keys: PipelineStep['key'][] = withVideo ? ['queue', 'tts', 'lipsync', 'done'] : ['queue', 'tts', 'done'];
  const labels: Record<PipelineStep['key'], string> = { queue: '排队', tts: '合成语音', lipsync: '生成视频', done: '完成' };

  let current: PipelineStep['key'] = 'queue';
  let state: StepState = 'doing';
  if (task?.status === 'done') {
    current = 'done';
    state = 'done';
  } else if (task?.status === 'processing' || task?.status === 'failed') {
    current = withVideo && task.stage === 'lipsync' ? 'lipsync' : 'tts';
    state = task.status === 'failed' ? 'failed' : 'doing';
  }

  const at = keys.indexOf(current);
  return keys.map((key, i) => ({
    key,
    label: labels[key],
    state: i < at ? 'done' : i === at ? state : 'todo',
  }));
}
