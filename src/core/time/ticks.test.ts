import { describe, expect, it } from 'vitest';
import { createTempoMap, createTempoMapFrom, formatMusicalPosition, stepsToSeconds } from './musicalTime';
import {
  MIN_NOTE_DURATION_TICKS,
  TICKS_PER_QUARTER_NOTE,
  TICKS_PER_STEP,
  clampDurationToBoundary,
  floorSnapTicks,
  formatTickPosition,
  musicalPositionToTicks,
  patternLengthTicks,
  quantizeTicks,
  secondsAtTick,
  secondsToTicks,
  stepsToTicks,
  tickAtSeconds,
  tickPositionToTicks,
  ticksPerBar,
  ticksPerBeat,
  ticksToMusicalPosition,
  ticksToSeconds,
  ticksToSteps,
  ticksToTickPosition,
} from './ticks';

const FOUR_FOUR = { numerator: 4, denominator: 4 };
const SIX_EIGHT = { numerator: 6, denominator: 8 };
const SEVEN_EIGHT = { numerator: 7, denominator: 8 };

describe('tick grid', () => {
  it('uses a PPQ that divides common straight and triplet subdivisions', () => {
    expect(TICKS_PER_QUARTER_NOTE).toBe(96);
    expect(TICKS_PER_STEP).toBe(24);
    expect(TICKS_PER_QUARTER_NOTE % 2).toBe(0);
    expect(TICKS_PER_QUARTER_NOTE % 3).toBe(0);
    expect(TICKS_PER_QUARTER_NOTE % 4).toBe(0);
    expect(TICKS_PER_QUARTER_NOTE % 6).toBe(0);
    expect(TICKS_PER_QUARTER_NOTE % 8).toBe(0);
    expect(TICKS_PER_QUARTER_NOTE % 12).toBe(0);
    expect(TICKS_PER_QUARTER_NOTE % 16).toBe(0);
    expect(MIN_NOTE_DURATION_TICKS).toBe(1);
  });

  it('converts ticks, steps, bars, and beats without remainder', () => {
    expect(ticksPerBeat(FOUR_FOUR)).toBe(96);
    expect(ticksPerBar(FOUR_FOUR)).toBe(384);
    expect(ticksPerBeat(SIX_EIGHT)).toBe(48);
    expect(ticksPerBar(SIX_EIGHT)).toBe(288);
    expect(ticksPerBar(SEVEN_EIGHT)).toBe(336);
    expect(patternLengthTicks(16)).toBe(384);
    expect(patternLengthTicks(32)).toBe(768);
    expect(stepsToTicks(4)).toBe(96);
    expect(ticksToSteps(96)).toBe(4);
    expect(ticksToSteps(12)).toBe(0.5); // one 32nd
    expect(stepsToTicks(0.5)).toBe(12);
  });

  it('round-trips integer steps through ticks exactly', () => {
    for (const step of [0, 1, 2, 4, 7, 16, 32, 127]) {
      expect(ticksToSteps(stepsToTicks(step))).toBe(step);
      expect(stepsToTicks(ticksToSteps(step * TICKS_PER_STEP))).toBe(step * TICKS_PER_STEP);
    }
  });

  it('round-trips bar / beat / sixteenth / leftover tick positions', () => {
    const samples = [0, 1, 12, 24, 96, 97, 192, 383, 384, 400];
    for (const ticks of samples) {
      const position = ticksToTickPosition(ticks, FOUR_FOUR);
      expect(tickPositionToTicks(position, FOUR_FOUR)).toBe(ticks);
    }
    expect(ticksToTickPosition(96, FOUR_FOUR)).toEqual({ bar: 0, beat: 1, step: 0, tick: 0 });
    expect(ticksToTickPosition(24 + 5, FOUR_FOUR)).toEqual({ bar: 0, beat: 0, step: 1, tick: 5 });
    expect(ticksToMusicalPosition(384, FOUR_FOUR)).toEqual({ bar: 1, beat: 0, step: 0 });
    expect(musicalPositionToTicks({ bar: 1, beat: 1, step: 0 }, FOUR_FOUR)).toBe(384 + 96);
  });
});

