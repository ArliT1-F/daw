import { describe, expect, it } from 'vitest';
import { TransportClock } from '../core/transport/transportClock';
import type { MusicalEvent, MusicalEventSink, ScheduledEventTiming } from '../core/events/musicalEvents';
import { Scheduler } from './scheduler';

const FOUR_FOUR = { numerator: 4, denominator: 4 };

interface Recorded {
  id: string;
  step: number;
  time: number;
  durationSeconds: number;
  iteration: number;
}

class RecordingSink implements MusicalEventSink {
  readonly scheduled: Recorded[] = [];
  readonly cancels: number[] = [];
  readonly releases: number[] = [];

  scheduleEvent(timing: ScheduledEventTiming): void {
    this.scheduled.push({
      id: timing.event.id,
      step: timing.event.step,
      time: timing.time,
      durationSeconds: timing.durationSeconds,
      iteration: timing.iteration,
    });
  }

  cancelPendingFrom(time: number): void {
    // Mirrors the engine: voices that have not started are dropped, so they never sound twice.
    this.cancels.push(time);
    for (let index = this.scheduled.length - 1; index >= 0; index -= 1) {
      if (this.scheduled[index].time >= time) this.scheduled.splice(index, 1);
    }
  }

  releaseAll(atTime: number): void {
    this.releases.push(atTime);
  }
}

interface Harness {
  scheduler: Scheduler;
  transport: TransportClock;
  sink: RecordingSink;
  clock: { now: number };
  advanceTo(time: number): number;
  ids(): string[];
}

/**
 * 120 BPM in 4/4 = 0.125 s per step. The default loop is steps 0..8, so one pass lasts 1 s.
 */
function createHarness(options: { lookahead?: number; loopEndStep?: number; tempoBpm?: number } = {}): Harness {
  const transport = new TransportClock({
    tempoBpm: options.tempoBpm ?? 120,
    timeSignature: FOUR_FOUR,
    loop: { enabled: true, startStep: 0, endStep: options.loopEndStep ?? 8 },
  });
  const sink = new RecordingSink();
  const clock = { now: 0 };
  const scheduler = new Scheduler({
    transport,
    sink,
    clock: { now: () => clock.now },
    lookaheadSeconds: options.lookahead ?? 0.5,
    lateGraceSeconds: 0.01,
  });
  return {
    scheduler,
    transport,
    sink,
    clock,
    advanceTo(time: number) {
      clock.now = time;
      transport.syncCycles(time);
      return scheduler.tick();
    },
    ids: () => sink.scheduled.map((entry) => `${entry.id}@${entry.iteration}`),
  };
}

function stepEvents(steps: number[]): MusicalEvent[] {
  return steps.map((step) => ({
    kind: 'sample' as const,
    id: `s${step}`,
    step,
    channelId: 'channel-kick',
    sampleId: 'channel-kick',
    velocity: 0.9,
  }));
}

describe('scheduler: lookahead window', () => {
  it('queues only events that start inside the lookahead horizon', () => {
    const harness = createHarness({ lookahead: 0.5 });
    harness.scheduler.setEvents(stepEvents([0, 2, 4, 6]));
    harness.transport.start(0);
    harness.scheduler.start();

    harness.advanceTo(0);
    expect(harness.sink.scheduled.map((entry) => entry.step)).toEqual([0, 2]);
    expect(harness.sink.scheduled.map((entry) => entry.time)).toEqual([0, 0.25]);

    harness.advanceTo(0.3);
    expect(harness.sink.scheduled.map((entry) => entry.step)).toEqual([0, 2, 4, 6]);
    expect(harness.sink.scheduled[3].time).toBeCloseTo(0.75, 12);
  });

  it('schedules nothing when the transport is stopped or paused', () => {
    const harness = createHarness();
    harness.scheduler.setEvents(stepEvents([0, 2]));
    harness.scheduler.start();
    harness.advanceTo(0);
    expect(harness.sink.scheduled).toHaveLength(0);

    harness.transport.start(0);
    harness.advanceTo(0);
    expect(harness.sink.scheduled).toHaveLength(2);

    harness.transport.pause(0.1);
    harness.advanceTo(0.2);
    expect(harness.sink.scheduled).toHaveLength(2);
  });

  it('tolerates an empty event list', () => {
    const harness = createHarness();
    harness.scheduler.setEvents([]);
    harness.transport.start(0);
    harness.scheduler.start();
    expect(harness.advanceTo(0)).toBe(0);
    expect(harness.scheduler.getDiagnostics().ticks).toBe(1);
  });
});

