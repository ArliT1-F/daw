import type { MusicalEventKind, ScheduledEventTiming } from '../core/events/musicalEvents';
import { DEFAULT_SYNTH_PARAMS, type SynthParams } from '../core/instruments/synthModel';
import type { SampleTrim } from '../core/project/model';
import type { AudioGraph } from './AudioGraph';
import { buildSynthNote } from './synthVoice';

/**
 * Voices: the only place that creates Web Audio nodes for a musical event.
 *
 * The starter kit synthesises its drum and synth voices (there are no sample assets yet). A real
 * sampler would add a case here; the event interface stays the same, so nothing upstream changes.
 */

/** Short fade applied when a voice is cut, avoiding clicks on stop/seek. */
export const VOICE_RELEASE_SECONDS = 0.008;
const SILENCE = 0.0001;

/**
 * Polyphony limits. A new voice beyond either limit steals the oldest voice in scope, releasing it
 * with the short cut fade, so a dense pattern or a stuck loop cannot grow the node graph forever.
 */
export const MAX_ACTIVE_VOICES = 96;
export const MAX_VOICES_PER_CHANNEL = 16;

export interface Voice {
  readonly id: string;
  readonly channelId: string;
  readonly kind: MusicalEventKind;
  readonly startTime: number;
  /** Time at which the voice stops sounding; shortened when cut. */
  endTime: number;
  /** Cut the voice at `atTime` (or immediately when the voice has already started). */
  stop(atTime: number): void;
  /** Cut a voice that has not started sounding yet. */
  cancel(): void;
  dispose(): void;
}

interface VoiceParts {
  sources: AudioScheduledSourceNode[];
  /** Envelope gains that are faded out when the voice is cut. */
  gains: GainNode[];
  endTime: number;
  /** Buffer playback window, when the voice reads a decoded buffer rather than an oscillator. */
  start?: { offset: number; duration: number };
}

/**
 * Per-channel playback settings resolved at voice-build time. Read live from the engine, so
 * editing a synth or a sample region changes the next note without touching the arrangement.
 */
export interface ChannelVoiceSettings {
  /** Loaded sample assigned to the channel, if any. */
  sampleId?: string;
  sampleTrim?: SampleTrim;
  /** Synth patch for instrument channels. Absent = the default patch. */
  synth?: SynthParams;
}

export type ChannelResolver = (channelId: string) => ChannelVoiceSettings | null;

export type DrumVoiceId = 'kick' | 'snare' | 'hat' | 'perc';

/** Resolves a sample id to a decoded buffer, or null when the id has no loaded asset. */
export type SampleResolver = (sampleId: string) => AudioBuffer | null;

/** Resolve a sample id to a built-in voice. Starter channels map to the drum kit. */
export function resolveDrumVoice(sampleId: string): DrumVoiceId {
  const id = sampleId.toLowerCase();
  if (id.includes('kick')) return 'kick';
  if (id.includes('snare') || id.includes('clap')) return 'snare';
  if (id.includes('hat')) return 'hat';
  return 'perc';
}

export function midiToFrequency(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

class WebAudioVoice implements Voice {
  endTime: number;
  private disposed = false;
  private finished = false;
  private remainingSources: number;

  constructor(
    readonly id: string,
    readonly channelId: string,
    readonly kind: MusicalEventKind,
    readonly startTime: number,
    endTime: number,
    private readonly context: AudioContext,
    private readonly sources: AudioScheduledSourceNode[],
    private readonly gains: GainNode[],
    private readonly onEnded: (voice: Voice) => void,
  ) {
    this.endTime = endTime;
    this.remainingSources = sources.length;
    for (const source of sources) {
      source.onended = () => {
        this.remainingSources -= 1;
        if (this.remainingSources <= 0) this.finish();
      };
    }
  }

  stop(atTime: number): void {
    if (this.disposed || this.finished) return;
    const cutAt = Math.max(atTime, this.startTime, this.context.currentTime);
    for (const gain of this.gains) {
      try {
        const param = gain.gain;
        param.cancelScheduledValues(cutAt);
        param.setValueAtTime(Math.max(SILENCE, param.value), cutAt);
        param.exponentialRampToValueAtTime(SILENCE, cutAt + VOICE_RELEASE_SECONDS);
      } catch {
        /* automation already finished */
      }
    }
    const stopAt = cutAt + VOICE_RELEASE_SECONDS;
    for (const source of this.sources) {
      try {
        source.stop(stopAt);
      } catch {
        /* source already stopped */
      }
    }
    this.endTime = Math.min(this.endTime, stopAt);
  }

  cancel(): void {
    if (this.disposed || this.finished) return;
    if (this.context.currentTime >= this.startTime) {
      this.stop(this.context.currentTime);
      return;
    }
    // A cancelled future source must never sound, even for the release fade.
    for (const source of this.sources) {
      try { source.stop(this.context.currentTime); } catch { /* already stopped */ }
    }
    this.endTime = this.context.currentTime;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.disconnect();
      } catch {
        /* already detached */
      }
    }
    for (const gain of this.gains) {
      try {
        gain.disconnect();
      } catch {
        /* already detached */
      }
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    this.onEnded(this);
  }
}

