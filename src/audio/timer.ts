/**
 * Lookahead timer for the scheduler.
 *
 * The timer only decides *how far ahead* to schedule; it never decides *when* a sound occurs
 * (that always comes from `AudioContext.currentTime`). Chrome throttles `setInterval` to once
 * per second in background tabs, which would starve a 100 ms lookahead window, so a Worker
 * timer is preferred with an interval fallback.
 */

export interface RepeatingTimer {
  /** Start invoking `callback` every `intervalMs` milliseconds. */
  start(callback: () => void, intervalMs: number): void;
  stop(): void;
  dispose(): void;
  readonly kind: 'worker' | 'interval';
}

const WORKER_SOURCE = `
let handle = null;
self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === 'start') {
    if (handle !== null) clearInterval(handle);
    handle = setInterval(() => self.postMessage('tick'), Math.max(4, data.intervalMs || 25));
  } else if (data.type === 'stop') {
    if (handle !== null) clearInterval(handle);
    handle = null;
  }
};
`;

export function createIntervalTimer(): RepeatingTimer {
  let handle: ReturnType<typeof setInterval> | null = null;
  return {
    kind: 'interval',
    start(callback, intervalMs) {
      this.stop();
      handle = setInterval(callback, Math.max(4, intervalMs));
    },
    stop() {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
    },
    dispose() {
      this.stop();
    },
  };
}

/** Worker-based timer. Returns null when Workers or blob URLs are unavailable. */
export function createWorkerTimer(): RepeatingTimer | null {
  if (typeof Worker === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  let worker: Worker | null = null;
  let objectUrl: string | null = null;
  let callback: (() => void) | null = null;

  return {
    kind: 'worker',
    start(nextCallback, intervalMs) {
      this.stop();
      try {
        objectUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        worker = new Worker(objectUrl);
        worker.onmessage = () => {
          if (callback) callback();
        };
        worker.onerror = () => {
          // A blocked worker must never take playback down with it.
          this.stop();
        };
        callback = nextCallback;
        worker.postMessage({ type: 'start', intervalMs: Math.max(4, intervalMs) });
      } catch {
        this.stop();
      }
    },
    stop() {
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        worker = null;
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      callback = null;
    },
    dispose() {
      this.stop();
    },
  };
}

export interface FallbackTimer extends RepeatingTimer {
  readonly active: RepeatingTimer;
}

/**
 * Worker timer when available, otherwise the interval timer. If the worker dies at runtime the
 * caller can inspect `active` and fall back; playback correctness never depends on which one runs.
 */
export function createBestAvailableTimer(): FallbackTimer {
  const worker = createWorkerTimer();
  const interval = createIntervalTimer();
  const chosen = worker ?? interval;
  return {
    kind: chosen.kind,
    get active() {
      return chosen;
    },
    start(callback, intervalMs) {
      chosen.start(callback, intervalMs);
    },
    stop() {
      chosen.stop();
    },
    dispose() {
      chosen.dispose();
    },
  };
}
