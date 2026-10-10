/**
 * Mixer nodes: the Web Audio half of the mixer.
 *
 * Two node groups make up the mix:
 *
 *  - a `SourceStrip` per routed signal source (a Channel Rack channel, or a Playlist track carrying
 *    audio clips). Voices connect to its input; its `send` node holds the one connection to the
 *    assigned mixer bus, so reassigning a source never rebuilds anything upstream of it.
 *  - a `MixerBus` per mixer channel: `input → [effect slots] → effectOutput → volume → pan → meter`,
 *    with `tail` connected to the destination bus (or, for the master, the safety limiter).
 *
 * Every parameter change is a `setTargetAtTime` ramp rather than an assignment, so fader moves,
 * mutes, and reroutes cannot click. Construction is the exception: a brand-new node is silent, so
 * its initial value is assigned directly and no automation event is scheduled.
 */

import { dbToLinear } from '../core/mixer/mixerModel';
import type { MixerChannelRole } from '../core/project/model';
import { METER_FFT_SIZE } from './metering';

/** Smoothing time constant for fader and pan moves (~12 ms to converge). */
export const MIXER_PARAM_SMOOTH_SECONDS = 0.012;
/** Faster constant for mute/unmute gates, so a mute is near-instant but still click-free. */
export const MIXER_MUTE_SMOOTH_SECONDS = 0.005;
/** Upper bound for a bus gain: `dbToLinear(MIXER_MAX_DB)` is just under 4. */
const MAX_BUS_GAIN = 4;

export function clampBusGain(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_BUS_GAIN, Math.max(0, value));
}

function safeDisconnect(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    /* already detached */
  }
}

/** Remove only the connection to `target`, leaving any other destination intact. */
function safeDisconnectFrom(node: AudioNode, target: AudioNode): void {
  try {
    node.disconnect(target);
  } catch {
    safeDisconnect(node);
  }
}

/**
 * A stereo pan stage. `StereoPannerNode` is the right node for this and is used whenever the
 * context provides it; the equal-power gain pair is a fallback for a context that does not.
 */
export interface PanStage {
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** Returns the number of AudioParam automation calls issued. */
  setPan(pan: number, when: number): number;
  dispose(): void;
}

export function createPanStage(context: AudioContext, initialPan = 0): PanStage {
  const pan = Number.isFinite(initialPan) ? Math.min(1, Math.max(-1, initialPan)) : 0;
  if (typeof context.createStereoPanner === 'function') {
    const panner = context.createStereoPanner();
    panner.pan.value = pan;
    return {
      input: panner,
      output: panner,
      setPan: (pan, when) => {
        panner.pan.setTargetAtTime(pan, when, MIXER_PARAM_SMOOTH_SECONDS);
        return 1;
      },
      dispose: () => safeDisconnect(panner),
    };
  }
  if (typeof context.createChannelMerger === 'function') {
    const input = context.createGain();
    const left = context.createGain();
    const right = context.createGain();
    const merger = context.createChannelMerger(2);
    const angle = ((pan + 1) * Math.PI) / 4;
    input.gain.value = 1;
    left.gain.value = Math.cos(angle);
    right.gain.value = Math.sin(angle);
    input.connect(left);
    input.connect(right);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    return {
      input,
      output: merger,
      setPan: (pan, when) => {
        // Equal power: the two gains follow a quarter-circle so a centred pan is unity-ish.
        const angle = ((pan + 1) * Math.PI) / 4;
        left.gain.setTargetAtTime(Math.cos(angle), when, MIXER_PARAM_SMOOTH_SECONDS);
        right.gain.setTargetAtTime(Math.sin(angle), when, MIXER_PARAM_SMOOTH_SECONDS);
        return 2;
      },
      dispose: () => {
        safeDisconnect(input);
        safeDisconnect(left);
        safeDisconnect(right);
        safeDisconnect(merger);
      },
    };
  }
  // No panner and no merger: keep the signal path intact and ignore pan.
  const mono = context.createGain();
  mono.gain.value = 1;
  return { input: mono, output: mono, setPan: () => 0, dispose: () => safeDisconnect(mono) };
}

