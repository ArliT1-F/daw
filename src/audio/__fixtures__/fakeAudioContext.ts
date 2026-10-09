/**
 * Minimal Web Audio double for tests.
 *
 * Node has no AudioContext, so the engine takes an injectable `createContext`. This fake
 * implements only the surface the engine and voices actually use, and records enough to assert
 * scheduling behaviour (what was created, when it was started, when it stopped).
 */

export interface ParamCall {
  method: string;
  value: number;
  time: number;
}

export class FakeAudioParam {
  value: number;
  readonly calls: ParamCall[] = [];

  constructor(value = 0) {
    this.value = value;
  }

  setValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'setValueAtTime', value, time });
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'linearRampToValueAtTime', value, time });
    this.value = value;
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'exponentialRampToValueAtTime', value, time });
    this.value = value;
    return this;
  }

  setTargetAtTime(value: number, time: number, timeConstant: number): this {
    this.calls.push({ method: 'setTargetAtTime', value, time });
    this.value = value;
    void timeConstant;
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.calls.push({ method: 'cancelScheduledValues', value: this.value, time });
    return this;
  }
}

export class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];

  connect(destination: FakeAudioNode): FakeAudioNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

export class FakeAudioSourceNode extends FakeAudioNode {
  startedAt: number | null = null;
  stopAt: number | null = null;
  ended = false;
  onended: (() => void) | null = null;

  start(time = 0): void {
    this.startedAt = time;
  }

  stop(time = 0): void {
    if (this.startedAt === null) {
      const error = new Error("Failed to execute 'stop' on 'AudioScheduledSourceNode': cannot call stop without calling start first.");
      error.name = 'InvalidStateError';
      throw error;
    }
    this.stopAt = time;
  }
}

export class FakeOscillatorNode extends FakeAudioSourceNode {
  type = 'sine';
  frequency = new FakeAudioParam(440);
  detune = new FakeAudioParam(0);
}

export class FakeBufferSourceNode extends FakeAudioSourceNode {
  buffer: FakeAudioBuffer | null = null;
  playbackRate = new FakeAudioParam(1);
}

export class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam(1);
}

export class FakeBiquadFilterNode extends FakeAudioNode {
  type = 'lowpass';
  frequency = new FakeAudioParam(350);
  Q = new FakeAudioParam(1);
  gain = new FakeAudioParam(0);
}

export class FakeDynamicsCompressorNode extends FakeAudioNode {
  threshold = new FakeAudioParam(-24);
  knee = new FakeAudioParam(30);
  ratio = new FakeAudioParam(12);
  attack = new FakeAudioParam(0.003);
  release = new FakeAudioParam(0.25);
}

export class FakeAudioBuffer {
  private readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

export interface FakeContextOptions {
  /** Start in the running state, as a context resumed inside a user gesture would. */
  startRunning?: boolean;
  sampleRate?: number;
}

export class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState | 'interrupted' = 'suspended';
  sampleRate: number;
  baseLatency = 0;
  outputLatency = 0;
  onstatechange: (() => void) | null = null;
  readonly destination = new FakeAudioNode();
  readonly gains: FakeGainNode[] = [];
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly bufferSources: FakeBufferSourceNode[] = [];
  readonly filters: FakeBiquadFilterNode[] = [];
  readonly compressors: FakeDynamicsCompressorNode[] = [];
  resumeCount = 0;
  suspendCount = 0;
  closeCount = 0;
  /** Next resume() rejects with a NotAllowedError, as an autoplay block would. */
  failNextResume = false;

  constructor(options: FakeContextOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    if (options.startRunning) this.state = 'running';
  }

  get sources(): FakeAudioSourceNode[] {
    return [...this.oscillators, ...this.bufferSources];
  }

  /** Sounding sources at `time` (started, not yet ended). */
  getSoundingSources(time = this.currentTime): FakeAudioSourceNode[] {
    return this.sources.filter(
      (source) => source.startedAt !== null && source.startedAt <= time && (source.stopAt ?? Infinity) > time,
    );
  }

  /** Advance the clock and fire `onended` for everything that has reached its stop time. */
  advanceTo(time: number): void {
    this.currentTime = time;
    for (const source of this.sources) {
      if (source.ended || source.startedAt === null) continue;
      const stopAt = source.stopAt ?? Infinity;
      if (stopAt <= time) {
        source.ended = true;
        source.onended?.();
      }
    }
  }

  advance(seconds: number): void {
    this.advanceTo(this.currentTime + seconds);
  }

  async resume(): Promise<void> {
    this.resumeCount += 1;
    if (this.failNextResume) {
      this.failNextResume = false;
      const error = new Error('The AudioContext was not allowed to start.');
      error.name = 'NotAllowedError';
      throw error;
    }
    this.setState('running');
  }

  async suspend(): Promise<void> {
    this.suspendCount += 1;
    this.setState('suspended');
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.setState('closed');
  }

  setState(state: AudioContextState | 'interrupted'): void {
    this.state = state;
    this.onstatechange?.();
  }

  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createOscillator(): FakeOscillatorNode {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }

  createBufferSource(): FakeBufferSourceNode {
    const node = new FakeBufferSourceNode();
    this.bufferSources.push(node);
    return node;
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    const node = new FakeBiquadFilterNode();
    this.filters.push(node);
    return node;
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    const node = new FakeDynamicsCompressorNode();
    this.compressors.push(node);
    return node;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
  }
}

export interface FakeContextBundle {
  /** The double, typed as the real thing so it can be injected into the engine. */
  context: AudioContext;
  fake: FakeAudioContext;
}

export function createFakeAudioContext(options: FakeContextOptions = {}): FakeContextBundle {
  const fake = new FakeAudioContext(options);
  return { context: fake as unknown as AudioContext, fake };
}
