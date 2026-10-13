/**
 * Offline rendering with real Web Audio nodes.
 *
 * `web-audio-api` is a pure-JavaScript implementation of the Web Audio API (dev dependency only). It
 * runs the same effect cores the browser runs, so these tests assert real audio: peaks, timing,
 * spectral gain, tails, determinism, and JSON round trips. Browser-only behaviour stays in the
 * Playwright specs.
 */
import { OfflineAudioContext as WebOfflineAudioContext } from 'web-audio-api';
import { describe, expect, it } from 'vitest';
import { defaultEffectParams, type EffectType } from '../core/effects/effectDefinitions';
import { buildMixerState, type MixerState } from '../core/mixer/mixerModel';
import { applyProjectCommand, type ProjectCommand } from '../core/commands';
import { createInitialProject, MASTER_MIXER_CHANNEL_ID, type MixerEffectSlot, type Project } from '../core/project/model';
import { deserializeProject, serializeProject } from '../core/project/serialization';
import { renderMixOffline, type OfflineRenderContext, type OfflineSourceClip } from './offlineRender';

const SAMPLE_RATE = 48000;
const MASTER = MASTER_MIXER_CHANNEL_ID;
const INSERT = 'mixer-insert-1';
const SOURCE = 'src-tone';

type RealContext = WebOfflineAudioContext & OfflineRenderContext;

function createRealContext(request: { channels: number; length: number; sampleRate: number }): RealContext {
  return new WebOfflineAudioContext(request.channels, request.length, request.sampleRate) as unknown as RealContext;
}

function fx(id: string, type: EffectType, overrides: Record<string, number> = {}, enabled = true): MixerEffectSlot {
  return { id, type, enabled, params: { ...defaultEffectParams(type), ...overrides } };
}

/** One source feeding one insert, with the given effect chains. */
function stateWith(insertEffects: MixerEffectSlot[], masterEffects: MixerEffectSlot[] = [], masterVolumeDb = 0): MixerState {
  return {
    masterChannelId: MASTER,
    channels: [
      { id: MASTER, role: 'master', volumeDb: masterVolumeDb, pan: 0, muted: false, solo: false, outputId: null, effects: masterEffects },
      { id: INSERT, role: 'insert', volumeDb: 0, pan: 0, muted: false, solo: false, outputId: MASTER, effects: insertEffects },
    ],
    sources: [{ id: SOURCE, kind: 'channel', mixerChannelId: INSERT }],
  };
}

/** Build a clip buffer with a generator. Uses a real context so the buffer is a real AudioBuffer. */
function makeClip(durationSeconds: number, sample: (time: number) => number): AudioBuffer {
  const context = new WebOfflineAudioContext(1, 1, SAMPLE_RATE);
  const length = Math.round(durationSeconds * SAMPLE_RATE);
  const buffer = context.createBuffer(1, length, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) data[index] = sample(index / SAMPLE_RATE);
  // The web-audio-api buffer is a structural match for the Web Audio interface; TypeScript sees two nominal types.
  return buffer as unknown as AudioBuffer;
}

function impulseClip(atSeconds: number, amplitude: number, durationSeconds: number): AudioBuffer {
  return makeClip(durationSeconds, (time) => (Math.abs(time - atSeconds) < 0.5 / SAMPLE_RATE ? amplitude : 0));
}

function sineClip(frequency: number, amplitude: number, durationSeconds: number): AudioBuffer {
  return makeClip(durationSeconds, (time) => amplitude * Math.sin(2 * Math.PI * frequency * time));
}

async function render(state: MixerState, clips: OfflineSourceClip[], durationSeconds: number, allowMissingEffects = false) {
  const result = await renderMixOffline({
    mixerState: state,
    sources: clips,
    durationSeconds,
    sampleRate: SAMPLE_RATE,
    createContext: createRealContext,
    allowMissingEffects,
  });
  return result;
}

function channel(buffer: AudioBuffer): Float32Array {
  return Float32Array.from(buffer.getChannelData(0));
}

