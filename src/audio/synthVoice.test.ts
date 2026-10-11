import { describe, expect, it } from 'vitest';
import { AudioGraph } from './AudioGraph';
import { buildEnvelopePoints, buildSynthNote, oscillatorDetuneOffsets, synthDetuneCents, synthFrequency } from './synthVoice';
import { VoicePool, createVoice } from './voices';
import { createFakeAudioContext } from './__fixtures__/fakeAudioContext';
import { DEFAULT_SYNTH_PARAMS, SYNTH_WAVEFORMS, type SynthParams } from '../core/instruments/synthModel';
import type { ScheduledEventTiming } from '../core/events/musicalEvents';

function setup() {
  const { context, fake } = createFakeAudioContext({ startRunning: true });
  const graph = new AudioGraph(context);
  return { context, fake, graph };
}

function noteTiming(pitch: number, time: number, holdSeconds: number, channelId = 'lead'): ScheduledEventTiming {
  return {
    event: { kind: 'note', id: `note-${pitch}-${time}`, step: 0, channelId, pitch, velocity: 0.8, durationSteps: 4 },
    time,
    durationSeconds: holdSeconds,
    iteration: 0,
  };
}

function params(overrides: Partial<SynthParams> = {}): SynthParams {
  return { ...DEFAULT_SYNTH_PARAMS, ...overrides };
}

describe('pitch', () => {
  it('maps MIDI pitch to frequency relative to the tuning reference', () => {
    expect(synthFrequency(69, 440)).toBeCloseTo(440, 9);
    expect(synthFrequency(81, 440)).toBeCloseTo(880, 9);
    expect(synthFrequency(69, 432)).toBeCloseTo(432, 9);
    expect(synthFrequency(60, 440)).toBeCloseTo(261.6256, 3);
  });

  it('applies octave, semitone, and fine tune as oscillator detune in cents', () => {
    expect(synthDetuneCents(params({ octave: 1, semitone: -3, fineCents: 25 }))).toBe(1200 - 300 + 25);
  });

  it('plays the note pitch through every oscillator, with the patch detune on top', () => {
    const { fake, graph } = setup();
    buildSynthNote(graph.context, params({ spreadCents: 0, octave: -1, semitone: 2, fineCents: 10 }), 72, 0, 0.5, 0.8, graph.getChannelBus('lead'));
    const [osc] = fake.oscillators;
    expect(osc.frequency.value).toBeCloseTo(synthFrequency(72, 440), 9);
    expect(osc.detune.value).toBe(-1200 + 200 + 10);
  });

  it('uses the tuning setting for the reference pitch', () => {
    const { fake, graph } = setup();
    buildSynthNote(graph.context, params({ tuningHz: 430, spreadCents: 0 }), 69, 0, 0.5, 0.8, graph.getChannelBus('lead'));
    expect(fake.oscillators[0].frequency.value).toBeCloseTo(430, 9);
  });
});

describe('oscillators and waveform', () => {
  it('uses one oscillator without spread, and two detuned oscillators with spread', () => {
    expect(oscillatorDetuneOffsets(0)).toEqual([0]);
    expect(oscillatorDetuneOffsets(7)).toEqual([-7, 7]);
  });

  it('applies every selectable waveform to the oscillators', () => {
    for (const waveform of SYNTH_WAVEFORMS) {
      const { fake, graph } = setup();
      buildSynthNote(graph.context, params({ waveform }), 60, 0, 0.2, 0.8, graph.getChannelBus('lead'));
      expect(fake.oscillators.every((osc) => osc.type === waveform)).toBe(true);
    }
  });
});