/**
 * Build and start a voice for a scheduled event. Returns null for unsupported event kinds, for
 * zero-velocity events, and for an assigned sample that is not loaded (a missing sample is silent
 * and is never replaced by a synthesized substitute).
 */
export function createVoice(
  timing: ScheduledEventTiming,
  graph: AudioGraph,
  onEnded: (voice: Voice) => void,
  resolveSample?: SampleResolver,
  resolveChannel?: ChannelResolver,
): Voice | null {
  const { event, time } = timing;
  if (event.velocity <= 0) return null;
  const destination = graph.getChannelBus(event.channelId);
  const channel = event.kind === 'sample' || event.kind === 'note' ? resolveChannel?.(event.channelId) ?? null : null;
  const buffer = event.kind === 'sample' ? resolveSample?.(event.sampleId) : event.kind === 'audio' ? resolveSample?.(event.assetId) : null;
  let parts: VoiceParts | null;
  if (event.kind === 'sample') {
    if (buffer) {
      parts = createSampleParts(graph, buffer, time, event.velocity, destination, channel?.sampleTrim);
    } else if (channel?.sampleId) {
      // The channel's sample is assigned but its buffer is not loaded: stay silent and let the UI report it.
      return null;
    } else {
      parts = createDrumParts(graph, event.sampleId, time, event.velocity, destination);
    }
  } else if (event.kind === 'note') {
    parts = buildSynthNote(graph.context, channel?.synth ?? DEFAULT_SYNTH_PARAMS, event.pitch, time, timing.durationSeconds, event.velocity, destination);
  } else if (event.kind === 'audio' && buffer) {
    parts = createAudioClipParts(graph, buffer, time, timing.durationSeconds, timing.sourceOffsetSeconds ?? event.sourceOffsetSeconds, event.velocity, destination);
  } else {
    parts = null;
  }

  if (!parts) return null;

  if (timing.stopTime !== undefined && timing.stopTime < parts.endTime) {
    parts.endTime = Math.max(time, timing.stopTime);
    const fadeAt = Math.max(time, parts.endTime - VOICE_RELEASE_SECONDS);
    for (const gain of parts.gains) {
      gain.gain.cancelScheduledValues(fadeAt);
      gain.gain.setValueAtTime(Math.max(SILENCE, gain.gain.value), fadeAt);
      gain.gain.exponentialRampToValueAtTime(SILENCE, parts.endTime);
    }
  }
  const voice = new WebAudioVoice(
    `${event.id}:${timing.iteration}`,
    event.channelId,
    event.kind,
    time,
    parts.endTime,
    graph.context,
    parts.sources,
    parts.gains,
    onEnded,
  );
  // Web Audio requires start() before stop(). Scheduling the stop while each voice is built
  // (before start() has been called) throws InvalidStateError in browsers such as Safari.
  const startedSources: AudioScheduledSourceNode[] = [];
  try {
    for (const source of parts.sources) {
      if (parts.start) {
        (source as AudioBufferSourceNode).start(time, parts.start.offset, parts.start.duration);
      } else {
        source.start(time);
      }
      startedSources.push(source);
    }
    for (const source of parts.sources) source.stop(parts.endTime);
  } catch (error) {
    for (const source of startedSources) {
      try {
        source.stop(graph.context.currentTime);
      } catch {
        /* source already stopped */
      }
    }
    voice.dispose();
    throw error;
  }
  return voice;
}

/**
 * Pool of sounding voices. Owned by the engine so a stop, seek, or tempo change can cut
 * everything that is scheduled or sounding.
 *
 * Voices leave the pool when their sources end, and also when their end time has passed (a
 * sweep), so a source that never reports `ended` cannot leak. Limits are enforced by stealing.
 */
export class VoicePool {
  private readonly voices = new Set<Voice>();
  /** Voices released by stealing; they keep their own short fade but no longer count. */
  private stolen = 0;

  constructor(
    private readonly graph: AudioGraph,
    private readonly onError?: (error: unknown) => void,
    private readonly resolveSample?: SampleResolver,
    private readonly resolveChannel?: ChannelResolver,
    private readonly limits: { maxVoices: number; maxVoicesPerChannel: number } = {
      maxVoices: MAX_ACTIVE_VOICES,
      maxVoicesPerChannel: MAX_VOICES_PER_CHANNEL,
    },
  ) {}

