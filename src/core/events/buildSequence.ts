import type { Project, TimeSignature } from '../project/model';
import { ticksToSteps } from '../time/ticks';
import { ArrangementEventSource } from './arrangementEventSource';
import type { MusicalEvent } from './musicalEvents';

export interface SequenceBuildOptions {
  timeSignature: TimeSignature;
  startStep?: number;
  endStep?: number;
  defaultStepVelocity?: number;
}

/**
 * Convenience expansion for tests/offline consumers. Live playback uses ArrangementEventSource
 * directly and never builds or queues the entire song. A bounded expansion also chases sustains
 * at its start, with the scheduler responsible for converting them to remaining audio durations.
 */
export function buildPlaylistEvents(project: Project, options: SequenceBuildOptions): MusicalEvent[] {
  const source = new ArrangementEventSource(project, options.timeSignature, options.defaultStepVelocity);
  const endStep = Number.isFinite(options.endStep)
    ? Math.max(0, options.endStep as number)
    : Math.max(0, ...project.playlist.map((clip) => ticksToSteps(clip.startTick + clip.durationTicks)));
  return source.queryWindow({ startStep: options.startStep ?? 0, endStep, includeSustains: options.startStep !== undefined }).map((event) => {
    if (event.kind === 'sample') return event;
    return { ...event, durationSteps: Math.min(event.durationSteps, endStep - event.step) };
  });
}

export function getSequenceEndStep(events: readonly MusicalEvent[]): number {
  return events.reduce((end, event) => Math.max(end, event.step + (event.kind === 'sample' ? 1 : event.durationSteps)), 0);
}
