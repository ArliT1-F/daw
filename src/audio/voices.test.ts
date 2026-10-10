import { describe, expect, it } from 'vitest';
import { AudioGraph } from './AudioGraph';
import { DEFAULT_SYNTH_PARAMS } from '../core/instruments/synthModel';
import { FakeAudioBuffer, createFakeAudioContext } from './__fixtures__/fakeAudioContext';
import { VOICE_RELEASE_SECONDS, VoicePool, createVoice, midiToFrequency, resolveDrumVoice, type SampleResolver } from './voices';
import type { ScheduledEventTiming } from '../core/events/musicalEvents';

function createPool() {
  const { context, fake } = createFakeAudioContext({ startRunning: true });
  const graph = new AudioGraph(context);
  const errors: unknown[] = [];
  const pool = new VoicePool(graph, (error) => errors.push(error));
  return { context, fake, graph, pool, errors };
}

function timing(event: ScheduledEventTiming['event'], time: number, durationSeconds = 0): ScheduledEventTiming {
  return { event, time, durationSeconds, iteration: 0 };
}

const kick: ScheduledEventTiming['event'] = {
  kind: 'sample',
  id: 'kick-0',
  step: 0,
  channelId: 'channel-kick',
  sampleId: 'channel-kick',
  velocity: 0.9,
};

const note: ScheduledEventTiming['event'] = {
  kind: 'note',
  id: 'note-0',
  step: 0,
  channelId: 'channel-bass',
  pitch: 60,
  velocity: 0.8,
  durationSteps: 4,
};

describe('voice building blocks', () => {
  it('resolves sample ids to built-in drum voices', () => {
    expect(resolveDrumVoice('channel-kick')).toBe('kick');
    expect(resolveDrumVoice('Snare 01')).toBe('snare');
    expect(resolveDrumVoice('closed-hat')).toBe('hat');
    expect(resolveDrumVoice('anything-else')).toBe('perc');
  });

  it('converts MIDI notes to frequencies', () => {
    expect(midiToFrequency(69)).toBeCloseTo(440, 9);
    expect(midiToFrequency(60)).toBeCloseTo(261.6256, 4);
    expect(midiToFrequency(81)).toBeCloseTo(880, 6);
  });
});

describe('voice creation', () => {
  it('builds a percussive voice that releases itself', () => {
    const { fake, graph } = createPool();
    const voice = createVoice(timing(kick, 1), graph, () => {});
    expect(voice).not.toBeNull();
    expect(voice?.startTime).toBe(1);
    expect(fake.oscillators).toHaveLength(1);
    expect(fake.oscillators[0].startedAt).toBe(1);
    expect(fake.oscillators[0].stopAt).toBeCloseTo(1.34, 6);
    expect(voice?.endTime).toBeCloseTo(1.34, 6);
  });

  it('builds a sustained synth voice with two detuned oscillators and a filter', () => {
    const { fake, graph } = createPool();
    const voice = createVoice(timing(note, 2, 0.5), graph, () => {});
    expect(fake.oscillators).toHaveLength(2);
    expect(fake.oscillators.map((node) => node.detune.value)).toEqual([-7, 7]);
    expect(fake.filters).toHaveLength(1);
    // 0.5 s of hold plus the default 0.3 s release plus a small guard.
    expect(voice?.endTime).toBeCloseTo(2 + 0.5 + 0.3 + 0.02, 6);
  });

  it('gives very short notes a usable envelope instead of an inverted one', () => {
    const { fake, graph } = createPool();
    const voice = createVoice(timing(note, 0, 0.001), graph, () => {});
    expect(voice?.endTime).toBeCloseTo(0.001 + 0.3 + 0.02, 9);
    const envelope = fake.gains.find((node) => node.gain.calls.length > 0);
    expect(envelope).toBeDefined();
    // Released 1 ms into a 10 ms attack: the level at note-off is a tenth of the attack peak.
    const peak = 0.8 * DEFAULT_SYNTH_PARAMS.level * 0.6 * 0.7;
    const noteOff = envelope!.gain.calls.find((call) => call.method === 'linearRampToValueAtTime' && Math.abs(call.time - 0.001) < 1e-9);
    expect(noteOff?.value).toBeCloseTo(peak * 0.1, 9);
    // Nothing is scheduled past the attack-level note-off except the release back to silence.
    expect(envelope!.gain.calls.at(-1)).toMatchObject({ method: 'linearRampToValueAtTime', value: 0 });
  });

  it('zero-velocity samples and notes create no audible or near-silent fallback voice', () => {
    const { fake, graph } = createPool();
    expect(createVoice(timing({ ...kick, velocity: 0 }, 0), graph, () => {})).toBeNull();
    expect(createVoice(timing({ ...note, velocity: 0 }, 0, 1), graph, () => {})).toBeNull();
    expect(fake.sources).toHaveLength(0);
  });

  it('returns null for unsupported event kinds', () => {
    const { graph } = createPool();
    const unknown = { ...kick, kind: 'midi' } as unknown as ScheduledEventTiming['event'];
    expect(createVoice(timing(unknown, 0), graph, () => {})).toBeNull();
  });
});

