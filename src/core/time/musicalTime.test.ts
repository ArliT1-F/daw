import { describe, expect, it } from 'vitest';
import {
  barsToSteps,
  clampTempo,
  createTempoMap,
  createTempoMapFrom,
  formatMusicalPosition,
  musicalPositionToSteps,
  secondsAtStep,
  secondsBetweenSteps,
  secondsPerStep,
  secondsToSteps,
  stepAtSeconds,
  stepsPerBar,
  stepsPerBeat,
  stepsToMusicalPosition,
  stepsToSeconds,
  tempoAtStep,
} from './musicalTime';

const FOUR_FOUR = { numerator: 4, denominator: 4 };
const SIX_EIGHT = { numerator: 6, denominator: 8 };
const SEVEN_EIGHT = { numerator: 7, denominator: 8 };
const TWELVE_EIGHT = { numerator: 12, denominator: 8 };

describe('musical time grid', () => {
  it('derives the step grid from the time signature', () => {
    expect(stepsPerBeat(FOUR_FOUR)).toBe(4);
    expect(stepsPerBeat(SIX_EIGHT)).toBe(2);
    expect(stepsPerBeat(SEVEN_EIGHT)).toBe(2);
    expect(stepsPerBar(FOUR_FOUR)).toBe(16);
    expect(stepsPerBar(SIX_EIGHT)).toBe(12);
    expect(stepsPerBar(SEVEN_EIGHT)).toBe(14);
    expect(stepsPerBar(TWELVE_EIGHT)).toBe(24);
    expect(barsToSteps(2, SIX_EIGHT)).toBe(24);
  });

  it('converts steps to seconds at a constant tempo', () => {
    // 120 BPM in 4/4: a beat is 0.5 s, a sixteenth is 0.125 s.
    expect(secondsPerStep(120, FOUR_FOUR)).toBeCloseTo(0.125, 12);
    expect(stepsToSeconds(16, 120, FOUR_FOUR)).toBeCloseTo(2, 12);
    expect(secondsToSteps(2, 120, FOUR_FOUR)).toBeCloseTo(16, 12);
    // 6/8 at 120 BPM: two sixteenths per beat, so a bar is 3 s.
    expect(secondsPerStep(120, SIX_EIGHT)).toBeCloseTo(0.25, 12);
    expect(stepsToSeconds(12, 120, SIX_EIGHT)).toBeCloseTo(3, 12);
  });

  it('clamps tempo to the supported range', () => {
    expect(clampTempo(10)).toBe(20);
    expect(clampTempo(400)).toBe(300);
    expect(clampTempo(Number.NaN)).toBe(120);
  });
});