  get activeCount(): number {
    this.sweep();
    return this.voices.size;
  }

  /** Voices stolen since creation; used by tests and diagnostics. */
  get stealCount(): number {
    return this.stolen;
  }

  /** Start times of every tracked voice — used by tests and diagnostics. */
  getStartTimes(): number[] {
    this.sweep();
    return [...this.voices].map((voice) => voice.startTime).sort((a, b) => a - b);
  }

  schedule(timing: ScheduledEventTiming): void {
    try {
      this.sweep();
      this.makeRoom(timing.event.channelId);
      const voice = createVoice(
        timing,
        this.graph,
        (ended) => {
          this.voices.delete(ended);
        },
        this.resolveSample,
        this.resolveChannel,
      );
      if (voice) this.voices.add(voice);
    } catch (error) {
      this.onError?.(error);
    }
  }

  /** Drop queued voices that have not started sounding yet. */
  cancelPendingFrom(time: number): void {
    for (const voice of [...this.voices]) {
      if (voice.startTime >= time) voice.cancel();
    }
    this.sweep();
  }

  /** Cut everything sounding at `atTime`. */
  releaseAll(atTime: number): void {
    for (const voice of [...this.voices]) {
      if (voice.startTime >= atTime) voice.cancel();
      else if (voice.endTime > atTime) voice.stop(atTime);
    }
  }

  clear(): void {
    this.releaseAll(this.graph.context.currentTime);
    for (const voice of [...this.voices]) voice.dispose();
    this.voices.clear();
  }

  /** Forget voices whose end time has passed, whether or not their `ended` event arrived. */
  private sweep(): void {
    const now = this.graph.context.currentTime;
    for (const voice of [...this.voices]) {
      if (voice.endTime <= now) {
        voice.dispose();
        this.voices.delete(voice);
      }
    }
  }

  /**
   * Make room for one more voice on `channelId`: first within the channel's own limit, then
   * globally. The victim is the oldest voice by start time; ties keep insertion order.
   */
  private makeRoom(channelId: string): void {
    const sameChannel = [...this.voices].filter((voice) => voice.channelId === channelId);
    if (sameChannel.length >= this.limits.maxVoicesPerChannel) this.steal(oldest(sameChannel));
    if (this.voices.size >= this.limits.maxVoices) this.steal(oldest([...this.voices]));
  }

  private steal(victim: Voice | undefined): void {
    if (!victim) return;
    victim.cancel();
    this.voices.delete(victim);
    this.stolen += 1;
  }
}

function oldest(voices: Voice[]): Voice | undefined {
  let best: Voice | undefined;
  for (const voice of voices) {
    if (!best || voice.startTime < best.startTime) best = voice;
  }
  return best;
}

function createDrumParts(
  graph: AudioGraph,
  sampleId: string,
  time: number,
  velocity: number,
  destination: AudioNode,
): VoiceParts {
  switch (resolveDrumVoice(sampleId)) {
    case 'kick':
      return createKick(graph, time, velocity, destination);
    case 'snare':
      return createSnare(graph, time, velocity, destination);
    case 'hat':
      return createHat(graph, time, velocity, destination);
    default:
      return createPerc(graph, time, velocity, destination);
  }
}

/**
 * One-shot playback of a decoded sample buffer, shaped by the step velocity, the channel's gain,
 * and its start/end region. The region is applied as the buffer playback window, so trimming never
 * copies or re-decodes audio.
 */
function createSampleParts(
  graph: AudioGraph,
  buffer: AudioBuffer,
  time: number,
  velocity: number,
  destination: AudioNode,
  trim?: SampleTrim,
): VoiceParts {
  const context = graph.context;
  const source = context.createBufferSource();
  const gain = context.createGain();
  const offset = trim ? Math.min(Math.max(0, trim.startSeconds), buffer.duration) : 0;
  const regionEnd = trim ? Math.min(trim.endSeconds, buffer.duration) : buffer.duration;
  const duration = Math.max(0.005, regionEnd - offset);
  const sampleGain = trim ? Math.min(2, Math.max(0, trim.gain)) : 1;
  const peak = Math.max(SILENCE * 2, Math.min(2, velocity * sampleGain));
  const endTime = time + duration;
  const release = Math.min(0.012, duration / 2);

  source.buffer = buffer;
  gain.gain.setValueAtTime(SILENCE, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + Math.min(0.003, duration / 4));
  gain.gain.setValueAtTime(peak, endTime - release);
  gain.gain.exponentialRampToValueAtTime(SILENCE, endTime);

  source.connect(gain);
  gain.connect(destination);
  return { sources: [source], gains: [gain], endTime, start: { offset, duration } };
}

