import {
  firstEventIndexAtOrAfter,
  sortMusicalEvents,
  type MusicalEvent,
  type MusicalEventSink,
} from '../core/events/musicalEvents';
import type { TransportClockStatus, TransportCycle } from '../core/transport/transportClock';
import type { RepeatingTimer } from './timer';

/**
 * Lookahead scheduler.
 *
 * Sound timing never comes from `requestAnimationFrame`, `setInterval`, or React state: a timer
 * wakes up periodically and schedules every event that falls inside the next `lookaheadSeconds`
 * against `AudioContext.currentTime`. Timer jitter therefore only changes *how early* events are
 * queued; the audio thread renders them at sample-accurate times.
 *
 * The scheduler owns a cursor over a sorted event list plus the loop cycle it is currently
 * filling. Any transport reconfiguration (tempo, loop, seek, start, stop) invalidates that state
 * through `reset()`, so events are never scheduled twice and never survive a stop.
 */

export interface SchedulerTransport {
  readonly status: TransportClockStatus;
  positionAt(contextTime: number): number;
  advanceTo(contextTime: number): TransportCycle;
  advanceCycle(cycle: TransportCycle): TransportCycle;
  timeForStep(cycle: TransportCycle, step: number): number;
  secondsBetweenSteps(from: number, to: number): number;
}

export interface SchedulerClock {
  /** Current AudioContext time in seconds. */
  now(): number;
}

export interface SchedulerDiagnostics {
  ticks: number;
  scheduledCount: number;
  droppedCount: number;
  /** Events skipped because they fall outside the loop region. */
  skippedOutOfRangeCount: number;
  lastWindowSeconds: number;
  lastScheduled: number;
  running: boolean;
}

export interface SchedulerOptions {
  transport: SchedulerTransport;
  sink: MusicalEventSink;
  clock: SchedulerClock;
  timer?: RepeatingTimer;
  /** How far ahead of the audio clock events are queued. */
  lookaheadSeconds?: number;
  /** Timer period. Must be comfortably smaller than the lookahead. */
  intervalMs?: number;
  /** Events later than this (in seconds) are dropped instead of fired late. */
  lateGraceSeconds?: number;
  /**
   * Runs before each scheduling window with the current audio-clock time. Returning false
   * skips the window (used by the engine for loop wraps and auto-stop).
   */
  beforeTick?: (now: number) => boolean;
  onError?: (error: unknown) => void;
}

export const DEFAULT_LOOKAHEAD_SECONDS = 0.12;
export const DEFAULT_INTERVAL_MS = 25;
export const DEFAULT_LATE_GRACE_SECONDS = 0.01;

export class Scheduler {
  private events: MusicalEvent[] = [];
  private cursor = 0;
  private cycle: TransportCycle | null = null;
  private timerHandle: RepeatingTimer | null;
  private running = false;
  private readonly transport: SchedulerTransport;
  private readonly sink: MusicalEventSink;
  private readonly clock: SchedulerClock;
  private readonly lookaheadSeconds: number;
  private readonly intervalMs: number;
  private readonly lateGraceSeconds: number;
  private readonly beforeTick: ((now: number) => boolean) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly diagnostics: SchedulerDiagnostics = {
    ticks: 0,
    scheduledCount: 0,
    droppedCount: 0,
    skippedOutOfRangeCount: 0,
    lastWindowSeconds: 0,
    lastScheduled: 0,
    running: false,
  };

  constructor(options: SchedulerOptions) {
    this.transport = options.transport;
    this.sink = options.sink;
    this.clock = options.clock;
    this.timerHandle = options.timer ?? null;
    this.lookaheadSeconds = options.lookaheadSeconds ?? DEFAULT_LOOKAHEAD_SECONDS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.lateGraceSeconds = options.lateGraceSeconds ?? DEFAULT_LATE_GRACE_SECONDS;
    this.beforeTick = options.beforeTick;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.running;
  }

  getDiagnostics(): SchedulerDiagnostics {
    return { ...this.diagnostics, running: this.running };
  }

  /** Replace the event list. While playing, the cursor is rebuilt from the current position. */
  setEvents(events: readonly MusicalEvent[], contextTime?: number): void {
    this.events = sortMusicalEvents(events);
    const time = contextTime ?? (this.running ? this.clock.now() : undefined);
    this.cursor = time === undefined ? 0 : firstEventIndexAtOrAfter(this.events, this.transport.positionAt(time));
  }

