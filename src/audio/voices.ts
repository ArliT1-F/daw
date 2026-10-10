import type { ScheduledEventTiming } from '../core/events/musicalEvents';
import type { AudioGraph } from './AudioGraph';

/**
 * Voices: the only place that creates Web Audio nodes for a musical event.
 *
 * The starter kit synthesises its drum and synth voices (there are no sample assets yet). A real
 * sampler would add a case here; the event interface stays the same, so nothing upstream changes.
 */

/** Short fade applied when a voice is cut, avoiding clicks on stop/seek. */
export const VOICE_RELEASE_SECONDS = 0.008;
const SILENCE = 0.0001;

export interface Voice {
  readonly id: string;
  readonly channelId: string;
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
}

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

/** Build and start a voice for a scheduled event. Returns null for unsupported event kinds. */
export function createVoice(
  timing: ScheduledEventTiming,
  graph: AudioGraph,
  onEnded: (voice: Voice) => void,
  resolveSample?: SampleResolver,
): Voice | null {
  const { event, time } = timing;
  if (event.velocity <= 0) return null;
  const destination = graph.getChannelBus(event.channelId);
  const buffer = event.kind === 'sample' ? resolveSample?.(event.sampleId) : event.kind === 'audio' ? resolveSample?.(event.assetId) : null;
  const parts =
    event.kind === 'sample'
      ? buffer
        ? createSampleParts(graph, buffer, time, event.velocity, destination)
        : createDrumParts(graph, event.sampleId, time, event.velocity, destination)
      : event.kind === 'note'
        ? createSynthParts(graph, event.pitch, time, timing.durationSeconds, event.velocity, destination)
        : event.kind === 'audio' && buffer
          ? createAudioClipParts(graph, buffer, time, timing.durationSeconds, timing.sourceOffsetSeconds ?? event.sourceOffsetSeconds, event.velocity, destination)
          : null;

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
      if (event.kind === 'audio') {
        (source as AudioBufferSourceNode).start(time, timing.sourceOffsetSeconds ?? event.sourceOffsetSeconds, Math.max(0, parts.endTime - time));
      } else {
        source.start(time);
      }
      startedSources.push(source);
    }
    for (const source of parts.sources) source.stop(parts.endTime);
  } catch (error) {
    // A partial start must not leave a source playing if another node fails to start/schedule.
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
 */
export class VoicePool {
  private readonly voices = new Set<Voice>();

  constructor(
    private readonly graph: AudioGraph,
    private readonly onError?: (error: unknown) => void,
    private readonly resolveSample?: SampleResolver,
  ) {}

  get activeCount(): number {
    return this.voices.size;
  }

  /** Start times of every tracked voice — used by tests and diagnostics. */
  getStartTimes(): number[] {
    return [...this.voices].map((voice) => voice.startTime).sort((a, b) => a - b);
  }

  schedule(timing: ScheduledEventTiming): void {
    try {
      const voice = createVoice(
        timing,
        this.graph,
        (ended) => {
          this.voices.delete(ended);
        },
        this.resolveSample,
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

/** One-shot playback of a decoded sample buffer, shaped by the step velocity. */
function createSampleParts(
  graph: AudioGraph,
  buffer: AudioBuffer,
  time: number,
  velocity: number,
  destination: AudioNode,
): VoiceParts {
  const context = graph.context;
  const source = context.createBufferSource();
  const gain = context.createGain();
  const peak = Math.max(SILENCE * 2, Math.min(1, velocity));
  const duration = Math.max(0.02, buffer.duration);
  const endTime = time + duration;
  const release = Math.min(0.012, duration / 2);

  source.buffer = buffer;
  gain.gain.setValueAtTime(SILENCE, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + Math.min(0.003, duration / 4));
  gain.gain.setValueAtTime(peak, endTime - release);
  gain.gain.exponentialRampToValueAtTime(SILENCE, endTime);

  source.connect(gain);
  gain.connect(destination);
  return { sources: [source], gains: [gain], endTime };
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
  return { sources: [source], gains: [gain], endTime };
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

function createSynthParts(
  graph: AudioGraph,
  pitch: number,
  time: number,
  durationSeconds: number,
  velocity: number,
  destination: AudioNode,
): VoiceParts {
  const context = graph.context;
  const frequency = midiToFrequency(pitch);
  const peak = Math.max(SILENCE * 2, velocity * 0.35);
  const hold = Math.max(0.0001, durationSeconds);
  const noteEnd = time + hold;
  const attack = Math.min(0.01, Math.max(0.0001, hold * 0.2));
  const release = 0.06;
  const sustainLevel = Math.max(SILENCE * 2, peak * 0.7);

  const gain = context.createGain();
  gain.gain.setValueAtTime(SILENCE, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + attack);
  gain.gain.exponentialRampToValueAtTime(sustainLevel, time + Math.min(hold, attack + 0.12));
  gain.gain.setValueAtTime(sustainLevel, noteEnd);
  gain.gain.exponentialRampToValueAtTime(SILENCE, noteEnd + release);

  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.9;
  filter.frequency.setValueAtTime(Math.min(6000, frequency * 4 + 400), time);
  filter.frequency.exponentialRampToValueAtTime(Math.max(400, frequency * 8 + 800), time + attack);
  filter.frequency.exponentialRampToValueAtTime(Math.max(300, frequency * 2 + 300), noteEnd + release);

  const sawA = context.createOscillator();
  sawA.type = 'sawtooth';
  sawA.frequency.value = frequency;
  sawA.detune.value = -7;
  const sawB = context.createOscillator();
  sawB.type = 'sawtooth';
  sawB.frequency.value = frequency;
  sawB.detune.value = 7;
  const sub = context.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = frequency / 2;
  const subGain = context.createGain();
  subGain.gain.value = 0.5;

  sawA.connect(filter);
  sawB.connect(filter);
  sub.connect(subGain);
  subGain.connect(filter);
  filter.connect(gain);
  gain.connect(destination);

  const endTime = noteEnd + release + 0.02;
  return { sources: [sawA, sawB, sub], gains: [gain], endTime };
}
