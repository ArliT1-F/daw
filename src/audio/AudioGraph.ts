/**
 * Audio graph ownership.
 *
 * Every node created for playback lives under this graph: channel buses feed a master gain,
 * which feeds a safety limiter and then the destination. The rest of the app deals in musical
 * events, never in nodes.
 */

export interface AudioGraphOptions {
  /** Linear master gain, 0..1.5. */
  masterGain?: number;
}

export class AudioGraph {
  readonly context: AudioContext;
  readonly masterInput: GainNode;
  readonly masterGain: GainNode;
  readonly limiter: DynamicsCompressorNode;

  private readonly channelBuses = new Map<string, GainNode>();
  private noiseBuffer: AudioBuffer | null = null;
  private disposed = false;

  constructor(context: AudioContext, options: AudioGraphOptions = {}) {
    this.context = context;
    this.masterInput = context.createGain();
    this.masterGain = context.createGain();
    this.limiter = context.createDynamicsCompressor();

    this.masterGain.gain.value = clampGain(options.masterGain ?? 0.8, 0, 1.5);
    // Safety limiter: keeps stacked voices from clipping the output without colouring quiet mixes.
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.masterInput.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(context.destination);
  }

  /** Per-channel bus, created on demand so mixer routing has a single home. */
  getChannelBus(channelId: string): GainNode {
    const existing = this.channelBuses.get(channelId);
    if (existing) return existing;
    const bus = this.context.createGain();
    bus.gain.value = 1;
    bus.connect(this.masterInput);
    this.channelBuses.set(channelId, bus);
    return bus;
  }

  setChannelGain(channelId: string, gain: number, when = this.context.currentTime): void {
    const bus = this.getChannelBus(channelId);
    bus.gain.setTargetAtTime(clampGain(gain, 0, 1.5), when, 0.01);
  }

  setMasterGain(gain: number, when = this.context.currentTime): void {
    this.masterGain.gain.setTargetAtTime(clampGain(gain, 0, 1.5), when, 0.01);
  }

  /** Shared white-noise buffer for percussion voices. */
  getNoiseBuffer(): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const length = Math.max(1, Math.floor(this.context.sampleRate * 0.5));
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
    return buffer;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bus of this.channelBuses.values()) {
      try {
        bus.disconnect();
      } catch {
        /* node already detached */
      }
    }
    this.channelBuses.clear();
    try {
      this.masterInput.disconnect();
      this.masterGain.disconnect();
      this.limiter.disconnect();
    } catch {
      /* already detached */
    }
    this.noiseBuffer = null;
  }
}

function clampGain(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