/** Trimmed native-speed asset playback. Unlike a drum trigger, a missing asset is silent. */
function createAudioClipParts(
  graph: AudioGraph, buffer: AudioBuffer, time: number, durationSeconds: number,
  offsetSeconds: number, velocity: number, destination: AudioNode,
): VoiceParts | null {
  const duration = Math.min(durationSeconds, buffer.duration - offsetSeconds);
  if (duration <= 0 || offsetSeconds < 0) return null;
  const source = graph.context.createBufferSource();
  const gain = graph.context.createGain();
  const endTime = time + duration;
  const peak = Math.max(SILENCE, Math.min(2, velocity));
  const fade = Math.min(0.004, duration / 3);
  source.buffer = buffer;
  gain.gain.setValueAtTime(SILENCE, time);
  gain.gain.linearRampToValueAtTime(peak, time + fade);
  gain.gain.setValueAtTime(peak, endTime - fade);
  gain.gain.linearRampToValueAtTime(SILENCE, endTime);
  source.connect(gain);
  gain.connect(destination);
  return { sources: [source], gains: [gain], endTime, start: { offset: offsetSeconds, duration } };
}

function createKick(graph: AudioGraph, time: number, velocity: number, destination: AudioNode): VoiceParts {
  const context = graph.context;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const peak = Math.max(SILENCE * 2, velocity);

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(165, time);
  oscillator.frequency.exponentialRampToValueAtTime(46, time + 0.085);

  gain.gain.setValueAtTime(SILENCE, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.004);
  gain.gain.exponentialRampToValueAtTime(SILENCE, time + 0.32);

  oscillator.connect(gain);
  gain.connect(destination);
  const endTime = time + 0.34;
  return { sources: [oscillator], gains: [gain], endTime };
}

function createSnare(graph: AudioGraph, time: number, velocity: number, destination: AudioNode): VoiceParts {
  const context = graph.context;
  const peak = Math.max(SILENCE * 2, velocity);

  const noise = context.createBufferSource();
  noise.buffer = graph.getNoiseBuffer();
  const noiseBand = context.createBiquadFilter();
  noiseBand.type = 'bandpass';
  noiseBand.frequency.value = 1750;
  noiseBand.Q.value = 0.7;
  const noiseGain = context.createGain();
  noiseGain.gain.setValueAtTime(SILENCE, time);
  noiseGain.gain.exponentialRampToValueAtTime(peak * 0.8, time + 0.002);
  noiseGain.gain.exponentialRampToValueAtTime(SILENCE, time + 0.16);
  noise.connect(noiseBand);
  noiseBand.connect(noiseGain);
  noiseGain.connect(destination);

  const body = context.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(190, time);
  body.frequency.exponentialRampToValueAtTime(140, time + 0.09);
  const bodyGain = context.createGain();
  bodyGain.gain.setValueAtTime(SILENCE, time);
  bodyGain.gain.exponentialRampToValueAtTime(peak * 0.5, time + 0.003);
  bodyGain.gain.exponentialRampToValueAtTime(SILENCE, time + 0.1);
  body.connect(bodyGain);
  bodyGain.connect(destination);

  return { sources: [noise, body], gains: [noiseGain, bodyGain], endTime: time + 0.2 };
}

function createHat(graph: AudioGraph, time: number, velocity: number, destination: AudioNode): VoiceParts {
  const context = graph.context;
  const peak = Math.max(SILENCE * 2, velocity * 0.55);

  const noise = context.createBufferSource();
  noise.buffer = graph.getNoiseBuffer();
  const highpass = context.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 7000;
  const band = context.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 11000;
  band.Q.value = 0.9;
  const gain = context.createGain();
  gain.gain.setValueAtTime(SILENCE, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.001);
  gain.gain.exponentialRampToValueAtTime(SILENCE, time + 0.05);

  noise.connect(highpass);
  highpass.connect(band);
  band.connect(gain);
  gain.connect(destination);
  const endTime = time + 0.07;
  return { sources: [noise], gains: [gain], endTime };
}

function createPerc(graph: AudioGraph, time: number, velocity: number, destination: AudioNode): VoiceParts {
  const context = graph.context;
  const peak = Math.max(SILENCE * 2, velocity * 0.6);
  const oscillator = context.createOscillator();
  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(330, time);
  oscillator.frequency.exponentialRampToValueAtTime(180, time + 0.08);
  const gain = context.createGain();
  gain.gain.setValueAtTime(SILENCE, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.003);
  gain.gain.exponentialRampToValueAtTime(SILENCE, time + 0.13);
  oscillator.connect(gain);
  gain.connect(destination);
  const endTime = time + 0.15;
  return { sources: [oscillator], gains: [gain], endTime };
}
