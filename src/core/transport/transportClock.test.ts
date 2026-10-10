import { describe, expect, it } from 'vitest';
import { TransportClock, type TransportClockOptions } from './transportClock';

const FOUR_FOUR = { numerator: 4, denominator: 4 };
const SIX_EIGHT = { numerator: 6, denominator: 8 };

/** 120 BPM in 4/4: 0.125 s per sixteenth, so a 16-step loop lasts 2 s. */
function createClock(overrides: TransportClockOptions = {}) {
  return new TransportClock({
    tempoBpm: 120,
    timeSignature: FOUR_FOUR,
    loop: { enabled: true, startStep: 0, endStep: 16 },
    ...overrides,
  });
}

describe('transport clock: start, pause, resume, stop', () => {
  it('advances one step per 0.125 s at 120 BPM', () => {
    const clock = createClock();
    clock.start(10);
    expect(clock.status).toBe('playing');
    expect(clock.positionAt(10)).toBeCloseTo(0, 12);
    expect(clock.positionAt(10.125)).toBeCloseTo(1, 12);
    expect(clock.positionAt(11)).toBeCloseTo(8, 12);
  });

  it('starts with scheduling headroom so the first event is never in the past', () => {
    const clock = createClock();
    clock.start(5, { startDelay: 0.06 });
    expect(clock.timeAtStep(0)).toBeCloseTo(5.06, 12);
    expect(clock.positionAt(5)).toBeCloseTo(0, 12);
  });

  it('pauses at the current position and resumes from it', () => {
    const clock = createClock();
    clock.start(0);
    clock.pause(1);
    expect(clock.status).toBe('paused');
    expect(clock.positionAt(1)).toBeCloseTo(8, 12);
    // Time keeps moving while paused; the position does not.
    expect(clock.positionAt(9)).toBeCloseTo(8, 12);

    clock.resume(9);
    expect(clock.status).toBe('playing');
    expect(clock.positionAt(9)).toBeCloseTo(8, 12);
    expect(clock.positionAt(9.5)).toBeCloseTo(12, 12);
  });

  it('parks at the region start on stop and ignores pause/stop when already stopped', () => {
    const clock = createClock();
    clock.start(0);
    clock.stop();
    expect(clock.status).toBe('stopped');
    expect(clock.positionAt(100)).toBe(0);
    expect(clock.iteration).toBe(0);

    clock.pause(1);
    expect(clock.status).toBe('stopped');
    clock.seek(9, 2);
    expect(clock.parkedPositionSteps).toBe(9);
    clock.stop();
    expect(clock.parkedPositionSteps).toBe(0);
  });

  it('resume only applies to a paused transport', () => {
    const clock = createClock();
    clock.resume(0);
    expect(clock.status).toBe('stopped');
    clock.start(0, { fromStep: 4 });
    clock.resume(1);
    // A resume while playing is a no-op: the transport simply keeps running.
    expect(clock.positionAt(1)).toBeCloseTo(12, 12);
  });
});

describe('transport clock: seeking', () => {
  it('re-anchors while playing so playback continues from the new position', () => {
    const clock = createClock();
    clock.start(0);
    clock.seek(12, 3);
    expect(clock.positionAt(3)).toBeCloseTo(12, 12);
    expect(clock.positionAt(3.25)).toBeCloseTo(14, 12);
  });

  it('clamps seeks into the loop region and to zero when looping is off', () => {
    const clock = createClock({ loop: { enabled: true, startStep: 4, endStep: 12 } });
    clock.start(0);
    expect(clock.parkedPositionSteps).toBe(4);
    clock.seek(-10, 1);
    expect(clock.parkedPositionSteps).toBe(4);
    clock.seek(999, 1);
    expect(clock.parkedPositionSteps).toBe(12);

    const free = createClock({ loop: { enabled: false, startStep: 0, endStep: 16 } });
    free.start(0);
    free.seek(400, 1);
    expect(free.parkedPositionSteps).toBe(400);
  });

  it('parks at the requested step when stopped', () => {
    const clock = createClock({ loop: { enabled: false, startStep: 0, endStep: 16 } });
    clock.seek(6, 0);
    expect(clock.status).toBe('stopped');
    expect(clock.positionAt(0)).toBe(6);
  });
});