function peak(samples: Float32Array, from = 0, to = samples.length): number {
  let max = 0;
  for (let index = from; index < to; index += 1) max = Math.max(max, Math.abs(samples[index]));
  return max;
}

function meanSquare(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += samples[index] * samples[index];
  return sum / Math.max(1, to - from);
}

function toDb(ratio: number): number {
  return 10 * Math.log10(ratio);
}

describe('offline render: limiter', () => {
  it('keeps the master peak at or below the ceiling, and the ceiling is below the safety stage', async () => {
    // The existing safety compressor starts at -6 dB, so a -12 dB ceiling is the one only this limiter enforces.
    const ceilingDb = -12;
    const clip = [{ sourceId: SOURCE, buffer: sineClip(1000, 1, 1), startSeconds: 0 }];
    const limited = await render(stateWith([], [fx('lim', 'limiter', { ceilingDb })]), clip, 1);
    expect(limited.warnings).toEqual([]);
    const ceiling = 10 ** (ceilingDb / 20);
    expect(peak(channel(limited.buffer))).toBeLessThanOrEqual(ceiling + 1e-3);
    // Without the limiter the same input is far above the ceiling, so the assertion above is meaningful.
    const unlimited = await render(stateWith([]), clip, 1);
    expect(peak(channel(unlimited.buffer))).toBeGreaterThan(ceiling + 0.2);
  });

  it('is transparent for a quiet signal well below the ceiling', async () => {
    const quiet = sineClip(440, 0.05, 0.5);
    const withLimiter = await render(stateWith([], [fx('lim', 'limiter', { ceilingDb: -1 })]), [{ sourceId: SOURCE, buffer: quiet, startSeconds: 0 }], 0.5);
    const without = await render(stateWith([]), [{ sourceId: SOURCE, buffer: quiet, startSeconds: 0 }], 0.5);
    const a = channel(withLimiter.buffer);
    const b = channel(without.buffer);
    // The limiter's native compressor is idle below threshold; the clip is also idle. Allow float noise only.
    const mid = (0.1 * SAMPLE_RATE) | 0;
    expect(Math.abs(peak(a, mid) - peak(b, mid))).toBeLessThan(1e-3);
  });
});

describe('offline render: delay', () => {
  it('places the echo at the configured time', async () => {
    const delayMs = 100;
    const state = stateWith([fx('dly', 'delay', { timeMs: delayMs, feedback: 0, toneHz: 18000, mix: 1 })]);
    const { buffer } = await render(state, [{ sourceId: SOURCE, buffer: impulseClip(0.1, 0.5, 0.5), startSeconds: 0 }], 0.5);
    const out = channel(buffer);
    // Dry is off (mix 1), so the only energy is the echo: its peak lands at 0.1 s + delay.
    let best = 0;
    for (let index = 0; index < out.length; index += 1) {
      if (Math.abs(out[index]) > Math.abs(out[best])) best = index;
    }
    const expected = (0.1 + delayMs / 1000) * SAMPLE_RATE;
    expect(Math.abs(best - expected)).toBeLessThanOrEqual(0.003 * SAMPLE_RATE);
    expect(Math.abs(out[best])).toBeGreaterThan(0.1);
  });
});

describe('offline render: EQ', () => {
  it('boosts a 1 kHz tone by the configured mid gain', async () => {
    const tone = sineClip(1000, 0.1, 1);
    const flat = await render(stateWith([]), [{ sourceId: SOURCE, buffer: tone, startSeconds: 0 }], 1);
    const boosted = await render(
      stateWith([fx('eq', 'eq3', { midFreqHz: 1000, midGainDb: 6, midQ: 1 })]),
      [{ sourceId: SOURCE, buffer: tone, startSeconds: 0 }],
      1,
    );
    const from = Math.round(0.3 * SAMPLE_RATE);
    const to = Math.round(0.9 * SAMPLE_RATE);
    // 10·log10 of a power ratio equals 20·log10 of the amplitude ratio, so this is the amplitude gain in dB.
    const gainDb = toDb(meanSquare(channel(boosted.buffer), from, to) / meanSquare(channel(flat.buffer), from, to));
    expect(Math.abs(gainDb - 6)).toBeLessThan(0.3);
  });
});

