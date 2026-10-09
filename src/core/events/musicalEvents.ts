/**
 * Musical event data.
 *
 * Events are plain, serializable descriptions of *what should sound and when*, expressed in
 * sixteenth-note steps. They never hold Web Audio nodes, so the same data can be scheduled by
 * the browser engine, rendered offline, or asserted in tests.
 */

export type MusicalEventKind = 'sample' | 'note';

/** One-shot percussion/sample trigger. */
export interface SampleTriggerEvent {
  readonly kind: 'sample';
  readonly id: string;
  /** Position within the loop, in sixteenth-note steps (fractional when swung). */
  readonly step: number;
  /** Pattern this event came from, when it was built from project data. */
  readonly patternId?: string;
  readonly channelId: string;
  /** Sample asset id. Falls back to a synthesized placeholder voice when unloaded. */
  readonly sampleId: string;
  /** 0..1 */
  readonly velocity: number;
}

/** Sustained pitched event. The same shape is used for future MIDI instrument output. */
export interface NoteEvent {
  readonly kind: 'note';
  readonly id: string;
  /** Fractional when swung. */
  readonly step: number;
  readonly patternId?: string;
  readonly channelId: string;
  /** MIDI note number, 0..127. */
  readonly pitch: number;
  readonly velocity: number;
  readonly durationSteps: number;
}

export type MusicalEvent = SampleTriggerEvent | NoteEvent;

/** An event resolved onto the audio clock. */
export interface ScheduledEventTiming {
  readonly event: MusicalEvent;
  /** Absolute AudioContext time in seconds. */
  readonly time: number;
  /** Sustained length in seconds; 0 for one-shot triggers. */
  readonly durationSeconds: number;
  /** Loop iteration this event belongs to. */
  readonly iteration: number;
}

/**
 * Receives scheduled events. Implemented by the audio engine today; a MIDI output or an
 * offline renderer can implement it later without changing the scheduler.
 */
export interface MusicalEventSink {
  scheduleEvent(timing: ScheduledEventTiming): void;
  /** Drop events that were scheduled but have not started sounding yet. */
  cancelPendingFrom(time: number): void;
  /** Cut everything that is sounding at `time` with a short fade. */
  releaseAll(atTime: number): void;
}

const KIND_ORDER: Record<MusicalEventKind, number> = { sample: 0, note: 1 };

/** Stable ordering by step, then kind, then id, so scheduling is deterministic. */
export function sortMusicalEvents(events: readonly MusicalEvent[]): MusicalEvent[] {
  return [...events].sort((a, b) => {
    if (a.step !== b.step) return a.step - b.step;
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** First index whose step is at or after `step`; `events.length` when none exists. */
export function firstEventIndexAtOrAfter(events: readonly MusicalEvent[], step: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle].step < step) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function isSampleTrigger(event: MusicalEvent): event is SampleTriggerEvent {
  return event.kind === 'sample';
}

export function isNoteEvent(event: MusicalEvent): event is NoteEvent {
  return event.kind === 'note';
}
