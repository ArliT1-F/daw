import type { TimeSignature } from '../project/model';
import {
  STEPS_PER_QUARTER_NOTE,
  musicalPositionToSteps,
  secondsAtStep,
  secondsToSteps,
  stepAtSeconds,
  stepsPerBar,
  stepsPerBeat,
  stepsToMusicalPosition,
  stepsToSeconds,
  type MusicalPosition,
  type TempoMap,
} from './musicalTime';

/**
 * Canonical musical time unit: integer ticks.
 *
 * Project notes, the piano-roll editor, and snapping all store and mutate ticks.
 * The scheduler still consumes sixteenth-note *steps* (which may be fractional once
 * swing is applied); convert at the project → event boundary with `ticksToSteps`.
 *
 * 96 PPQ divides 1/4, 1/8, 1/16, 1/32, 1/64 and the matching triplets without remainder,
 * so repeated UI edits never accumulate floating-point error.
 */
export const TICKS_PER_QUARTER_NOTE = 96;
export const TICKS_PER_STEP = TICKS_PER_QUARTER_NOTE / STEPS_PER_QUARTER_NOTE;
export const MIN_NOTE_DURATION_TICKS = 1;

/** Integer tick position split into bar / beat / sixteenth / leftover ticks. */
export interface TickPosition {
  /** Zero-indexed bar. */
  bar: number;
  /** Zero-indexed beat within the bar. */
  beat: number;
  /** Zero-indexed sixteenth-note step within the beat. */
  step: number;
  /** Leftover ticks inside that sixteenth. */
  tick: number;
}

export function ticksPerBeat(timeSignature: TimeSignature): number {
  return stepsPerBeat(timeSignature) * TICKS_PER_STEP;
}

export function ticksPerBar(timeSignature: TimeSignature): number {
  return stepsPerBar(timeSignature) * TICKS_PER_STEP;
}

export function patternLengthTicks(lengthSteps: number): number {
  if (!Number.isFinite(lengthSteps) || lengthSteps <= 0) return 0;
  return Math.floor(lengthSteps) * TICKS_PER_STEP;
}

/** Convert a (possibly fractional) step distance to integer ticks. */
export function stepsToTicks(steps: number): number {
  if (!Number.isFinite(steps)) return 0;
  return Math.round(steps * TICKS_PER_STEP);
}

/** Convert integer ticks to a step distance. Exact for whole sixteenths. */
export function ticksToSteps(ticks: number): number {
  if (!Number.isFinite(ticks)) return 0;
  return ticks / TICKS_PER_STEP;
}

export function ticksToMusicalPosition(ticks: number, timeSignature: TimeSignature): MusicalPosition {
  return stepsToMusicalPosition(ticksToSteps(ticks), timeSignature);
}

export function musicalPositionToTicks(position: MusicalPosition, timeSignature: TimeSignature): number {
  return stepsToTicks(musicalPositionToSteps(position, timeSignature));
}

export function ticksToTickPosition(ticks: number, timeSignature: TimeSignature): TickPosition {
  const safe = Number.isFinite(ticks) ? Math.max(0, Math.floor(ticks)) : 0;
  const perBeat = ticksPerBeat(timeSignature);
  const perBar = ticksPerBar(timeSignature);
  const bar = perBar > 0 ? Math.floor(safe / perBar) : 0;
  const inBar = perBar > 0 ? safe - bar * perBar : safe;
  const beat = perBeat > 0 ? Math.floor(inBar / perBeat) : 0;
  const inBeat = perBeat > 0 ? inBar - beat * perBeat : inBar;
  const step = Math.floor(inBeat / TICKS_PER_STEP);
  return { bar, beat, step, tick: inBeat - step * TICKS_PER_STEP };
}

export function tickPositionToTicks(position: TickPosition, timeSignature: TimeSignature): number {
  return (
    position.bar * ticksPerBar(timeSignature) +
    position.beat * ticksPerBeat(timeSignature) +
    position.step * TICKS_PER_STEP +
    position.tick
  );
}

export function ticksToSeconds(ticks: number, bpm: number, timeSignature: TimeSignature): number {
  return stepsToSeconds(ticksToSteps(ticks), bpm, timeSignature);
}

export function secondsToTicks(seconds: number, bpm: number, timeSignature: TimeSignature): number {
  return stepsToTicks(secondsToSteps(seconds, bpm, timeSignature));
}

export function secondsAtTick(tempoMap: TempoMap, timeSignature: TimeSignature, tick: number): number {
  return secondsAtStep(tempoMap, timeSignature, ticksToSteps(tick));
}

export function tickAtSeconds(tempoMap: TempoMap, timeSignature: TimeSignature, seconds: number): number {
  return stepsToTicks(stepAtSeconds(tempoMap, timeSignature, seconds));
}

/** Snap `ticks` to the nearest multiple of `gridTicks` (minimum 1). */
export function quantizeTicks(ticks: number, gridTicks: number): number {
  if (!Number.isFinite(ticks)) return 0;
  const grid = Math.max(1, Math.floor(gridTicks));
  return Math.round(ticks / grid) * grid;
}

/** Snap down to the grid cell containing `ticks` — used when placing a new note. */
export function floorSnapTicks(ticks: number, gridTicks: number): number {
  if (!Number.isFinite(ticks)) return 0;
  const grid = Math.max(1, Math.floor(gridTicks));
  return Math.floor(Math.max(0, ticks) / grid) * grid;
}

/**
 * How long a note that starts at `startTick` may sound before `endTick`.
 *
 * Notes that begin at or after the boundary contribute nothing. Notes that start
 * inside and extend past the boundary are truncated; they do not wrap to the
 * start of the next loop or pattern repeat.
 */
export function clampDurationToBoundary(startTick: number, durationTicks: number, endTick: number): number {
  if (!Number.isFinite(startTick) || !Number.isFinite(durationTicks) || !Number.isFinite(endTick)) return 0;
  if (startTick >= endTick) return 0;
  return Math.max(0, Math.min(durationTicks, endTick - startTick));
}

/** `01 : 02 : 03` bar : beat : sixteenth readout (one-indexed) from a tick position. */
export function formatTickPosition(ticks: number, timeSignature: TimeSignature): string {
  const position = ticksToTickPosition(ticks, timeSignature);
  return [position.bar + 1, position.beat + 1, position.step + 1]
    .map((value) => String(value).padStart(2, '0'))
    .join(' : ');
}