describe('scheduler: loop boundaries', () => {
  it('continues seamlessly into the next loop iteration', () => {
    const harness = createHarness({ lookahead: 0.5 });
    harness.scheduler.setEvents(stepEvents([0, 2, 4, 6]));
    harness.transport.start(0);
    harness.scheduler.start();

    for (let time = 0; time <= 2; time += 0.1) harness.advanceTo(Number(time.toFixed(2)));

    const byStep = new Map<string, number[]>();
    for (const entry of harness.sink.scheduled) {
      byStep.set(entry.id, [...(byStep.get(entry.id) ?? []), entry.time]);
    }
    // Every event fires once per iteration, exactly one cycle (1 s) apart.
    for (const times of byStep.values()) {
      expect(times.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index] - times[index - 1]).toBeCloseTo(1, 9);
      }
    }
  });

  it('keeps the gap across the loop boundary equal to one step', () => {
    const harness = createHarness({ lookahead: 0.5 });
    harness.scheduler.setEvents(stepEvents([0, 7]));
    harness.transport.start(0);
    harness.scheduler.start();
    for (let time = 0; time <= 1.5; time += 0.1) harness.advanceTo(Number(time.toFixed(2)));

    const first = harness.sink.scheduled.find((entry) => entry.step === 7);
    const nextLoopStart = harness.sink.scheduled.find((entry) => entry.step === 0 && entry.iteration === 1);
    expect(first).toBeDefined();
    expect(nextLoopStart).toBeDefined();
    expect((nextLoopStart as Recorded).time - (first as Recorded).time).toBeCloseTo(0.125, 12);
  });

  it('never queues the same event twice for one iteration', () => {
    const harness = createHarness({ lookahead: 0.5 });
    harness.scheduler.setEvents(stepEvents([0, 1, 2, 3, 4, 5, 6, 7]));
    harness.transport.start(0);
    harness.scheduler.start();
    for (let time = 0; time <= 5; time += 0.05) harness.advanceTo(Number(time.toFixed(2)));

    const keys = harness.ids();
    expect(new Set(keys).size).toBe(keys.length);
    expect(harness.scheduler.getDiagnostics().droppedCount).toBe(0);
  });

  it('skips events outside the loop region', () => {
    const harness = createHarness({ loopEndStep: 8 });
    harness.scheduler.setEvents(stepEvents([0, 2, 10, 12]));
    harness.transport.start(0);
    harness.scheduler.start();
    for (let time = 0; time <= 1.2; time += 0.1) harness.advanceTo(Number(time.toFixed(2)));

    expect(harness.sink.scheduled.every((entry) => entry.step < 8)).toBe(true);
    expect(harness.scheduler.getDiagnostics().skippedOutOfRangeCount).toBeGreaterThan(0);
  });

  it('clamps sustained notes at the loop boundary so nothing hangs over', () => {
    const harness = createHarness({ lookahead: 1 });
    harness.scheduler.setEvents([
      {
        kind: 'note',
        id: 'n6',
        step: 6,
        channelId: 'channel-bass',
        pitch: 48,
        velocity: 0.8,
        durationSteps: 8,
      },
    ]);
    harness.transport.start(0);
    harness.scheduler.start();
    harness.advanceTo(0);

    const scheduled = harness.sink.scheduled[0];
    // Step 6 is at 0.75 s; the cycle ends at 1.0 s, so the note is cut to 0.25 s instead of 1 s.
    expect(scheduled.time).toBeCloseTo(0.75, 12);
    expect(scheduled.durationSeconds).toBeCloseTo(0.25, 12);
  });

  it('gives one-shot triggers a zero duration while notes get their step length', () => {
    const harness = createHarness({ lookahead: 0.5 });
    harness.scheduler.setEvents([
      ...stepEvents([0]),
      {
        kind: 'note',
        id: 'n0',
        step: 0,
        channelId: 'channel-bass',
        pitch: 60,
        velocity: 0.8,
        durationSteps: 4,
      },
    ]);
    harness.transport.start(0);
    harness.scheduler.start();
    harness.advanceTo(0);
    expect(harness.sink.scheduled.find((entry) => entry.id === 's0')?.durationSeconds).toBe(0);
    expect(harness.sink.scheduled.find((entry) => entry.id === 'n0')?.durationSeconds).toBeCloseTo(0.5, 12);
  });
});