describe('ADSR envelope breakpoints', () => {
  const p = params({ attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.4 });

  it('ramps through attack, decay, and sustain, then releases to silence', () => {
    const points = buildEnvelopePoints(p, 1, 1);
    expect(points.map((point) => point.time)).toEqual([0, 0.1, 0.3, 1, 1.4].map((t) => expect.closeTo(t, 9)));
    expect(points.map((point) => point.value)).toEqual([0, 1, 0.5, 0.5, 0]);
  });

  it('interpolates when note-off falls inside the decay', () => {
    const points = buildEnvelopePoints(p, 0.2, 1);
    // Attack is 0.1 s; 0.2 s is halfway through the decay, so the level is halfway from 1 to 0.5.
    expect(points[2].time).toBeCloseTo(0.2, 9);
    expect(points[2].value).toBeCloseTo(0.75, 9);
    expect(points.at(-1)!.time).toBeCloseTo(0.6, 9);
    expect(points.at(-1)!.value).toBe(0);
  });

  it('ramps up to the level reached when note-off lands inside the attack', () => {
    const points = buildEnvelopePoints(p, 0.05, 1);
    expect(points[1]).toEqual({ time: 0.05, value: 0.5 });
  });

  it('clamps attack and release to their minimums so the curve never inverts', () => {
    const points = buildEnvelopePoints(params({ attack: 0, release: 0 }), 0.5, 1);
    expect(points.every((point, index) => index === 0 || point.time >= points[index - 1].time)).toBe(true);
  });

  it('writes the envelope to the gain node in order', () => {
    const { fake, graph } = setup();
    buildSynthNote(graph.context, p, 60, 2, 1, 1, graph.getChannelBus('lead'));
    const gain = fake.gains.find((node) => node.gain.calls.length > 0)!;
    const times = gain.gain.calls.map((call) => call.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(gain.gain.calls.at(-1)).toMatchObject({ method: 'linearRampToValueAtTime', value: 0 });
  });
});

describe('note on and off', () => {
  it('holds the note for its duration, then releases it over the release time', () => {
    const { fake, graph } = setup();
    const pool = new VoicePool(graph, undefined, undefined, () => ({ synth: params({ release: 0.5 }) }));
    pool.schedule(noteTiming(60, 1, 0.25));
    const voice = pool.getStartTimes();
    expect(voice).toEqual([1]);
    const osc = fake.oscillators[0];
    expect(osc.startedAt).toBe(1);
    // Note-off at 1.25 s, release to silence at 1.75 s, guard afterwards.
    expect(osc.stopAt).toBeCloseTo(1.75 + 0.02, 6);
    const envelope = fake.gains.find((node) => node.gain.calls.length > 0)!;
    // Peak = velocity × level × 0.6 × 0.7 (two oscillators); the sustain level is peak × sustain.
    const peak = 0.8 * DEFAULT_SYNTH_PARAMS.level * 0.6 * 0.7;
    const noteOff = envelope.gain.calls.find((call) => Math.abs(call.time - 1.25) < 1e-9);
    expect(noteOff?.value).toBeCloseTo(peak * DEFAULT_SYNTH_PARAMS.sustain, 6);
  });

  it('an early cut shortens the voice and fades it, without leaving a sounding oscillator', () => {
    const { fake, graph } = setup();
    const pool = new VoicePool(graph);
    pool.schedule(noteTiming(60, 0, 2));
    pool.releaseAll(0.5);
    fake.advanceTo(1);
    expect(pool.activeCount).toBe(0);
    expect(fake.getSoundingSources(1)).toHaveLength(0);
  });

  it('a zero-velocity note creates no voice', () => {
    const { fake, graph } = setup();
    const timing = { ...noteTiming(60, 0, 1), event: { ...noteTiming(60, 0, 1).event, velocity: 0 } } as ScheduledEventTiming;
    expect(createVoice(timing, graph, () => {})).toBeNull();
    expect(fake.oscillators).toHaveLength(0);
  });
});

describe('polyphony', () => {
  it('plays several notes at once, each with its own oscillators and envelope', () => {
    const { fake, graph } = setup();
    const pool = new VoicePool(graph);
    for (const pitch of [60, 64, 67]) pool.schedule(noteTiming(pitch, 0, 1));
    expect(pool.activeCount).toBe(3);
    // Default patch: two detuned oscillators per note.
    expect(fake.oscillators).toHaveLength(6);
    expect(new Set(fake.oscillators.map((osc) => osc.frequency.value.toFixed(3))).size).toBe(3);
  });

  it('keeps notes from different channels separate', () => {
    const { fake, graph } = setup();
    const pool = new VoicePool(graph);
    pool.schedule(noteTiming(60, 0, 1, 'lead'));
    pool.schedule(noteTiming(60, 0, 1, 'pad'));
    expect(pool.activeCount).toBe(2);
    expect(fake.oscillators).toHaveLength(4);
  });
});