describe('tempo map', () => {
  it('normalizes, sorts, de-duplicates, and guarantees an entry at step 0', () => {
    const map = createTempoMapFrom([
      { step: 32, bpm: 90 },
      { step: 16, bpm: 60 },
      { step: 16, bpm: 140 }, // duplicate step: the first declaration wins
      { step: -4, bpm: 100 }, // clamped to step 0
    ]);
    expect(map).toEqual([
      { step: 0, bpm: 100 },
      { step: 16, bpm: 60 },
      { step: 32, bpm: 90 },
    ]);
    expect(createTempoMapFrom([])).toEqual([{ step: 0, bpm: 120 }]);
  });

  it('clamps out-of-range tempo values instead of rejecting the map', () => {
    expect(createTempoMapFrom([{ step: 0, bpm: 400 }])).toEqual([{ step: 0, bpm: 300 }]);
    expect(createTempoMapFrom([{ step: 8, bpm: 12 }])).toEqual([
      { step: 0, bpm: 20 },
      { step: 8, bpm: 20 },
    ]);
  });

  it('integrates piecewise tempo and inverts exactly', () => {
    // 16 steps at 120 BPM (0.125 s each) then 16 steps at 60 BPM (0.25 s each).
    const map = createTempoMapFrom([
      { step: 0, bpm: 120 },
      { step: 16, bpm: 60 },
    ]);
    expect(secondsAtStep(map, FOUR_FOUR, 0)).toBe(0);
    expect(secondsAtStep(map, FOUR_FOUR, 16)).toBeCloseTo(2, 12);
    expect(secondsAtStep(map, FOUR_FOUR, 32)).toBeCloseTo(6, 12);
    expect(secondsAtStep(map, FOUR_FOUR, 8)).toBeCloseTo(1, 12);
    expect(secondsAtStep(map, FOUR_FOUR, 48)).toBeCloseTo(10, 12);

    expect(stepAtSeconds(map, FOUR_FOUR, 1)).toBeCloseTo(8, 10);
    expect(stepAtSeconds(map, FOUR_FOUR, 2)).toBeCloseTo(16, 10);
    expect(stepAtSeconds(map, FOUR_FOUR, 6)).toBeCloseTo(32, 10);
    expect(stepAtSeconds(map, FOUR_FOUR, 0)).toBe(0);
    expect(stepAtSeconds(map, FOUR_FOUR, -1)).toBe(0);
  });

  it('round-trips every step across a tempo change', () => {
    const map = createTempoMapFrom([
      { step: 0, bpm: 96 },
      { step: 37, bpm: 143 },
      { step: 90, bpm: 71 },
    ]);
    for (const step of [0, 1, 36, 37, 38, 89, 90, 128, 511]) {
      expect(stepAtSeconds(map, FOUR_FOUR, secondsAtStep(map, FOUR_FOUR, step))).toBeCloseTo(step, 9);
    }
  });

  it('measures the distance between two steps and ignores backwards ranges', () => {
    const map = createTempoMap(120);
    expect(secondsBetweenSteps(map, FOUR_FOUR, 4, 8)).toBeCloseTo(0.5, 12);
    expect(secondsBetweenSteps(map, FOUR_FOUR, 8, 4)).toBe(0);
    expect(secondsBetweenSteps(map, FOUR_FOUR, 0, 0)).toBe(0);
    // Tempo change inside the range.
    const changing = createTempoMapFrom([
      { step: 0, bpm: 120 },
      { step: 8, bpm: 60 },
    ]);
    expect(secondsBetweenSteps(changing, FOUR_FOUR, 4, 12)).toBeCloseTo(0.5 + 1, 12);
  });

  it('reports the tempo in effect at a step', () => {
    const map = createTempoMapFrom([
      { step: 0, bpm: 120 },
      { step: 16, bpm: 140 },
    ]);
    expect(tempoAtStep(map, 0)).toBe(120);
    expect(tempoAtStep(map, 15)).toBe(120);
    expect(tempoAtStep(map, 16)).toBe(140);
    expect(tempoAtStep(map, 999)).toBe(140);
  });
});

describe('musical positions', () => {
  it('splits steps into bar, beat, and sixteenth', () => {
    expect(stepsToMusicalPosition(0, FOUR_FOUR)).toEqual({ bar: 0, beat: 0, step: 0 });
    expect(stepsToMusicalPosition(20, FOUR_FOUR)).toEqual({ bar: 1, beat: 1, step: 0 });
    expect(stepsToMusicalPosition(23, FOUR_FOUR)).toEqual({ bar: 1, beat: 1, step: 3 });
    // 6/8: 12 steps per bar, 2 steps per beat.
    expect(stepsToMusicalPosition(13, SIX_EIGHT)).toEqual({ bar: 1, beat: 0, step: 1 });
    expect(stepsToMusicalPosition(17, SIX_EIGHT)).toEqual({ bar: 1, beat: 2, step: 1 });
  });

  it('round-trips positions and formats them one-indexed', () => {
    for (const step of [0, 5, 16, 47, 128]) {
      const position = stepsToMusicalPosition(step, FOUR_FOUR);
      expect(musicalPositionToSteps(position, FOUR_FOUR)).toBe(step);
    }
    expect(formatMusicalPosition(0, FOUR_FOUR)).toBe('01 : 01 : 01');
    expect(formatMusicalPosition(20, FOUR_FOUR)).toBe('02 : 02 : 01');
    expect(formatMusicalPosition(47, FOUR_FOUR)).toBe('03 : 04 : 04');
  });

  it('handles fractional positions while producing floored readouts', () => {
    expect(stepsToMusicalPosition(4.5, FOUR_FOUR)).toEqual({ bar: 0, beat: 1, step: 0.5 });
    expect(formatMusicalPosition(4.9, FOUR_FOUR)).toBe('01 : 02 : 01');
    expect(stepsToMusicalPosition(Number.NaN, FOUR_FOUR)).toEqual({ bar: 0, beat: 0, step: 0 });
  });
});
