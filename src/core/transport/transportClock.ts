import type { TimeSignature } from '../project/model';
import {
  createTempoMap,
  secondsAtStep,
  secondsBetweenSteps,
  stepAtSeconds,
  tempoAtStep,
  type TempoMap,
} from '../time/musicalTime';

/**
 * Transport clock: the single authority that maps AudioContext time to musical position.
 *
 * The clock is pure — it never touches Web Audio. Callers pass `contextTime` (seconds from
 * `AudioContext.currentTime`) in, so every conversion is a pure function of the last anchor.
 *
 * Anchoring
 * ---------
 * Position is stored as an anchor `(anchorTime, anchorStep)` plus a tempo map. Any future
 * position is `stepAtSeconds(secondsAtStep(anchorStep) + (now - anchorTime))`. Tempo changes,
 * time-signature changes, seeks, and loop wraps re-anchor at the current instant, which keeps
 * float error bounded and makes each operation's semantics explicit and testable.
 */

export type TransportClockStatus = 'stopped' | 'playing' | 'paused';

/** Playback region. `endStep` is exclusive. */
export interface LoopRange {
  startStep: number;
  endStep: number;
}

export interface TransportLoopState extends LoopRange {
  enabled: boolean;
}

/** Timing of one pass through the loop region. */
export interface TransportCycle {
  iteration: number;
  startStep: number;
  endStep: number;
  /** AudioContext time at which `startStep` of this iteration occurs. */
  startTime: number;
  /** Length of the region in seconds; `Infinity` when looping is disabled (no wrap). */
  durationSeconds: number;
}

export interface TransportSnapshot {
  status: TransportClockStatus;
  positionSteps: number;
  iteration: number;
  loop: TransportLoopState;
  tempoBpm: number;
  timeSignature: TimeSignature;
  cycleStartTime: number;
  cycleDurationSeconds: number;
  secondsPerStepNow: number;
}

export interface TransportClockOptions {
  tempoBpm?: number;
  tempoMap?: TempoMap;
  timeSignature?: TimeSignature;
  loop?: Partial<TransportLoopState>;
}

export interface StartOptions {
  fromStep?: number;
  /** Seconds of scheduling headroom added to `contextTime` so the first events are never late. */
  startDelay?: number;
  resetIteration?: boolean;
}

const DEFAULT_LOOP: TransportLoopState = { enabled: true, startStep: 0, endStep: 128 };

export class TransportClock {
  private currentStatus: TransportClockStatus = 'stopped';
  private parkedStep = 0;
  private anchorTime = 0;
  private anchorStep = 0;
  private cycleStartTime = 0;
  private iterationCount = 0;
  private tempoMapValue: TempoMap;
  private timeSignatureValue: TimeSignature;
  private loopState: TransportLoopState;

  constructor(options: TransportClockOptions = {}) {
    this.tempoMapValue = options.tempoMap ?? createTempoMap(options.tempoBpm ?? 120);
    this.timeSignatureValue = options.timeSignature ?? { numerator: 4, denominator: 4 };
    this.loopState = normalizeLoop(options.loop);
    this.parkedStep = this.loopState.startStep;
    this.anchorStep = this.parkedStep;
  }

  get status(): TransportClockStatus {
    return this.currentStatus;
  }

  get loop(): TransportLoopState {
    return { ...this.loopState };
  }

  get tempoMap(): TempoMap {
    return this.tempoMapValue;
  }

  get timeSignature(): TimeSignature {
    return { ...this.timeSignatureValue };
  }

  get iteration(): number {
    return this.iterationCount;
  }

  get isRunning(): boolean {
    return this.currentStatus === 'playing';
  }

  /** Position used while stopped or paused. */
  get parkedPositionSteps(): number {
    return this.parkedStep;
  }

  get cycleDurationSeconds(): number {
    return this.loopState.enabled
      ? secondsBetweenSteps(this.tempoMapValue, this.timeSignatureValue, this.loopState.startStep, this.loopState.endStep)
      : Number.POSITIVE_INFINITY;
  }

  /** Musical position for a given audio-clock time. */
  positionAt(contextTime: number): number {
    if (this.currentStatus !== 'playing') return this.parkedStep;
    const elapsedSeconds = contextTime - this.anchorTime;
    const anchorSeconds = secondsAtStep(this.tempoMapValue, this.timeSignatureValue, this.anchorStep);
    return Math.max(0, stepAtSeconds(this.tempoMapValue, this.timeSignatureValue, anchorSeconds + elapsedSeconds));
  }

