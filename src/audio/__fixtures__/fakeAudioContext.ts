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
  /** Outgoing connections, in the order they were made. Duplicate entries are kept, so a test can
   *  detect a signal path that was connected twice. */
  readonly connections: FakeAudioNode[] = [];

  connect(destination: FakeAudioNode, _outputIndex = 0, _inputIndex = 0): FakeAudioNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(destination?: FakeAudioNode): void {
    if (!destination) {
      this.connections.length = 0;
      return;
    }
    const index = this.connections.lastIndexOf(destination);
    if (index >= 0) this.connections.splice(index, 1);
  }

  /** Number of outgoing connections. */
  get connectionCount(): number {
    return this.connections.length;
  }

  /** True when this node reaches `target` through any chain of connections. */
  reaches(target: FakeAudioNode, seen = new Set<FakeAudioNode>()): boolean {
    if (seen.has(this)) return false;
    seen.add(this);
    for (const next of this.connections) {
      if (next === target || next.reaches(target, seen)) return true;
    }
    return false;
  }

  /** True when following connections from this node can return to it. */
  get hasFeedbackPath(): boolean {
    return this.reaches(this);
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
  offsetSeconds = 0;
  durationSeconds: number | undefined;

  override start(time = 0, offset = 0, duration?: number): void {
    super.start(time);
    this.offsetSeconds = offset;
    this.durationSeconds = duration;
  }
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

export class FakeStereoPannerNode extends FakeAudioNode {
  pan = new FakeAudioParam(0);
}

/**
 * Analyser double. `amplitude` sets the peak of a synthetic sine the node hands out, so meter tests
 * are deterministic: peak equals `amplitude` and RMS equals `amplitude / sqrt(2)`.
 */
export class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  amplitude = 0;
  /** Number of times the meter polled this node. */
  readCount = 0;

  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }

  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void {
    this.readCount += 1;
    for (let index = 0; index < array.length; index += 1) {
      array[index] = this.amplitude * Math.sin((2 * Math.PI * index) / 32);
    }
  }

  getByteTimeDomainData(array: Uint8Array<ArrayBuffer>): void {
    this.readCount += 1;
    for (let index = 0; index < array.length; index += 1) {
      array[index] = Math.round(128 + 127 * this.amplitude * Math.sin((2 * Math.PI * index) / 32));
    }
  }
}

export class FakeChannelMergerNode extends FakeAudioNode {
  constructor(readonly inputs = 1) {
    super();
  }
}

export class FakeChannelSplitterNode extends FakeAudioNode {
  constructor(readonly outputs = 1) {
    super();
  }
}

export class FakeAudioBuffer {
  private readonly channels: Float32Array[] = [];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    for (let index = 0; index < numberOfChannels; index += 1) this.channels.push(new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

export interface FakeContextOptions {
  /** Start in the running state, as a context resumed inside a user gesture would. */
  startRunning?: boolean;
  sampleRate?: number;
  /** Set false to simulate a context without `StereoPannerNode` and exercise the panner fallback. */
  supportsStereoPanner?: boolean;
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
  readonly stereoPanners: FakeStereoPannerNode[] = [];
  readonly analysers: FakeAnalyserNode[] = [];
  readonly mergers: FakeChannelMergerNode[] = [];
  readonly splitters: FakeChannelSplitterNode[] = [];
  /** Absent (not merely unused) when the context does not support stereo panning. */
  readonly createStereoPanner: (() => FakeStereoPannerNode) | undefined;
  resumeCount = 0;
  suspendCount = 0;
  closeCount = 0;
  /** Next resume() rejects with a NotAllowedError, as an autoplay block would. */
  failNextResume = false;
  /** Next decodeAudioData() rejects, as an unsupported codec would. */
  failNextDecode = false;
  decodeCount = 0;

  constructor(options: FakeContextOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    if (options.startRunning) this.state = 'running';
    this.createStereoPanner = options.supportsStereoPanner === false
      ? undefined
      : () => {
          const node = new FakeStereoPannerNode();
          this.stereoPanners.push(node);
          return node;
        };
  }

  /** Total number of nodes the context handed out, used to prove a graph was not rebuilt. */
  get nodeCount(): number {
    return (
      this.gains.length + this.oscillators.length + this.bufferSources.length + this.filters.length +
      this.compressors.length + this.stereoPanners.length + this.analysers.length +
      this.mergers.length + this.splitters.length
    );
  }

  async decodeAudioData(_data: ArrayBuffer): Promise<FakeAudioBuffer> {
    this.decodeCount += 1;
    if (this.failNextDecode) {
      this.failNextDecode = false;
      const error = new Error('The encoded audio data is not supported.');
      error.name = 'EncodingError';
      throw error;
    }
    return new FakeAudioBuffer(1, Math.round(this.sampleRate * 0.25), this.sampleRate);
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

  createAnalyser(): FakeAnalyserNode {
    const node = new FakeAnalyserNode();
    this.analysers.push(node);
    return node;
  }

  createChannelMerger(inputs = 1): FakeChannelMergerNode {
    const node = new FakeChannelMergerNode(inputs);
    this.mergers.push(node);
    return node;
  }

  createChannelSplitter(outputs = 1): FakeChannelSplitterNode {
    const node = new FakeChannelSplitterNode(outputs);
    this.splitters.push(node);
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
