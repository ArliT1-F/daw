import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntervalTimer, createWorkerTimer } from './timer';

describe('scheduler timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('repeats on the requested interval and stops cleanly', () => {
    const timer = createIntervalTimer();
    const callback = vi.fn();
    timer.start(callback, 25);

    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(4);

    timer.stop();
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(4);

    timer.dispose();
    expect(timer.kind).toBe('interval');
  });

  it('restarting replaces the previous timer instead of stacking them', () => {
    const timer = createIntervalTimer();
    const first = vi.fn();
    const second = vi.fn();
    timer.start(first, 25);
    timer.start(second, 25);

    vi.advanceTimersByTime(50);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('falls back to null when workers are unavailable', () => {
    // Node has no Worker global or blob URL support, so the worker timer cannot be built here.
    expect(createWorkerTimer()).toBeNull();
  });
});