  tempoAt(step: number): number {
    return tempoAtStep(this.tempoMapValue, step);
  }

  /** Audio-clock time at which `step` occurs in the current pass. */
  timeAtStep(step: number): number {
    const anchorSeconds = secondsAtStep(this.tempoMapValue, this.timeSignatureValue, this.anchorStep);
    const targetSeconds = secondsAtStep(this.tempoMapValue, this.timeSignatureValue, step);
    return this.anchorTime + (targetSeconds - anchorSeconds);
  }

  secondsBetweenSteps(from: number, to: number): number {
    return secondsBetweenSteps(this.tempoMapValue, this.timeSignatureValue, from, to);
  }

  /**
   * Start playback. `fromStep` defaults to the loop start; `startDelay` gives the scheduler
   * headroom so the first events are not scheduled in the past.
   */
  start(contextTime: number, options: StartOptions = {}): void {
    const from = this.clampToRegion(options.fromStep ?? this.loopState.startStep);
    const delay = Math.max(0, options.startDelay ?? 0);
    this.anchorTime = contextTime + delay;
    this.anchorStep = from;
    this.parkedStep = from;
    this.cycleStartTime = this.anchorTime - this.secondsBetweenSteps(this.loopState.startStep, from);
    this.iterationCount = options.resetIteration === false ? this.iterationCount : 0;
    this.currentStatus = 'playing';
  }

  /** Freeze at the current position. */
  pause(contextTime: number): void {
    if (this.currentStatus !== 'playing') return;
    this.parkedStep = this.positionAt(contextTime);
    this.currentStatus = 'paused';
  }

  /** Continue from the parked position. */
  resume(contextTime: number, options: StartOptions = {}): void {
    if (this.currentStatus !== 'paused') return;
    this.start(contextTime, { ...options, fromStep: this.parkedStep, resetIteration: false });
  }

  /** Park at the loop start (or region start) and reset the iteration counter. */
  stop(): void {
    this.currentStatus = 'stopped';
    this.parkedStep = this.loopState.startStep;
    this.anchorStep = this.parkedStep;
    this.anchorTime = 0;
    this.cycleStartTime = 0;
    this.iterationCount = 0;
  }

  /** Move the playhead. While playing, playback continues from the new position immediately. */
  seek(step: number, contextTime: number): void {
    const target = this.clampToRegion(step);
    if (this.currentStatus === 'playing') {
      this.anchorTime = contextTime;
      this.anchorStep = target;
      this.parkedStep = target;
      this.cycleStartTime = contextTime - this.secondsBetweenSteps(this.loopState.startStep, target);
      return;
    }
    this.parkedStep = target;
  }

  /**
   * Change tempo. The musical position at `contextTime` is preserved; only the rate changes.
   * A full tempo map can be supplied for future automation.
   */
  setTempo(bpm: number, contextTime: number): void;
  setTempo(tempoMap: TempoMap, contextTime: number): void;
  setTempo(tempo: number | TempoMap, contextTime: number): void {
    // The position must be read with the outgoing mapping, before the new one is applied.
    const position = this.capturePosition(contextTime);
    this.tempoMapValue = typeof tempo === 'number' ? createTempoMap(tempo) : tempo;
    this.reanchor(contextTime, position);
  }

  /** Replace the whole tempo map (future automation), preserving the current position. */
  setTempoMap(tempoMap: TempoMap, contextTime: number): void {
    const position = this.capturePosition(contextTime);
    this.tempoMapValue = tempoMap;
    this.reanchor(contextTime, position);
  }

  /** Change the time signature. The step position is preserved; bar/beat meaning changes with it. */
  setTimeSignature(timeSignature: TimeSignature, contextTime: number): void {
    const position = this.capturePosition(contextTime);
    this.timeSignatureValue = { ...timeSignature };
    this.reanchor(contextTime, position);
  }

  /** Change the loop region. The position is clamped into the new region and playback continues. */
  setLoop(loop: Partial<TransportLoopState>, contextTime: number): void {
    this.loopState = normalizeLoop({ ...this.loopState, ...loop });
    const position = this.currentStatus === 'playing' ? this.positionAt(contextTime) : this.parkedStep;
    const clamped = this.clampToRegion(position);
    this.parkedStep = clamped;
    if (this.currentStatus === 'playing') {
      this.anchorTime = contextTime;
      this.anchorStep = clamped;
      this.cycleStartTime = contextTime - this.secondsBetweenSteps(this.loopState.startStep, clamped);
    } else {
      this.anchorStep = clamped;
    }
  }

