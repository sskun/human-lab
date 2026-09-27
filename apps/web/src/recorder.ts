/**
 * 浏览器录音 → 16kHz 单声道 WAV → base64（供 POST /api/listen 上传）
 *
 * 为什么不用 MediaRecorder：其输出容器随浏览器漂移（Chrome=webm/opus，Safari=mp4/aac），
 * 而"前端重采样成 wav/16000"是唯一三端一致、且正好是 ASR 文档标准姿势的方案
 * （docs/asr-design.md §4.5）。
 *
 * 采集用 ScriptProcessorNode（虽已标记 deprecated，但所有浏览器都支持，且无需
 * AudioWorklet 那样单独的模块文件；对"按住说话"这种短录音场景足够）。
 */

/** 目标采样率：ASR 文档标准姿势（wav/16000） */
const TARGET_SAMPLE_RATE = 16000;

export interface RecordingResult {
  /** WAV 文件的 base64（裸，不含 data: 前缀） */
  wavBase64: string;
  /** 实际录音时长（毫秒） */
  durationMs: number;
}

export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private frames = 0;
  private startedAt = 0;
  private stopped = false;

  /** 请求麦克风并开始采集。权限被拒时抛 NotAllowedError。 */
  async start(): Promise<void> {
    if (this.ctx) throw new Error('录音已在进行中');
    this.chunks = [];
    this.frames = 0;
    this.stopped = false;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true },
    });
    // 不强制指定 sampleRate（部分浏览器会忽略），重采样在 stop() 里做
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (this.stopped) return;
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length); // inputBuffer 底层内存会被复用，必须拷贝
      copy.set(input);
      this.chunks.push(copy);
      this.frames += copy.length;
    };
    // ScriptProcessor 需要连到目的地才会触发；经零增益节点避免回声外放
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(sink);
    sink.connect(this.ctx.destination);
    this.startedAt = Date.now();
  }

  /** 停止采集并产出 16kHz WAV（base64）。未在录音时返回 null。 */
  async stop(): Promise<RecordingResult | null> {
    if (!this.ctx) return null;
    this.stopped = true;
    const durationMs = Date.now() - this.startedAt;
    const sampleRate = this.ctx.sampleRate;

    this.teardown();

    const merged = new Float32Array(this.frames);
    let off = 0;
    for (const c of this.chunks) {
      merged.set(c, off);
      off += c.length;
    }
    this.chunks = [];

    const wav = encodeWav(resample(merged, sampleRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
    return { wavBase64: arrayBufferToBase64(wav), durationMs };
  }

  /** 丢弃录音并释放资源（用于出错时清理） */
  cancel(): void {
    this.stopped = true;
    this.chunks = [];
    this.teardown();
  }

  /** 断开音频图、关闭媒体流与 AudioContext（幂等） */
  private teardown(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}

/** 线性插值重采样（语音识别场景对精度要求不高，够用） */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const outLen = Math.round(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** Float32 PCM → 16bit 单声道 WAV（44 字节头） */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率 = 采样率 × 2 字节
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/** ArrayBuffer → base64（分块避免 String.fromCharCode 爆栈） */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ———— 连续对话（免按键）：VAD 自动断句 ————

/** 倾听状态：calibrating=环境噪声采样中 / listening=在听（静音）/ speaking=正在说话 */
export type ListenState = 'calibrating' | 'listening' | 'speaking';

export interface Utterance {
  /** 16kHz WAV 的 base64（裸，不含 data: 前缀） */
  wavBase64: string;
  /** 语音时长（毫秒） */
  durationMs: number;
}

/**
 * 连续倾听录音器：麦克风一直开着，内置音量活动检测（VAD）自动切句——
 *   环境噪声自动校准 → 音量超阈值连续 2 帧判定开口（带 ~250ms 前滚缓冲防掐头）
 *   → 静音连续 ~950ms 判定说完 → onUtterance 回调整句 WAV → 继续倾听。
 *
 * 供"和数字人直接对话"用：说话→断句→送 ASR→播放回复期间用 setCapture(false) 停止
 * 采集（防止把喇叭里的回答录进去），播完 setCapture(true) 恢复。
 * 参数都是帧数（1 帧 = 4096 采样 ≈ 85ms@48kHz），按经验值选取，不合适时调常量即可。
 */
export class AutoRecorder {
  /** 环境噪声校准帧数（≈0.9s） */
  private static CALIBRATION_FRAMES = 10;
  /** 判定开口所需连续超阈值帧数（≈0.17s） */
  private static SPEECH_START_FRAMES = 2;
  /** 判定说完所需连续静音帧数（≈0.95s） */
  private static SILENCE_END_FRAMES = 11;
  /** 前滚缓冲上限（≈0.25s，防止句子开头被掐掉） */
  private static PREROLL_MS = 250;
  /** 有效语音最短时长（短于此的段落按噪声丢弃） */
  private static MIN_UTTERANCE_MS = 500;
  /** 单句上限（到时强制切分） */
  private static MAX_UTTERANCE_MS = 15_000;
  /** 音量阈值夹取范围（校准结果的上下限） */
  private static THRESHOLD_MIN = 0.012;
  private static THRESHOLD_MAX = 0.1;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  private capturing = true;
  private stopped = false;
  private state: ListenState = 'calibrating';

  private noiseFrames: number[] = [];
  private threshold = AutoRecorder.THRESHOLD_MIN;
  private speechRun = 0;
  private silenceRun = 0;
  private preroll: Float32Array[] = []; // 说话前的滚动缓冲（开口时并入整句）
  private prerollFrames = 0;
  private utterance: Float32Array[] = [];
  private utteranceFrames = 0;

  constructor(private callbacks: { onUtterance?: (u: Utterance) => void; onStateChange?: (s: ListenState) => void } = {}) {}

  /** 请求麦克风并开始倾听。权限被拒时抛 NotAllowedError。 */
  async start(): Promise<void> {
    if (this.ctx) throw new Error('倾听已在进行中');
    this.resetVad();
    this.capturing = true;
    this.stopped = false;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true },
    });
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => this.onFrame(e.inputBuffer.getChannelData(0));
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(sink);
    sink.connect(this.ctx.destination);
    this.setState('calibrating');
  }

  /**
   * 开/关采集：关时丢弃输入并复位断句状态（播放回复/发送中用），开时恢复倾听。
   * 麦克风流保持打开，避免反复触发权限与设备初始化。
   */
  setCapture(on: boolean): void {
    this.capturing = on;
    this.resetVad();
    if (on && !this.stopped) this.setState(this.noiseFrames.length >= AutoRecorder.CALIBRATION_FRAMES ? 'listening' : 'calibrating');
  }

  isCapturing(): boolean {
    return this.capturing;
  }

  /** 停止并释放麦克风（幂等） */
  stop(): void {
    this.stopped = true;
    this.resetVad();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }

  private setState(s: ListenState): void {
    if (this.state === s) return;
    this.state = s;
    this.callbacks.onStateChange?.(s);
  }

  /** 一帧音频（~85ms）进来：校准 → 静音/语音判定 → 切句 */
  private onFrame(raw: Float32Array): void {
    if (this.stopped || !this.capturing || !this.ctx) return;
    const chunk = new Float32Array(raw); // inputBuffer 底层内存会被复用，必须拷贝
    const rms = Math.sqrt(chunk.reduce((s, v) => s + v * v, 0) / chunk.length);

    // ① 环境噪声校准：前 N 帧取均值，阈值 = 均值×2.5（夹取到经验区间）
    if (this.noiseFrames.length < AutoRecorder.CALIBRATION_FRAMES) {
      this.noiseFrames.push(rms);
      if (this.noiseFrames.length >= AutoRecorder.CALIBRATION_FRAMES) {
        const avg = this.noiseFrames.reduce((a, b) => a + b, 0) / this.noiseFrames.length;
        this.threshold = Math.min(AutoRecorder.THRESHOLD_MAX, Math.max(AutoRecorder.THRESHOLD_MIN, avg * 2.5));
        this.setState('listening');
      }
      return;
    }

    const speaking = this.state === 'speaking';

    if (!speaking) {
      // ② 静音期：滚动维护前滚缓冲，连续 2 帧超阈值判定开口
      this.preroll.push(chunk);
      this.prerollFrames += chunk.length;
      const maxPrerollFrames = (this.ctx.sampleRate * AutoRecorder.PREROLL_MS) / 1000;
      while (this.prerollFrames > maxPrerollFrames && this.preroll.length > 0) {
        this.prerollFrames -= this.preroll[0].length;
        this.preroll.shift();
      }
      if (rms > this.threshold) {
        this.speechRun += 1;
        if (this.speechRun >= AutoRecorder.SPEECH_START_FRAMES) {
          this.setState('speaking');
          this.silenceRun = 0;
          this.utterance = [...this.preroll]; // 带上开口前的缓冲
          this.utteranceFrames = this.prerollFrames;
          this.preroll = [];
          this.prerollFrames = 0;
        }
      } else {
        this.speechRun = 0;
      }
      return;
    }

    // ③ 说话期：累积整句，静音连续 ~0.95s（或到时长上限）判定说完
    this.utterance.push(chunk);
    this.utteranceFrames += chunk.length;
    const durationMs = (this.utteranceFrames / this.ctx.sampleRate) * 1000;
    this.silenceRun = rms > this.threshold ? 0 : this.silenceRun + 1;
    if (this.silenceRun >= AutoRecorder.SILENCE_END_FRAMES || durationMs >= AutoRecorder.MAX_UTTERANCE_MS) {
      this.emitUtterance(durationMs);
    }
  }

  /** 切句：太短按噪声丢弃；否则整句转 16kHz WAV 交回调，随后回到倾听态 */
  private emitUtterance(durationMs: number): void {
    const sampleRate = this.ctx!.sampleRate;
    const chunks = this.utterance;
    const frames = this.utteranceFrames;
    this.resetVad();
    this.setState('listening');
    if (durationMs < AutoRecorder.MIN_UTTERANCE_MS || frames === 0) return;

    const merged = new Float32Array(frames);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    const wav = encodeWav(resample(merged, sampleRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
    this.callbacks.onUtterance?.({ wavBase64: arrayBufferToBase64(wav), durationMs });
  }

  /** 复位断句状态（保留校准结果） */
  private resetVad(): void {
    this.speechRun = 0;
    this.silenceRun = 0;
    this.preroll = [];
    this.prerollFrames = 0;
    this.utterance = [];
    this.utteranceFrames = 0;
  }
}