describe('transport clock: tempo and signature changes', () => {
  it('preserves the musical position when the tempo changes', () => {
    const clock = createClock();
    clock.start(0);
    clock.advanceTo(1); // step 8
    const positionBefore = clock.positionAt(1);

    clock.setTempo(60, 1);
    expect(clock.positionAt(1)).toBeCloseTo(positionBefore, 10);
    // Halving the tempo doubles the time per step: 0.25 s.
    expect(clock.positionAt(2)).toBeCloseTo(12, 10);
    expect(clock.tempoAt(0)).toBe(60);
  });

  it('preserves the position when the time signature changes', () => {
    const clock = createClock();
    clock.start(0);
    clock.seek(8, 2);
    clock.setTimeSignature(SIX_EIGHT, 2);
    expect(clock.positionAt(2)).toBeCloseTo(8, 10);
    // 6/8 has two steps per beat: a step is now 0.25 s at 120 BPM.
    expect(clock.positionAt(2.5)).toBeCloseTo(10, 10);
    expect(clock.timeSignature).toEqual(SIX_EIGHT);
  });

  it('supports a tempo map for future automation', () => {
    const clock = createClock();
    clock.start(0);
    clock.setTempoMap(
      [
        { step: 0, bpm: 120 },
        { step: 8, bpm: 60 },
      ],
      1,
    );
    // The position reached under the old map is preserved (8 steps at 120 BPM = 1 s).
    expect(clock.positionAt(1)).toBeCloseTo(8, 10);
    // steps 0..8 still measured at 120 BPM, steps 8..12 at 60 BPM.
    expect(clock.secondsBetweenSteps(0, 8)).toBeCloseTo(1, 12);
    expect(clock.secondsBetweenSteps(8, 12)).toBeCloseTo(1, 12);
    expect(clock.timeAtStep(12)).toBeCloseTo(2, 12);
  });
});