describe('ticks and scheduled audio time', () => {
  it('converts ticks to seconds at a constant tempo', () => {
    // 120 BPM in 4/4: a quarter note is 0.5 s, a sixteenth is 0.125 s.
    expect(ticksToSeconds(96, 120, FOUR_FOUR)).toBeCloseTo(0.5, 12);
    expect(ticksToSeconds(24, 120, FOUR_FOUR)).toBeCloseTo(0.125, 12);
    expect(secondsToTicks(0.5, 120, FOUR_FOUR)).toBe(96);
    expect(secondsToTicks(2, 120, FOUR_FOUR)).toBe(384);
    expect(ticksToSeconds(96, 60, FOUR_FOUR)).toBeCloseTo(1, 12);
  });

  it('agrees with the step-based tempo map, including after a tempo change', () => {
    const map = createTempoMapFrom([
      { step: 0, bpm: 120 },
      { step: 16, bpm: 60 },
    ]);
    expect(secondsAtTick(map, FOUR_FOUR, 0)).toBe(0);
    expect(secondsAtTick(map, FOUR_FOUR, stepsToTicks(16))).toBeCloseTo(2, 12);
    expect(secondsAtTick(map, FOUR_FOUR, stepsToTicks(32))).toBeCloseTo(6, 12);
    expect(tickAtSeconds(map, FOUR_FOUR, 2)).toBe(stepsToTicks(16));
    expect(tickAtSeconds(map, FOUR_FOUR, 6)).toBe(stepsToTicks(32));
  });

  it('keeps musical tick positions aligned when tempo changes', () => {
    const tick = 96;
    expect(ticksToSteps(tick)).toBe(4);
    expect(formatTickPosition(tick, FOUR_FOUR)).toBe('01 : 02 : 01');
    expect(formatMusicalPosition(ticksToSteps(tick), FOUR_FOUR)).toBe('01 : 02 : 01');
    // Audio time scales with tempo; the tick (and therefore the playhead column) does not.
    expect(ticksToSeconds(tick, 120, FOUR_FOUR)).toBeCloseTo(0.5, 12);
    expect(ticksToSeconds(tick, 140, FOUR_FOUR)).toBeCloseTo(60 / 140, 12);
    expect(stepsToSeconds(ticksToSteps(tick), 120, FOUR_FOUR)).toBeCloseTo(ticksToSeconds(tick, 120, FOUR_FOUR), 12);
    const mapA = createTempoMap(120);
    const mapB = createTempoMap(140);
    expect(tickAtSeconds(mapA, FOUR_FOUR, secondsAtTick(mapA, FOUR_FOUR, tick))).toBe(tick);
    expect(tickAtSeconds(mapB, FOUR_FOUR, secondsAtTick(mapB, FOUR_FOUR, tick))).toBe(tick);
  });

  it('round-trips ticks through seconds at a constant tempo', () => {
    const map = createTempoMap(124);
    for (const tick of [0, 24, 48, 96, 192, 384]) {
      expect(tickAtSeconds(map, FOUR_FOUR, secondsAtTick(map, FOUR_FOUR, tick))).toBe(tick);
    }
  });
});

describe('snapping and loop-boundary duration', () => {
  it('quantizes to the nearest grid and floors to the containing cell', () => {
    expect(quantizeTicks(0, 24)).toBe(0);
    expect(quantizeTicks(11, 24)).toBe(0);
    expect(quantizeTicks(12, 24)).toBe(24);
    expect(quantizeTicks(50, 48)).toBe(48);
    expect(floorSnapTicks(23, 24)).toBe(0);
    expect(floorSnapTicks(24, 24)).toBe(24);
    expect(floorSnapTicks(47, 24)).toBe(24);
    expect(quantizeTicks(7, 1)).toBe(7);
    expect(quantizeTicks(10, 0)).toBe(10);
  });

  it('does not accumulate error across repeated snap edits', () => {
    let tick = 0;
    for (let index = 0; index < 64; index += 1) {
      tick = quantizeTicks(tick + 16, 16); // 16th-triplet grid
    }
    expect(tick).toBe(64 * 16);
    expect(tick % 16).toBe(0);
  });

  it('truncates notes that cross a loop or clip boundary and drops notes that start on it', () => {
    // Pattern of 16 sixteenths = 384 ticks. A quarter note starting 8 ticks before the end.
    expect(clampDurationToBoundary(376, 96, 384)).toBe(8);
    expect(clampDurationToBoundary(0, 96, 384)).toBe(96);
    expect(clampDurationToBoundary(384, 24, 384)).toBe(0);
    expect(clampDurationToBoundary(400, 24, 384)).toBe(0);
    expect(clampDurationToBoundary(380, 24, 384)).toBe(4);
    // Notes never wrap: leftover duration is discarded, not scheduled at tick 0 of the next pass.
    expect(clampDurationToBoundary(360, 48, 384)).toBe(24);
  });
});
