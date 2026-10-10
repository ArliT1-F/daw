import { describe, expect, it } from 'vitest';
import { AudioGraph } from './AudioGraph';
import { FakeAudioBuffer, createFakeAudioContext } from './__fixtures__/fakeAudioContext';
import { MAX_ACTIVE_VOICES, MAX_VOICES_PER_CHANNEL, VOICE_RELEASE_SECONDS, VoicePool, type ChannelResolver } from './voices';
import type { ScheduledEventTiming } from '../core/events/musicalEvents';
import { DEFAULT_SYNTH_PARAMS, type SynthParams } from '../core/instruments/synthModel';

function setup(limits?: { maxVoices: number; maxVoicesPerChannel: number }, resolveChannel?: ChannelResolver) {
  const { context, fake } = createFakeAudioContext({ startRunning: true });
  const graph = new AudioGraph(context);
  const errors: unknown[] = [];
  const pool = new VoicePool(graph, (error) => errors.push(error), undefined, resolveChannel, limits);
  return { context, fake, graph, pool, errors };
}

function kickOn(channelId: string, time: number): ScheduledEventTiming {
  return {
    event: { kind: 'sample', id: `${channelId}-${time}`, step: 0, channelId, sampleId: 'channel-kick', velocity: 0.9 },
    time,
    durationSeconds: 0,
    iteration: 0,
  };
}

function noteOn(channelId: string, time: number, holdSeconds = 2): ScheduledEventTiming {
  return {
    event: { kind: 'note', id: `${channelId}-note-${time}`, step: 0, channelId, pitch: 60, velocity: 0.8, durationSteps: 4 },
    time,
    durationSeconds: holdSeconds,
    iteration: 0,
  };
}

describe('voice caps', () => {
  it('uses the documented global and per-channel limits', () => {
    expect(MAX_ACTIVE_VOICES).toBe(96);
    expect(MAX_VOICES_PER_CHANNEL).toBe(16);
  });

  it('never tracks more than 96 voices and steals the oldest when full', () => {
    const { pool } = setup();
    // 100 channels, one voice each, all sounding at once. Start times are 1 ms apart.
    for (let index = 0; index < 100; index += 1) {
      pool.schedule(kickOn(`channel-${index}`, 0.001 * (index + 1)));
    }
    expect(pool.activeCount).toBe(96);
    expect(pool.stealCount).toBe(4);
    // The four oldest voices (start times 1..4 ms) were stolen; the newest 96 remain.
    const starts = pool.getStartTimes();
    expect(starts[0]).toBeCloseTo(0.005, 9);
    expect(starts.at(-1)).toBeCloseTo(0.1, 9);
  });

  it('limits one channel to 16 voices without touching other channels', () => {
    const { pool } = setup();
    for (let index = 0; index < 20; index += 1) {
      pool.schedule(noteOn('channel-bass', 0.01 * (index + 1)));
    }
    pool.schedule(noteOn('channel-lead', 0.5));
    expect(pool.activeCount).toBe(17);
    expect(pool.stealCount).toBe(4);
    const starts = pool.getStartTimes();
    // Bass keeps its 16 newest notes (starts 0.05..0.20); the lead voice is untouched.
    expect(starts[0]).toBeCloseTo(0.05, 9);
    expect(starts).toContainEqual(expect.closeTo(0.5, 9));
  });

  it('steals by start time, not by insertion order', () => {
    const { pool } = setup({ maxVoices: 3, maxVoicesPerChannel: 3 });
    pool.schedule(kickOn('a', 0.3));
    pool.schedule(kickOn('b', 0.1));
    pool.schedule(kickOn('c', 0.2));
    pool.schedule(kickOn('d', 0.4));
    // The voice starting at 0.1 is the oldest, even though it was inserted second.
    expect(pool.getStartTimes()).toEqual([0.2, 0.3, 0.4]);
  });

  it('cancels an unstarted stolen voice so it never sounds', () => {
    const { fake, pool } = setup({ maxVoices: 1, maxVoicesPerChannel: 1 });
    pool.schedule(kickOn('a', 5));
    pool.schedule(kickOn('b', 6));
    expect(pool.getStartTimes()).toEqual([6]);
    // The first voice had not started (currentTime is 0), so it is cancelled rather than faded.
    expect(fake.oscillators[0].stopAt).toBeLessThan(fake.oscillators[0].startedAt!);
  });

  it('gives a stolen started voice only the short cut fade', () => {
    const { fake, pool, context } = setup({ maxVoices: 1, maxVoicesPerChannel: 1 });
    pool.schedule(kickOn('a', 0));
    fake.advanceTo(0.01);
    pool.schedule(kickOn('b', 0.02));
    const victim = fake.oscillators[0];
    expect(victim.stopAt).not.toBeNull();
    expect(victim.stopAt!).toBeLessThanOrEqual(context.currentTime + VOICE_RELEASE_SECONDS + 1e-9);
  });
});