  /**
   * Advance past any loop boundaries that have already elapsed and return the cycle that
   * contains `contextTime`. Idempotent for a given time.
   */
  advanceTo(contextTime: number): TransportCycle {
    this.syncCycles(contextTime);
    return this.currentCycle();
  }

  /** The cycle following `cycle`, used to schedule events across a loop boundary. */
  advanceCycle(cycle: TransportCycle): TransportCycle {
    return {
      ...cycle,
      iteration: cycle.iteration + 1,
      startTime: cycle.startTime + cycle.durationSeconds,
    };
  }

  /** Apply any pending loop wraps and return how many occurred. */
  syncCycles(contextTime: number): number {
    if (!this.loopState.enabled || this.currentStatus !== 'playing') return 0;
    const duration = this.cycleDurationSeconds;
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    if (contextTime < this.cycleStartTime + duration) return 0;

    const elapsed = contextTime - this.cycleStartTime;
    const wraps = Math.floor(elapsed / duration);
    this.cycleStartTime += wraps * duration;
    this.iterationCount += wraps;
    // Re-anchor on the cycle start: keeps precision bounded and keeps the tempo map consistent.
    this.anchorTime = this.cycleStartTime;
    this.anchorStep = this.loopState.startStep;
    this.parkedStep = this.loopState.startStep;
    return wraps;
  }

  /** Audio-clock time for a step inside a given cycle. */
  timeForStep(cycle: TransportCycle, step: number): number {
    return cycle.startTime + this.secondsBetweenSteps(cycle.startStep, step);
  }

  snapshot(contextTime: number): TransportSnapshot {
    const position = this.positionAt(contextTime);
    return {
      status: this.currentStatus,
      positionSteps: position,
      iteration: this.iterationCount,
      loop: this.loop,
      tempoBpm: this.tempoAt(position),
      timeSignature: this.timeSignature,
      cycleStartTime: this.cycleStartTime,
      cycleDurationSeconds: this.cycleDurationSeconds,
      secondsPerStepNow:
        secondsBetweenSteps(this.tempoMapValue, this.timeSignatureValue, position, position + 1),
    };
  }

  private currentCycle(): TransportCycle {
    return {
      iteration: this.iterationCount,
      startStep: this.loopState.startStep,
      endStep: this.loopState.endStep,
      startTime: this.cycleStartTime,
      durationSeconds: this.cycleDurationSeconds,
    };
  }

  /** Position at `contextTime` under the current mapping, or null when not playing. */
  private capturePosition(contextTime: number): number | null {
    return this.currentStatus === 'playing' ? this.positionAt(contextTime) : null;
  }

  private reanchor(contextTime: number, preservedPosition: number | null = null): void {
    if (this.currentStatus !== 'playing') {
      this.anchorStep = this.parkedStep;
      return;
    }
    const position = preservedPosition ?? this.positionAt(contextTime);
    this.anchorTime = contextTime;
    this.anchorStep = position;
    this.parkedStep = position;
    this.cycleStartTime = contextTime - this.secondsBetweenSteps(this.loopState.startStep, position);
  }

  private clampToRegion(step: number): number {
    if (!Number.isFinite(step)) return this.loopState.startStep;
    const { startStep, endStep, enabled } = this.loopState;
    const lower = enabled ? Math.max(0, Math.min(startStep, endStep)) : 0;
    const upper = enabled ? Math.max(lower, endStep) : Number.POSITIVE_INFINITY;
    return Math.min(Math.max(step, lower), Number.isFinite(upper) ? upper : step);
  }
}

function normalizeLoop(loop: Partial<TransportLoopState> | undefined): TransportLoopState {
  const base = loop ?? {};
  const rawStart = Number.isFinite(base.startStep) ? Math.max(0, base.startStep as number) : DEFAULT_LOOP.startStep;
  const rawEnd = Number.isFinite(base.endStep) ? Math.max(0, base.endStep as number) : DEFAULT_LOOP.endStep;
  return {
    enabled: base.enabled ?? DEFAULT_LOOP.enabled,
    startStep: Math.min(rawStart, rawEnd),
    endStep: Math.max(rawStart, rawEnd),
  };
}