describe('scheduler: transport reconfiguration', () => {
  it('drops late events instead of firing them behind the clock', () => {
    const harness = createHarness({ lookahead: 0.3 });
    harness.scheduler.setEvents(stepEvents([0, 2, 4, 6]));
    harness.transport.start(0);
    harness.scheduler.start();

    // The clock jumps 0.9 s before the first tick: everything already passed is dropped,
    // the next loop iteration is still scheduled on time.
    harness.advanceTo(0.9);
    expect(harness.scheduler.getDiagnostics().droppedCount).toBe(4);
    expect(harness.sink.scheduled).toHaveLength(1);
    expect(harness.sink.scheduled[0]).toMatchObject({ step: 0, iteration: 1 });
    expect(harness.sink.scheduled[0].time).toBeCloseTo(1, 12);
  });

  it('re-cursors from the current position after a seek', () => {
    const harness = createHarness({ lookahead: 0.2 });
    harness.scheduler.setEvents(stepEvents([0, 2, 4, 6]));
    harness.transport.start(0);
    harness.scheduler.start();

    harness.transport.seek(5, 0.6);
    harness.scheduler.seekToPosition(harness.transport.positionAt(0.6));
    harness.advanceTo(0.6);

    expect(harness.sink.scheduled.map((entry) => entry.step)).toEqual([6]);
    // Step 6 is one step after the seek target (step 5 at 0.6 s), i.e. 0.725 s.
    expect(harness.sink.scheduled[0].time).toBeCloseTo(0.725, 12);
  });

  it('re-cursors from the current position when events change mid-playback', () => {
    const harness = createHarness({ lookahead: 0.5 });
    harness.scheduler.setEvents(stepEvents([0, 2]));
    harness.transport.start(0);
    harness.scheduler.start();
    harness.advanceTo(0);
    expect(harness.sink.scheduled.map((entry) => entry.step)).toEqual([0, 2]);

    harness.sink.cancelPendingFrom(0.1); // as the engine does before swapping the sequence
    harness.scheduler.setEvents(stepEvents([0, 2, 4]), 0.1);
    harness.advanceTo(0.2);
    // Step 0 stays behind the cursor after the swap and is never queued twice.
    expect(harness.sink.scheduled.map((entry) => entry.step)).toEqual([0, 2, 4]);
    expect(new Set(harness.ids()).size).toBe(harness.ids().length);
  });

  it('resolves events against a new tempo after the transport re-anchors', () => {
    const harness = createHarness({ lookahead: 1 });
    harness.scheduler.setEvents(stepEvents([0, 2, 4, 6]));
    harness.transport.start(0);
    harness.scheduler.start();
    harness.advanceTo(0);
    // A 1 s horizon reaches every event of the 1 s loop.
    expect(harness.sink.scheduled.map((entry) => entry.step)).toEqual([0, 2, 4, 6]);

    // Step 2 (0.25 s at 120 BPM) is already queued; re-cursor from there after a tempo change.
    harness.sink.cancelPendingFrom(0.1); // as the engine does before re-anchoring
    harness.transport.setTempo(60, 0.1);
    harness.scheduler.seekToPosition(harness.transport.positionAt(0.1));
    harness.advanceTo(0.1);
    // Step 0 already sounded before the change; steps 2 and 4 are re-queued at the new tempo.
    expect(harness.sink.scheduled.map((entry) => entry.step)).toEqual([0, 2, 4]);

    // The engine pairs this re-cursor with `cancelPendingFrom`, so the step-2 voice queued at
    // 0.25 s under the old tempo is dropped before the 0.4 s version sounds.
    const step4 = harness.sink.scheduled.filter((entry) => entry.step === 4);
    expect(step4).toHaveLength(1);
    // At 60 BPM a step lasts 0.25 s: from position 0.8 steps, step 2 lands at 0.4 s and step 4 at 0.9 s.
    expect(step4[0].time).toBeCloseTo(0.9, 9);
  });

  it('stops scheduling after stop() and clears cached cycle state', () => {
    const harness = createHarness({ lookahead: 0.5 });
    harness.scheduler.setEvents(stepEvents([0, 2, 4, 6]));
    harness.transport.start(0);
    harness.scheduler.start();
    harness.advanceTo(0);
    expect(harness.sink.scheduled).toHaveLength(2);

    harness.scheduler.stop();
    harness.advanceTo(0.5);
    expect(harness.sink.scheduled).toHaveLength(2);
    expect(harness.scheduler.isRunning).toBe(false);

    // Restarting parks the cursor at the start again.
    harness.transport.start(1);
    harness.scheduler.start();
    harness.advanceTo(1);
    expect(harness.sink.scheduled).toHaveLength(4);
    expect(harness.sink.scheduled[2].time).toBeCloseTo(1, 12);
  });

  it('reports diagnostics for the scheduling window', () => {
    const harness = createHarness({ lookahead: 0.5 });
    harness.scheduler.setEvents(stepEvents([0, 2, 4, 6]));
    harness.transport.start(0);
    harness.scheduler.start();
    harness.advanceTo(0);
    const diagnostics = harness.scheduler.getDiagnostics();
    expect(diagnostics).toMatchObject({ ticks: 1, scheduledCount: 2, droppedCount: 0, running: true });
    expect(diagnostics.lastScheduled).toBe(2);
  });
});