describe('voice cleanup', () => {
  it('sweeps voices past their end time even if the ended event never fires', () => {
    const { fake, pool } = setup();
    pool.schedule(noteOn('lead', 0, 1));
    expect(pool.activeCount).toBe(1);
    // Jump the clock without advancing the scheduler, so no ended callback runs.
    fake.currentTime = 10;
    expect(pool.activeCount).toBe(0);
  });

  it('removes voices as their sources end and disposes their nodes', () => {
    const { fake, pool } = setup();
    pool.schedule(kickOn('kick', 1));
    fake.advanceTo(1.5);
    expect(pool.activeCount).toBe(0);
    expect(fake.getSoundingSources(1.5)).toHaveLength(0);
  });

  it('clear() cuts everything, disposes it, and leaves nothing tracked', () => {
    const { fake, pool } = setup();
    for (let index = 0; index < 10; index += 1) pool.schedule(noteOn(`ch-${index}`, 0.01 * index, 4));
    pool.clear();
    expect(pool.activeCount).toBe(0);
    for (const source of fake.oscillators) expect(source.stopAt).not.toBeNull();
  });

  it('reports a voice that fails to build and keeps the pool consistent', () => {
    const { fake, pool, errors } = setup();
    fake.createOscillator = () => {
      throw new Error('out of nodes');
    };
    pool.schedule(noteOn('lead', 1));
    expect(errors).toHaveLength(1);
    expect(pool.activeCount).toBe(0);
  });
});

describe('synth edits and held notes', () => {
  it('a channel synth edit does not release notes that are already held', () => {
    let synth: SynthParams = { ...DEFAULT_SYNTH_PARAMS, waveform: 'sawtooth' };
    const { fake, pool } = setup(undefined, (channelId) => (channelId === 'lead' ? { synth } : null));
    pool.schedule(noteOn('lead', 0, 2));
    const heldOscillators = [...fake.oscillators];
    const heldStops = heldOscillators.map((source) => source.stopAt);

    // The registry now holds a different patch, as after a knob drag in the inspector.
    synth = { ...DEFAULT_SYNTH_PARAMS, waveform: 'square', release: 1 };
    fake.advanceTo(0.5);

    expect(pool.activeCount).toBe(1);
    expect(heldOscillators.map((source) => source.stopAt)).toEqual(heldStops);
    expect(heldOscillators.every((source) => source.stopAt === null || source.stopAt > 0.5)).toBe(true);
  });

  it('the next note after a synth edit uses the new patch', () => {
    let synth: SynthParams = { ...DEFAULT_SYNTH_PARAMS, waveform: 'sawtooth' };
    const { fake, pool } = setup(undefined, (channelId) => (channelId === 'lead' ? { synth } : null));
    pool.schedule(noteOn('lead', 0, 0.2));
    synth = { ...DEFAULT_SYNTH_PARAMS, waveform: 'square' };
    pool.schedule(noteOn('lead', 1, 0.2));
    expect(fake.oscillators.map((source) => source.type)).toEqual(['sawtooth', 'sawtooth', 'square', 'square']);
  });
});

describe('sample buffers are shared', () => {
  it('many voices of one decoded buffer reference it instead of copying it', () => {
    const { context, fake } = createFakeAudioContext({ startRunning: true });
    const graph = new AudioGraph(context);
    const buffer = new FakeAudioBuffer(1, 4800, 48000) as unknown as AudioBuffer;
    const pool = new VoicePool(graph, undefined, () => buffer);
    for (let index = 0; index < 5; index += 1) {
      pool.schedule({
        event: { kind: 'sample', id: `hit-${index}`, step: 0, channelId: `ch-${index}`, sampleId: 'buf', velocity: 0.9 },
        time: index * 0.01,
        durationSeconds: 0,
        iteration: 0,
      });
    }
    expect(fake.bufferSources).toHaveLength(5);
    expect(new Set(fake.bufferSources.map((source) => source.buffer)).size).toBe(1);
    expect(fake.bufferSources[0].buffer).toBe(buffer);
  });
});
