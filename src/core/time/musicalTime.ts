import type { TimeSignature } from '../project/model';

/**
 * Musical time model.
 *
 * The atomic unit is the sixteenth-note step (16 steps per whole note). Tempo and time
 * signature live here as plain data so scheduling maths stays independent of Web Audio,
 * React, and any third-party library.
 */

export const STEPS_PER_QUARTER_NOTE = 4;
/** Steps per whole note on the sixteenth-note grid. */
export const STEPS_PER_WHOLE_NOTE = 16;

export const MIN_TEMPO = 20;
export const MAX_TEMPO = 300;
export const DEFAULT_TEMPO = 120;

/** A tempo change anchored to a step position. The tempo of the last entry at or before a step applies. */
export interface TempoChange {
  readonly step: number;
  readonly bpm: number;
}

/** Ordered, normalized tempo automation. The first entry always sits at step 0. */
export type TempoMap = readonly TempoChange[];

export interface MusicalPosition {
  /** Zero-indexed bar. */
  bar: number;
  /** Zero-indexed beat within the bar. */
  beat: number;
  /** Zero-indexed sixteenth-note step within the beat. */
  step: number;
}

export function clampTempo(bpm: number): number {
  if (!Number.isFinite(bpm)) return DEFAULT_TEMPO;
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, bpm));
}

/** Steps per beat: how many sixteenth notes make up one beat for this signature. */
export function stepsPerBeat(timeSignature: TimeSignature): number {
  return STEPS_PER_WHOLE_NOTE / timeSignature.denominator;
}

/** Steps per bar (e.g. 4/4 → 16, 6/8 → 12, 7/8 → 14). */
export function stepsPerBar(timeSignature: TimeSignature): number {
  return timeSignature.numerator * stepsPerBeat(timeSignature);
}

export function secondsPerBeat(bpm: number): number {
  return 60 / clampTempo(bpm);
}

export function secondsPerStep(bpm: number, timeSignature: TimeSignature): number {
  return secondsPerBeat(bpm) / stepsPerBeat(timeSignature);
}

/** Convert a step distance to seconds at a single, constant tempo. */
export function stepsToSeconds(steps: number, bpm: number, timeSignature: TimeSignature): number {
  return steps * secondsPerStep(bpm, timeSignature);
}

/** Convert seconds to a step distance at a single, constant tempo. */
export function secondsToSteps(seconds: number, bpm: number, timeSignature: TimeSignature): number {
  return seconds / secondsPerStep(bpm, timeSignature);
}

export function barsToSteps(bars: number, timeSignature: TimeSignature): number {
  return bars * stepsPerBar(timeSignature);
}

export function stepsToBars(steps: number, timeSignature: TimeSignature): number {
  return steps / stepsPerBar(timeSignature);
}

/** Single-tempo tempo map. */
export function createTempoMap(bpm: number): TempoMap {
  return [{ step: 0, bpm: clampTempo(bpm) }];
}

/**
 * Normalize tempo automation: clamp values, drop duplicates, sort by step, and force an
 * entry at step 0 so every step position resolves to a tempo.
 */
export function createTempoMapFrom(changes: readonly TempoChange[]): TempoMap {
  const normalized: TempoChange[] = [];
  const seenSteps = new Set<number>();

  for (const change of changes) {
    if (!Number.isFinite(change.step) || !Number.isFinite(change.bpm)) continue;
    const step = Math.max(0, Math.floor(change.step));
    const bpm = clampTempo(change.bpm);
    if (seenSteps.has(step)) continue;
    seenSteps.add(step);
    normalized.push({ step, bpm });
  }
  normalized.sort((a, b) => a.step - b.step);
  if (normalized.length === 0) return createTempoMap(DEFAULT_TEMPO);
  if (normalized[0].step !== 0) normalized.unshift({ step: 0, bpm: normalized[0].bpm });
  return normalized;
}

/** The tempo in effect at a step position. */
export function tempoAtStep(tempoMap: TempoMap, step: number): number {
  let bpm = tempoMap[0]?.bpm ?? DEFAULT_TEMPO;
  for (const change of tempoMap) {
    if (change.step > step) break;
    bpm = change.bpm;
  }
  return bpm;
}

/**
 * Time in seconds from step 0 to `step` under a tempo map. The last tempo change extends
 * indefinitely, so the function is defined for any non-negative step.
 */
export function secondsAtStep(tempoMap: TempoMap, timeSignature: TimeSignature, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  let seconds = 0;
  for (let index = 0; index < tempoMap.length; index += 1) {
    const change = tempoMap[index];
    const startStep = Math.max(0, change.step);
    if (step <= startStep) break;
    const next = tempoMap[index + 1];
    const endStep = next ? Math.max(startStep, next.step) : Number.POSITIVE_INFINITY;
    const span = Math.min(step, endStep) - startStep;
    if (span > 0) seconds += span * secondsPerStep(change.bpm, timeSignature);
    if (step <= endStep) break;
  }
  return seconds;
}

/** Inverse of `secondsAtStep`: the step position reached after `seconds` from step 0. */
export function stepAtSeconds(tempoMap: TempoMap, timeSignature: TimeSignature, seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  let remaining = seconds;
  for (let index = 0; index < tempoMap.length; index += 1) {
    const change = tempoMap[index];
    const startStep = Math.max(0, change.step);
    const next = tempoMap[index + 1];
    const endStep = next ? Math.max(startStep, next.step) : Number.POSITIVE_INFINITY;
    const perStep = secondsPerStep(change.bpm, timeSignature);
    if (!Number.isFinite(endStep)) return startStep + remaining / perStep;
    const spanSeconds = (endStep - startStep) * perStep;
    if (remaining <= spanSeconds) return startStep + remaining / perStep;
    remaining -= spanSeconds;
  }
  return 0;
}

/** Elapsed seconds between two step positions. Returns 0 when `to` is at or before `from`. */
export function secondsBetweenSteps(
  tempoMap: TempoMap,
  timeSignature: TimeSignature,
  from: number,
  to: number,
): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return secondsAtStep(tempoMap, timeSignature, to) - secondsAtStep(tempoMap, timeSignature, from);
}

/** Split a (possibly fractional) step position into bar / beat / sixteenth. */
export function stepsToMusicalPosition(steps: number, timeSignature: TimeSignature): MusicalPosition {
  const perBeat = stepsPerBeat(timeSignature);
  const perBar = stepsPerBar(timeSignature);
  const safeSteps = Number.isFinite(steps) ? Math.max(0, steps) : 0;
  const bar = Math.floor(safeSteps / perBar);
  const stepInBar = safeSteps - bar * perBar;
  const beat = Math.floor(stepInBar / perBeat);
  return { bar, beat, step: stepInBar - beat * perBeat };
}

export function musicalPositionToSteps(position: MusicalPosition, timeSignature: TimeSignature): number {
  return (
    position.bar * stepsPerBar(timeSignature) +
    position.beat * stepsPerBeat(timeSignature) +
    position.step
  );
}

/** `01 : 02 : 03` style bar : beat : sixteenth readout with one-indexed values. */
export function formatMusicalPosition(steps: number, timeSignature: TimeSignature): string {
  const position = stepsToMusicalPosition(steps, timeSignature);
  return [position.bar + 1, position.beat + 1, Math.floor(position.step) + 1]
    .map((value) => String(value).padStart(2, '0'))
    .join(' : ');
}