describe('offline render: reverb', () => {
  it('leaves a long tail that a short decay does not', async () => {
    const click = [{ sourceId: SOURCE, buffer: impulseClip(0.05, 0.8, 1.2), startSeconds: 0 }];
    const long = await render(stateWith([fx('rev', 'reverb', { decaySeconds: 2, preDelayMs: 0, toneHz: 18000, mix: 1 })]), click, 1.2);
    const short = await render(stateWith([fx('rev', 'reverb', { decaySeconds: 0.2, preDelayMs: 0, toneHz: 18000, mix: 1 })]), click, 1.2);
    const from = Math.round(0.5 * SAMPLE_RATE);
    const to = Math.round(1.0 * SAMPLE_RATE);
    const longTail = meanSquare(channel(long.buffer), from, to);
    const shortTail = meanSquare(channel(short.buffer), from, to);
    expect(longTail).toBeGreaterThan(0);
    expect(toDb(longTail / Math.max(shortTail, 1e-30))).toBeGreaterThan(20);
  });
});

describe('offline render: determinism and persistence', () => {
  it('renders identical samples for the same state', async () => {
    const state = stateWith([fx('rev', 'reverb'), fx('dly', 'delay')], [fx('lim', 'limiter')]);
    const clips = [{ sourceId: SOURCE, buffer: sineClip(220, 0.4, 0.4), startSeconds: 0 }];
    const first = channel((await render(state, clips, 0.6)).buffer);
    const second = channel((await render(state, clips, 0.6)).buffer);
    expect(second.length).toBe(first.length);
    expect(Array.from(second)).toEqual(Array.from(first));
  });

  it('renders the same audio after a JSON save and reload', async () => {
    let project: Project = createInitialProject();
    const commands: ProjectCommand[] = [
      { type: 'mixer.effect.add', channelId: INSERT, effectId: 'fx-eq', effectType: 'eq3' },
      { type: 'mixer.effect.param.set', channelId: INSERT, effectId: 'fx-eq', key: 'midGainDb', value: 4 },
      { type: 'mixer.effect.add', channelId: INSERT, effectId: 'fx-dly', effectType: 'delay' },
      { type: 'mixer.effect.param.set', channelId: INSERT, effectId: 'fx-dly', key: 'mix', value: 0.45 },
      { type: 'mixer.effect.add', channelId: MASTER, effectId: 'fx-lim', effectType: 'limiter' },
      { type: 'mixer.effect.param.set', channelId: MASTER, effectId: 'fx-lim', key: 'ceilingDb', value: -3 },
    ];
    for (const command of commands) project = applyProjectCommand(project, command);

    const clip = [{ sourceId: 'channel-kick', buffer: impulseClip(0.05, 0.9, 0.6), startSeconds: 0 }];
    const before = channel((await render(buildMixerState(project), clip, 0.6)).buffer);
    const reloaded = deserializeProject(serializeProject(project));
    const after = channel((await render(buildMixerState(reloaded), clip, 0.6)).buffer);
    expect(Array.from(after)).toEqual(Array.from(before));
  });
});

describe('offline render: refusal policy', () => {
  it('refuses to render when an effect cannot be built, unless the caller allows it', async () => {
    const broken: MixerEffectSlot = { id: 'bad', type: 'eq3', enabled: true, params: { lowGainDb: 99 } };
    const state = stateWith([broken]);
    const clips = [{ sourceId: SOURCE, buffer: sineClip(440, 0.2, 0.2), startSeconds: 0 }];
    await expect(render(state, clips, 0.2)).rejects.toThrow(/could not be built exactly/);
    const allowed = await render(state, clips, 0.2, true);
    expect(allowed.warnings.some((message) => message.includes('"bad"'))).toBe(true);
  });

  it('rejects a clip for a source that is not in the mixer state', async () => {
    await expect(render(stateWith([]), [{ sourceId: 'missing', buffer: sineClip(440, 0.2, 0.1), startSeconds: 0 }], 0.1)).rejects.toThrow(/not in the mixer state/);
  });
});