describe('transport clock: loop boundaries', () => {
  it('wraps at the region end and reports the elapsed iterations', () => {
    const clock = createClock();
    clock.start(0);
    expect(clock.cycleDurationSeconds).toBeCloseTo(2, 12);

    expect(clock.syncCycles(1.9)).toBe(0);
    expect(clock.iteration).toBe(0);
    expect(clock.syncCycles(2)).toBe(1);
    expect(clock.iteration).toBe(1);
    expect(clock.positionAt(2)).toBeCloseTo(0, 12);
    expect(clock.positionAt(3)).toBeCloseTo(8, 12);
  });

  it('skips several wraps after a long stall without drifting', () => {
    const clock = createClock();
    clock.start(0);
    expect(clock.syncCycles(21.5)).toBe(10);
    expect(clock.iteration).toBe(10);
    expect(clock.snapshot(21.5).cycleStartTime).toBeCloseTo(20, 10);
    expect(clock.positionAt(21.5)).toBeCloseTo(12, 10);
    expect(clock.syncCycles(21.5)).toBe(0);
  });

  it('keeps cycle timing exact over many wraps', () => {
    const clock = createClock();
    clock.start(0);
    let now = 0;
    for (let index = 0; index < 500; index += 1) {
      now += 2;
      expect(clock.syncCycles(now)).toBe(1);
    }
    expect(clock.iteration).toBe(500);
    expect(clock.snapshot(now).cycleStartTime).toBeCloseTo(1000, 6);
  });

  it('exposes cycle timing for the scheduler across a boundary', () => {
    const clock = createClock();
    clock.start(0);
    const cycle = clock.advanceTo(0.5);
    expect(cycle).toMatchObject({ iteration: 0, startStep: 0, endStep: 16, startTime: 0 });
    expect(clock.timeForStep(cycle, 4)).toBeCloseTo(0.5, 12);

    const next = clock.advanceCycle(cycle);
    expect(next.iteration).toBe(1);
    expect(next.startTime).toBeCloseTo(2, 12);
    // The last step of a cycle and the first step of the next are one step apart.
    expect(clock.timeForStep(next, 0) - clock.timeForStep(cycle, 15)).toBeCloseTo(0.125, 12);
  });

  it('honours a loop region that does not start at step 0', () => {
    const clock = createClock({ loop: { enabled: true, startStep: 8, endStep: 16 } });
    clock.start(0);
    expect(clock.parkedPositionSteps).toBe(8);
    expect(clock.cycleDurationSeconds).toBeCloseTo(1, 12);
    clock.advanceTo(1.5);
    expect(clock.iteration).toBe(1);
    expect(clock.positionAt(1.5)).toBeCloseTo(12, 12);
    const cycle = clock.advanceTo(1.5);
    expect(clock.timeForStep(cycle, 8)).toBeCloseTo(1, 12);
  });

  it('never wraps while looping is disabled', () => {
    const clock = createClock({ loop: { enabled: false, startStep: 0, endStep: 16 } });
    clock.start(0);
    expect(clock.cycleDurationSeconds).toBe(Number.POSITIVE_INFINITY);
    expect(clock.syncCycles(100)).toBe(0);
    expect(clock.positionAt(100)).toBeCloseTo(800, 6);
  });

  it('changing the loop region clamps the position and restarts the iteration count', () => {
    const clock = createClock();
    clock.start(0);
    clock.advanceTo(1);
    clock.setLoop({ startStep: 4, endStep: 8 }, 1);
    expect(clock.parkedPositionSteps).toBe(8);
    clock.setLoop({ startStep: 2, endStep: 4 }, 1);
    expect(clock.parkedPositionSteps).toBe(4);
    expect(clock.cycleDurationSeconds).toBeCloseTo(0.25, 12);
  });
});

describe('transport clock: snapshots', () => {
  it('reports status, position, loop, and tempo together', () => {
    const clock = createClock();
    clock.start(0);
    clock.advanceTo(0.5);
    const snapshot = clock.snapshot(0.5);
    expect(snapshot).toMatchObject({
      status: 'playing',
      iteration: 0,
      tempoBpm: 120,
      timeSignature: FOUR_FOUR,
      loop: { enabled: true, startStep: 0, endStep: 16 },
    });
    expect(snapshot.positionSteps).toBeCloseTo(4, 10);
    expect(snapshot.secondsPerStepNow).toBeCloseTo(0.125, 12);
    expect(snapshot.cycleDurationSeconds).toBeCloseTo(2, 12);
  });

  it('treats a zero-length region as non-wrapping', () => {
    const clock = createClock({ loop: { enabled: true, startStep: 8, endStep: 8 } });
    clock.start(0);
    expect(clock.cycleDurationSeconds).toBe(0);
    expect(clock.syncCycles(50)).toBe(0);
  });
});


describe('transport edits after a timer stall', () => {
  it('pauses at the wrapped position even if no scheduler tick synchronized the latest loop', () => {
    const clock = createClock();
    clock.start(0);
    clock.pause(4.5);
    expect(clock.parkedPositionSteps).toBe(4);
    expect(clock.iteration).toBe(2);
    clock.resume(10);
    expect(clock.positionAt(10)).toBe(4);
  });
  it('tempo changes preserve the wrapped musical position after an unsynchronized loop boundary', () => {
    const clock = createClock();
    clock.start(0);
    clock.setTempo(60, 2.5);
    expect(clock.positionAt(2.5)).toBe(4);
    expect(clock.positionAt(3)).toBe(6);
  });
});