/**
 * The effect-slot contract Phase 7 plugs into. A processor is any node pair; the bus rewires only
 * the segment between `effectInput` and `effectOutput`, so adding or bypassing an effect never
 * touches the fader, the pan, the meter, or the channel's routing.
 */
export interface AudioEffectProcessor {
  readonly id: string;
  readonly input: AudioNode;
  readonly output: AudioNode;
  dispose(): void;
}

export interface MixerBusOptions {
  id: string;
  role: MixerChannelRole;
  /** Linear fader gain applied at construction without automation. */
  initialVolume?: number;
  /** Pan applied at construction without automation. */
  initialPan?: number;
  /** Start gated (muted, or soloed out) rather than at the fader value. */
  initialAudible?: boolean;
  /** Attach an in-line analyser for metering (default true). */
  metering?: boolean;
}

export class MixerBus {
  readonly id: string;
  readonly role: MixerChannelRole;
  /** Summing point for routed sources and upstream buses; also the effect-chain input. */
  readonly input: GainNode;
  /** Effect-chain exit. Empty chains connect `input` straight to this node. */
  readonly effectOutput: GainNode;
  /** Fader gain. */
  readonly volume: GainNode;
  readonly pan: PanStage;
  /** In-line level meter tap, or null when metering is disabled. */
  readonly meter: AnalyserNode | null;
  /** The node to connect downstream. */
  readonly tail: AudioNode;

  private appliedVolume: number;
  private appliedGain: number;
  private appliedAudible: boolean;
  private appliedPan: number;
  private destination: AudioNode | null = null;
  private processors: AudioEffectProcessor[] = [];
  private disposed = false;

  constructor(context: AudioContext, options: MixerBusOptions) {
    this.id = options.id;
    this.role = options.role;
    this.input = context.createGain();
    this.effectOutput = context.createGain();
    this.volume = context.createGain();
    this.input.gain.value = 1;
    this.effectOutput.gain.value = 1;
    this.appliedVolume = clampBusGain(options.initialVolume ?? 1);
    this.appliedAudible = options.initialAudible !== false;
    this.appliedPan = Number.isFinite(options.initialPan) ? Math.min(1, Math.max(-1, options.initialPan as number)) : 0;
    this.appliedGain = this.appliedAudible ? this.appliedVolume : 0;
    this.volume.gain.value = this.appliedGain;
    this.pan = createPanStage(context, this.appliedPan);
    this.meter = options.metering === false ? null : createMeterAnalyser(context);
    this.tail = this.meter ?? this.pan.output;

    this.input.connect(this.effectOutput);
    this.effectOutput.connect(this.volume);
    this.volume.connect(this.pan.input);
    if (this.meter) this.pan.output.connect(this.meter);
  }

  /** The effect-chain entry point. Phase 7 inserts processors between this and `effectOutput`. */
  get effectInput(): GainNode {
    return this.input;
  }

