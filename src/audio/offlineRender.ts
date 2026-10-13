/**
 * Offline mixdown of a mixer state.
 *
 * This runs the same `AudioGraph` the live engine uses, on an offline context, so the export's
 * effects are the live effects. Offline support is therefore complete for the built-in effect set
 * (EQ, reverb, delay, compressor, limiter): all are native nodes.
 *
 * Failure policy: an effect that cannot be built is never dropped from the render silently. The
 * render throws with the list of problems. The caller may pass `allowMissingEffects` to render
 * anyway, in which case those problems are returned in `warnings`.
 */

import { dbToLinear, type MixerState } from '../core/mixer/mixerModel';
import { AudioGraph, type MixerGraphStats } from './AudioGraph';

/** A buffer played into one mixer source (the `MixerSourceState.id` the voices use). */
export interface OfflineSourceClip {
  sourceId: string;
  buffer: AudioBuffer;
  /** Start time on the export timeline, in seconds. */
  startSeconds: number;
}

/** The part of an offline context the renderer uses. `OfflineAudioContext` satisfies it. */
export interface OfflineRenderContext extends BaseAudioContext {
  startRendering(): Promise<AudioBuffer>;
}

export interface OfflineRenderRequest {
  channels: number;
  length: number;
  sampleRate: number;
}

export interface OfflineRenderOptions {
  mixerState: MixerState;
  sources: readonly OfflineSourceClip[];
  durationSeconds: number;
  sampleRate: number;
  /** Number of output channels (default 2). */
  channels?: number;
  /** Builds the offline context, e.g. `(r) => new OfflineAudioContext(r.channels, r.length, r.sampleRate)`. */
  createContext: (request: OfflineRenderRequest) => OfflineRenderContext;
  /** Render even when some effects could not be built. Those effects are then absent from the output. */
  allowMissingEffects?: boolean;
}

export interface OfflineRenderResult {
  buffer: AudioBuffer;
  /** Effect problems that were allowed through (empty unless `allowMissingEffects` was set). */
  warnings: string[];
  stats: MixerGraphStats;
}

export const OFFLINE_MAX_SAMPLE_RATE = 192000;
export const OFFLINE_MIN_SAMPLE_RATE = 8000;

export async function renderMixOffline(options: OfflineRenderOptions): Promise<OfflineRenderResult> {
  const { mixerState, sources, durationSeconds, sampleRate } = options;
  const channels = options.channels ?? 2;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Offline render needs a positive duration.');
  }
  if (!Number.isFinite(sampleRate) || sampleRate < OFFLINE_MIN_SAMPLE_RATE || sampleRate > OFFLINE_MAX_SAMPLE_RATE) {
    throw new Error(`Offline render sample rate must be between ${OFFLINE_MIN_SAMPLE_RATE} and ${OFFLINE_MAX_SAMPLE_RATE} Hz.`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new Error('Offline render supports mono or stereo output.');
  }
  const sourceIds = new Set(mixerState.sources.map((source) => source.id));
  for (const clip of sources) {
    if (!sourceIds.has(clip.sourceId)) {
      throw new Error(`Offline clip references source "${clip.sourceId}", which is not in the mixer state.`);
    }
    if (!Number.isFinite(clip.startSeconds) || clip.startSeconds < 0) {
      throw new Error(`Offline clip for "${clip.sourceId}" needs a non-negative start time.`);
    }
  }

  const length = Math.ceil(durationSeconds * sampleRate);
  const context = options.createContext({ channels, length, sampleRate });

  // Start the master at the state's level, pan, and mute, so no automation runs from t=0.
  const master = mixerState.channels.find((channel) => channel.role === 'master') ?? null;
  const graph = new AudioGraph(context, {
    metering: false,
    masterGain: master ? dbToLinear(master.volumeDb) : undefined,
    masterPan: master?.pan,
    masterAudible: master ? !master.muted : undefined,
  });

  try {
    graph.syncMixer(mixerState);
    const problems = [...graph.getEffectWarnings(), ...graph.getRoutingWarnings()];
    if (problems.length > 0 && !options.allowMissingEffects) {
      throw new Error(`Offline render refused because the mix could not be built exactly: ${problems.join('; ')}`);
    }

    for (const clip of sources) {
      const strip = graph.getStrip(clip.sourceId);
      if (!strip) throw new Error(`No audio strip exists for source "${clip.sourceId}".`);
      const node = context.createBufferSource();
      node.buffer = clip.buffer;
      node.connect(strip.input);
      node.start(clip.startSeconds);
    }

    const buffer = await context.startRendering();
    return { buffer, warnings: problems, stats: graph.getMixerStats() };
  } finally {
    graph.dispose();
  }
}
