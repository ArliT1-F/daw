import {
  firstEventIndexAtOrAfter,
  sortMusicalEvents,
  sampleOnsetKey,
  type MusicalEvent,
  type MusicalEventSink,
  type MusicalEventSource,
  type AudioClipEvent,
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
 * The live path queries an indexed arrangement source for each half-open, cycle-bounded
 * lookahead window, chasing only currently held notes/audio on entry. A flat-list adapter remains
 * for isolated pattern/legacy clients. Event IDs are deduplicated per iteration, and transport
 * reconfiguration invalidates the cursor and safely retires the previous queue.
 */

export interface SchedulerTransport {
  readonly status: TransportClockStatus;
  positionAt(contextTime: number): number;
  advanceTo(contextTime: number): TransportCycle;
  advanceCycle(cycle: TransportCycle): TransportCycle;
  timeForStep(cycle: TransportCycle, step: number): number;
  stepForTime(cycle: TransportCycle, contextTime: number): number;
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

export interface AudioContinuation {
  event: AudioClipEvent;
  sourceOffsetSeconds: number;
}

export const DEFAULT_LOOKAHEAD_SECONDS = 0.12;
export const DEFAULT_INTERVAL_MS = 25;
export const DEFAULT_LATE_GRACE_SECONDS = 0.01;

export class Scheduler {
  private events: MusicalEvent[] = [];
  private source: MusicalEventSource | null = null;
  private windowEndTime: number | null = null;
  private sourceSeekStep: number | null = null;
  private chaseNextWindow = true;
  private chasePosition: number | null = null;
  private skipSampleKeys = new Set<string>();
  private audioContinuations = new Map<string, AudioContinuation>();
  private readonly scheduledIds = new Map<number, Map<string, number>>();
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
    this.source = null;
    this.events = sortMusicalEvents(events);
    const time = contextTime ?? (this.running ? this.clock.now() : undefined);
    this.cursor = time === undefined ? 0 : firstEventIndexAtOrAfter(this.events, this.transport.positionAt(time));
  }

  /** Live arrangement mode: receive only events intersecting each musical lookahead window. */
  setEventSource(source: MusicalEventSource): void {
    this.source = source;
    this.events = [];
    this.reset();
  }

  /** Drop cached scheduling state. Called after any transport reconfiguration. */
  reset(): void {
    this.cycle = null;
    this.cursor = 0;
    this.windowEndTime = null;
    this.sourceSeekStep = null;
    this.chasePosition = null;
    this.skipSampleKeys.clear();
    this.audioContinuations.clear();
    this.chaseNextWindow = true;
    this.scheduledIds.clear();
  }

  /** Point the cursor at a position (used after seeks and on start). */
  seekToPosition(step: number, skipSampleKeys: ReadonlySet<string> = new Set(), audioContinuations: ReadonlyMap<string, AudioContinuation> = new Map()): void {
    this.cycle = null;
    this.cursor = firstEventIndexAtOrAfter(this.events, step);
    this.windowEndTime = null;
    this.sourceSeekStep = step;
    this.chasePosition = step;
    this.skipSampleKeys = new Set(skipSampleKeys);
    this.audioContinuations = new Map(audioContinuations);
    this.chaseNextWindow = true;
    this.scheduledIds.clear();
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
    this.source = null;
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
    if (this.source) return this.scheduleSourceWindow(now, horizon);
    if (this.events.length === 0) return 0;

    // Each pass either advances the cursor, advances the cycle, or breaks.
    let guard = this.events.length * 2 + 16;

    while (guard > 0) {
      if (this.transport.status !== 'playing') break;
      guard -= 1;
      if (!this.cycle) this.cycle = this.transport.advanceTo(now);
      const cycle = this.cycle;
      const events = this.events;
      if (this.chasePosition !== null) {
        const target = Math.max(cycle.startStep, this.chasePosition);
        for (const event of events) {
          if (event.step >= target) break;
          if (event.kind !== 'sample' && event.step + event.durationSteps > target) {
            scheduled += this.queueEvent(event, target, cycle, now, horizon);
          }
        }
        this.chasePosition = null;
      }

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

      if (event.kind === 'sample' && this.skipSampleKeys.has(sampleOnsetKey(event))) continue;
      scheduled += this.queueEvent(event, event.step, cycle, now, horizon);

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
    this.chasePosition = this.cycle.startStep;
    this.skipSampleKeys.clear();
    this.audioContinuations.clear();
  }

  private scheduleSourceWindow(now: number, horizon: number): number {
    const current = this.transport.advanceTo(now);
    if (this.cycle && this.cycle.iteration < current.iteration) {
      // A throttled timer may miss several loops. Query the current pass, not the stale song.
      this.cycle = null;
      this.windowEndTime = null;
      this.sourceSeekStep = this.transport.positionAt(now);
      this.chaseNextWindow = true;
    }
    for (const [iteration, ids] of this.scheduledIds) {
      if (iteration < current.iteration - 1) this.scheduledIds.delete(iteration);
      else for (const [id, time] of ids) if (time < now - this.lookaheadSeconds - this.lateGraceSeconds) ids.delete(id);
    }
    if (!this.cycle) {
      this.cycle = current;
      const target = Math.max(current.startStep, this.sourceSeekStep ?? this.transport.positionAt(now));
      this.windowEndTime = Math.max(now, this.transport.timeForStep(current, target));
      this.sourceSeekStep = null;
    }
    let scheduled = 0;
    // A one-tick loop at the fastest tempo can cross many passes in a 120 ms window.
    let guard = 1024;
    while (this.cycle && guard-- > 0) {
      const cycle = this.cycle;
      const cycleEnd = this.transport.timeForStep(cycle, cycle.endStep);
      const fromTime = Math.max(this.windowEndTime ?? now, now - this.lateGraceSeconds);
      const untilTime = Math.min(horizon, cycleEnd);
      if (untilTime > fromTime) {
        const from = Math.max(cycle.startStep, this.transport.stepForTime(cycle, fromTime));
        const to = Math.min(cycle.endStep, this.transport.stepForTime(cycle, untilTime));
        const ids = this.scheduledIds.get(cycle.iteration) ?? new Map<string, number>();
        this.scheduledIds.set(cycle.iteration, ids);
        const events = this.source!.queryWindow({ startStep: Math.max(cycle.startStep, from - 1e-8), endStep: to, includeSustains: this.chaseNextWindow });
        for (const event of events) {
          if (ids.has(event.id) || event.step >= cycle.endStep) continue;
          if (event.kind === 'sample' && this.skipSampleKeys.has(sampleOnsetKey(event))) continue;
          const step = event.step < from - 1e-8 && event.kind !== 'sample' ? from : event.step;
          if (this.transport.timeForStep(cycle, step) >= horizon) continue;
          if (event.kind === 'sample' && step < cycle.startStep) continue;
          const count = this.queueEvent(event, step, cycle, now, horizon);
          // Also remember naturally exhausted audio clips so they aren't chased repeatedly.
          ids.set(event.id, this.transport.timeForStep(cycle, step));
          scheduled += count;
        }
        this.chaseNextWindow = false;
        this.skipSampleKeys.clear();
        this.audioContinuations.clear();
        this.windowEndTime = untilTime;
      }
      if (!Number.isFinite(cycle.durationSeconds) || cycle.durationSeconds <= 0 || cycleEnd >= horizon) break;
      this.cycle = this.transport.advanceCycle(cycle);
      this.windowEndTime = this.cycle.startTime;
      this.chaseNextWindow = true;
      this.skipSampleKeys.clear();
      this.audioContinuations.clear();
    }
    this.diagnostics.lastScheduled = scheduled;
    return scheduled;
  }

  /** Resolve a chased onset and remaining duration, respecting clip and playback boundaries. */
  private queueEvent(event: MusicalEvent, step: number, cycle: TransportCycle, now: number, horizon: number): number {
    const time = this.transport.timeForStep(cycle, step);
    if (time >= horizon) return 0;
    if (time < now - this.lateGraceSeconds) {
      this.diagnostics.droppedCount += 1;
      return 0;
    }
    const boundary = Math.min(cycle.endStep, event.endStep ?? cycle.endStep);
    const stopTime = this.transport.timeForStep(cycle, boundary);
    let durationSeconds = 0;
    let sourceOffsetSeconds: number | undefined;
    if (event.kind !== 'sample') {
      const end = Math.min(boundary, event.step + event.durationSteps);
      durationSeconds = this.transport.secondsBetweenSteps(step, end);
      if (event.kind === 'audio') {
        const continuation = this.audioContinuations.get(event.id);
        const unchangedSource = continuation && continuation.event.assetId === event.assetId && continuation.event.step === event.step && continuation.event.sourceOffsetSeconds === event.sourceOffsetSeconds && continuation.event.sourceDurationSeconds === event.sourceDurationSeconds;
        // Live tempo/gain/right-edge edits preserve native source phase. A seek, moved onset,
        // new asset, or changed trim instead resolves from the current song mapping.
        sourceOffsetSeconds = unchangedSource ? continuation.sourceOffsetSeconds : event.sourceOffsetSeconds + this.transport.secondsBetweenSteps(event.step, step);
        durationSeconds = Math.min(durationSeconds, Math.max(0, event.sourceDurationSeconds - sourceOffsetSeconds));
      }
      if (durationSeconds <= 1e-9) return 0;
    }
    try {
      this.sink.scheduleEvent({ event, time: Math.max(now, time), durationSeconds, iteration: cycle.iteration, sourceOffsetSeconds, stopTime });
    } catch (error) {
      this.onError?.(error);
    }
    this.diagnostics.scheduledCount += 1;
    return 1;
  }
}