  get destinationNode(): AudioNode | null {
    return this.destination;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Connect (or move) this bus's output. Returns true when a connection actually changed. */
  connectTo(destination: AudioNode): boolean {
    if (this.disposed || this.destination === destination) return false;
    if (this.destination) safeDisconnectFrom(this.tail, this.destination);
    this.tail.connect(destination);
    this.destination = destination;
    return true;
  }

  /** Fader position in dB. Returns the number of AudioParam calls issued. */
  setVolumeDb(db: number, when: number): number {
    return this.setVolumeLinear(dbToLinear(db), when);
  }

  setVolumeLinear(linear: number, when: number): number {
    const target = clampBusGain(linear);
    if (this.disposed || target === this.appliedVolume) return 0;
    this.appliedVolume = target;
    return this.applyGain(when);
  }

  /** Mute/solo gate. Folded into the fader gain so an unmute returns to the saved fader position. */
  setAudible(audible: boolean, when: number): number {
    if (this.disposed || audible === this.appliedAudible) return 0;
    this.appliedAudible = audible;
    return this.applyGain(when);
  }

  setPan(pan: number, when: number): number {
    const target = Number.isFinite(pan) ? Math.min(1, Math.max(-1, pan)) : 0;
    if (this.disposed || target === this.appliedPan) return 0;
    this.appliedPan = target;
    return this.pan.setPan(target, when);
  }

  /**
   * Replace the effect-slot chain. An empty list restores the unity bypass that Phase 6 ships with.
   * Returns true when the chain was rewired.
   */
  setEffectChain(processors: readonly AudioEffectProcessor[]): boolean {
    if (this.disposed) return false;
    const next = [...processors];
    if (next.length === this.processors.length && next.every((processor, index) => processor === this.processors[index])) {
      return false;
    }
    // Tear the current chain down symmetrically, so no stale connection to a removed processor
    // can keep feeding signal into the bus.
    let source: AudioNode = this.input;
    for (const processor of this.processors) {
      safeDisconnectFrom(source, processor.input);
      source = processor.output;
    }
    safeDisconnectFrom(source, this.effectOutput);
    this.processors = next;
    source = this.input;
    for (const processor of next) {
      source.connect(processor.input);
      source = processor.output;
    }
    source.connect(this.effectOutput);
    return true;
  }

  get effectChain(): readonly AudioEffectProcessor[] {
    return this.processors;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const processor of this.processors) safeDisconnectFrom(this.input, processor.input);
    this.processors = [];
    if (this.destination) safeDisconnectFrom(this.tail, this.destination);
    this.destination = null;
    safeDisconnect(this.input);
    safeDisconnect(this.effectOutput);
    safeDisconnect(this.volume);
    this.pan.dispose();
    if (this.meter) safeDisconnect(this.meter);
  }

  private applyGain(when: number): number {
    const target = this.appliedAudible ? this.appliedVolume : 0;
    if (target === this.appliedGain) return 0;
    // Crossing to or from silence is a mute gesture, which should land faster than a fader move.
    const timeConstant = target === 0 || this.appliedGain === 0 ? MIXER_MUTE_SMOOTH_SECONDS : MIXER_PARAM_SMOOTH_SECONDS;
    this.volume.gain.setTargetAtTime(target, when, timeConstant);
    this.appliedGain = target;
    return 1;
  }
}

function createMeterAnalyser(context: AudioContext): AnalyserNode | null {
  if (typeof context.createAnalyser !== 'function') return null;
  const analyser = context.createAnalyser();
  analyser.fftSize = METER_FFT_SIZE;
  // Meters need no frequency smoothing; the ballistics in `metering.ts` shape the display.
  analyser.smoothingTimeConstant = 0;
  return analyser;
}

/**
 * A routed signal source's connection into the mixer. Exactly one send target, so a source can
 * never reach the master bus twice or through two paths at once.
 */
export class SourceStrip {
  readonly id: string;
  /** Voices connect here. */
  readonly input: GainNode;
  /** Stable routing output; holds the single connection to the assigned mixer bus. */
  readonly send: GainNode;

  private destination: AudioNode | null = null;
  private appliedSendGain = 1;
  private disposed = false;

  constructor(context: AudioContext, id: string) {
    this.id = id;
    this.input = context.createGain();
    this.send = context.createGain();
    this.input.gain.value = 1;
    this.send.gain.value = 1;
    this.input.connect(this.send);
  }

  get destinationNode(): AudioNode | null {
    return this.destination;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Route this source to a bus input. Returns true when the connection actually changed. */
  connectTo(destination: AudioNode): boolean {
    if (this.disposed || this.destination === destination) return false;
    if (this.destination) safeDisconnectFrom(this.send, this.destination);
    this.send.connect(destination);
    this.destination = destination;
    return true;
  }

  /** Per-source trim, kept separate from the mixer channel fader. */
  setSendGain(gain: number, when: number): number {
    const target = clampBusGain(gain);
    if (this.disposed || target === this.appliedSendGain) return 0;
    this.appliedSendGain = target;
    this.send.gain.setTargetAtTime(target, when, MIXER_PARAM_SMOOTH_SECONDS);
    return 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.destination) safeDisconnectFrom(this.send, this.destination);
    this.destination = null;
    safeDisconnect(this.input);
    safeDisconnect(this.send);
  }
}