  /** Drop cached scheduling state. Called after any transport reconfiguration. */
  reset(): void {
    this.cycle = null;
    this.cursor = 0;
  }

  /** Point the cursor at a position (used after seeks and on start). */
  seekToPosition(step: number): void {
    this.cycle = null;
    this.cursor = firstEventIndexAtOrAfter(this.events, step);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.diagnostics.running = true;
    if (this.timerHandle) {
      this.timerHandle.start(() => this.tick(), this.intervalMs);
    }
  }

  stop(): void {
    this.running = false;
    this.diagnostics.running = false;
    this.timerHandle?.stop();
    this.reset();
  }

  dispose(): void {
    this.stop();
    this.events = [];
  }

  /** Called by the lookahead timer. Returns how many events were queued. */
  tick(): number {
    if (!this.running) return 0;
    try {
      const now = this.clock.now();
      if (this.beforeTick && this.beforeTick(now) === false) return 0;
      return this.scheduleWindow(now);
    } catch (error) {
      this.onError?.(error);
      return 0;
    }
  }

  /**
   * Queue every event that starts before `now + lookaheadSeconds`.
   *
   * Exposed separately from `tick()` so tests can drive it with a synthetic clock.
   */
  scheduleWindow(now: number, horizonSeconds = this.lookaheadSeconds): number {
    const horizon = now + horizonSeconds;
    let scheduled = 0;
    this.diagnostics.ticks += 1;
    this.diagnostics.lastWindowSeconds = horizonSeconds;
    if (this.transport.status !== 'playing') return 0;
    if (this.events.length === 0) return 0;

    // Each pass either advances the cursor, advances the cycle, or breaks.
    let guard = this.events.length * 2 + 16;

    while (guard > 0) {
      guard -= 1;
      if (!this.cycle) this.cycle = this.transport.advanceTo(now);
      const cycle = this.cycle;
      const events = this.events;

      while (this.cursor < events.length && events[this.cursor].step < cycle.startStep) {
        this.cursor += 1;
        this.diagnostics.skippedOutOfRangeCount += 1;
      }

      if (this.cursor >= events.length) {
        // Nothing left in this pass; wait for the next cycle (never happens when not looping).
        if (!Number.isFinite(cycle.durationSeconds) || horizon < cycle.startTime + cycle.durationSeconds) break;
        this.beginNextCycle(cycle, now);
        continue;
      }

      const event = events[this.cursor];
      if (event.step >= cycle.endStep) {
        this.cursor += 1;
        this.diagnostics.skippedOutOfRangeCount += 1;
        continue;
      }

      const time = this.transport.timeForStep(cycle, event.step);
      if (time >= horizon) break;

      this.cursor += 1;
      if (time < now - this.lateGraceSeconds) {
        this.diagnostics.droppedCount += 1;
        continue;
      }

      let durationSeconds = 0;
      if (event.kind === 'note') {
        durationSeconds = this.transport.secondsBetweenSteps(event.step, event.step + event.durationSteps);
        // Never let a sustained event hang across the loop boundary.
        const cycleEnd = cycle.startTime + cycle.durationSeconds;
        if (Number.isFinite(cycleEnd)) {
          durationSeconds = Math.max(0, Math.min(time + durationSeconds, cycleEnd) - time);
        }
      }

      try {
        this.sink.scheduleEvent({ event, time, durationSeconds, iteration: cycle.iteration });
      } catch (error) {
        this.onError?.(error);
      }
      scheduled += 1;
      this.diagnostics.scheduledCount += 1;
    }

    this.diagnostics.lastScheduled = scheduled;
    return scheduled;
  }

  private beginNextCycle(cycle: TransportCycle, now: number): void {
    const next = this.transport.advanceCycle(cycle);
    // After a long stall (throttled tab) skip ahead to the cycle that contains `now`
    // instead of firing a burst of late events.
    if (next.startTime + next.durationSeconds <= now) {
      this.cycle = this.transport.advanceTo(now);
    } else {
      this.cycle = next;
    }
    this.cursor = 0;
  }
}