describe('sample-buffer voices', () => {
  const buffer = () => new FakeAudioBuffer(1, 4800, 48000); // 0.1 s

  it('plays a decoded sample buffer instead of the synthesized drum voice', () => {
    const { fake, graph } = createPool();
    const resolve: SampleResolver = (sampleId) => (sampleId === 'sample-kick' ? (buffer() as unknown as AudioBuffer) : null);
    const event = { ...kick, sampleId: 'sample-kick' };
    const voice = createVoice(timing(event, 1), graph, () => {}, resolve);

    expect(voice).not.toBeNull();
    expect(fake.oscillators).toHaveLength(0);
    expect(fake.bufferSources).toHaveLength(1);
    expect(fake.bufferSources[0].buffer).not.toBeNull();
    expect(fake.bufferSources[0].startedAt).toBe(1);
    // The buffer is 0.1 s long; the voice ends with it.
    expect(voice?.endTime).toBeCloseTo(1.1, 6);
  });

  it('falls back to the built-in drum voice when no buffer is loaded', () => {
    const { fake, graph } = createPool();
    const resolve: SampleResolver = () => null;
    const voice = createVoice(timing(kick, 1), graph, () => {}, resolve);

    expect(voice).not.toBeNull();
    expect(fake.oscillators).toHaveLength(1);
    expect(fake.bufferSources).toHaveLength(0);
  });

  it('passes the resolver through the voice pool', () => {
    const { fake, graph } = createPool();
    const resolve: SampleResolver = () => buffer() as unknown as AudioBuffer;
    const pool = new VoicePool(graph, undefined, resolve);
    pool.schedule(timing({ ...kick, sampleId: 'anything' }, 2));
    expect(fake.bufferSources).toHaveLength(1);
    expect(fake.bufferSources[0].startedAt).toBe(2);
    expect(fake.oscillators).toHaveLength(0);
  });
});

describe('voice pool', () => {
  it('tracks voices until they end, then forgets them', () => {
    const { fake, pool } = createPool();
    pool.schedule(timing(kick, 1));
    expect(pool.activeCount).toBe(1);
    expect(pool.getStartTimes()).toEqual([1]);

    fake.advanceTo(1.5);
    expect(pool.activeCount).toBe(0);
  });

  it('cancels only voices that have not started yet', () => {
    const { fake, pool } = createPool();
    pool.schedule(timing(kick, 1));
    pool.schedule(timing(kick, 3));
    expect(pool.activeCount).toBe(2);

    pool.cancelPendingFrom(2);
    // The future source is stopped before its start, not left sounding for an 8 ms fade.
    expect(fake.oscillators[1].stopAt).toBeLessThan(fake.oscillators[1].startedAt!);
    expect(fake.oscillators[0].stopAt).toBeCloseTo(1.34, 6);
  });

  it('releases everything sounding at a time', () => {
    const { fake, pool } = createPool();
    pool.schedule(timing(kick, 1));
    pool.schedule(timing(note, 1.1, 2));
    pool.releaseAll(1.2);
    for (const source of fake.oscillators) {
      expect(source.stopAt).toBeLessThanOrEqual(1.2 + VOICE_RELEASE_SECONDS + 1e-9);
    }
    fake.advanceTo(1.3);
    expect(pool.activeCount).toBe(0);
    expect(fake.getSoundingSources(1.3)).toHaveLength(0);
  });

  it('reports scheduling failures instead of throwing', () => {
    const { context, fake, graph } = createPool();
    const errors: unknown[] = [];
    const pool = new VoicePool(graph, (error) => errors.push(error));
    fake.createOscillator = () => {
      throw new Error('Node allocation failed.');
    };
    void context;
    expect(() => pool.schedule(timing(kick, 1))).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(pool.activeCount).toBe(0);
  });

  it('clears every voice on demand', () => {
    const { pool } = createPool();
    pool.schedule(timing(kick, 1));
    pool.schedule(timing(kick, 2));
    pool.clear();
    expect(pool.activeCount).toBe(0);
  });
});

describe('voice cut behaviour', () => {
  it('fades the envelope instead of cutting abruptly', () => {
    const { fake, graph } = createPool();
    const voice = createVoice(timing(note, 1, 2), graph, () => {});
    voice?.stop(1.5);
    const envelope = fake.gains.find((node) =>
      node.gain.calls.some((call) => call.method === 'cancelScheduledValues'),
    );
    const cancelCall = envelope?.gain.calls.find((call) => call.method === 'cancelScheduledValues');
    expect(cancelCall?.time).toBeCloseTo(1.5, 6);
    expect(voice?.endTime).toBeCloseTo(1.5 + VOICE_RELEASE_SECONDS, 6);
    for (const source of fake.oscillators) {
      expect(source.stopAt).toBeCloseTo(1.5 + VOICE_RELEASE_SECONDS, 6);
    }
  });

  it('ignores stop after the voice has finished', () => {
    const { fake, graph } = createPool();
    const voice = createVoice(timing(kick, 1), graph, () => {});
    fake.advanceTo(2);
    expect(() => voice?.stop(1.5)).not.toThrow();
    expect(voice?.endTime).toBeCloseTo(1.34, 6);
  });
});
