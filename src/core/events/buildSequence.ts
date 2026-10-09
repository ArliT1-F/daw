import { barsToSteps } from '../time/musicalTime';
import type { Project, TimeSignature } from '../project/model';
import { sortMusicalEvents, type MusicalEvent, type NoteEvent, type SampleTriggerEvent } from './musicalEvents';

/**
 * Translate project data into a flat, time-ordered musical event list.
 *
 * This is the only place where the project model is interpreted for playback; the audio layer
 * receives plain events and knows nothing about patterns, clips, or channels.
 */

export interface SequenceBuildOptions {
  timeSignature: TimeSignature;
  /**
   * Playback region. Events at or after this step are outside the arrangement and are dropped.
   * Omit to keep every event.
   */
  endStep?: number;
  /** Velocity applied to step-sequencer triggers when the model has no velocity data. */
  defaultStepVelocity?: number;
}

function clipVelocity(value: number): number {
  if (!Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0, value));
}

/**
 * Build the playback event list for a project.
 *
 * Rules:
 *  - Playlist clips place their pattern at `startBar`; the pattern repeats to fill `lengthBars`
 *    and is truncated at the clip end.
 *  - Drum channels contribute one-shot sample triggers; instrument channels contribute notes.
 *  - Events outside `[0, endStep)` are dropped so the loop region always defines playback.
 */
export function buildPlaylistEvents(project: Project, options: SequenceBuildOptions): MusicalEvent[] {
  const endStep = Number.isFinite(options.endStep) ? Math.max(0, options.endStep as number) : Number.POSITIVE_INFINITY;
  const defaultVelocity = clipVelocity(options.defaultStepVelocity ?? 0.85);
  const events: MusicalEvent[] = [];
  const patternsById = new Map(project.patterns.map((pattern) => [pattern.id, pattern]));
  const clips = [...project.playlist].sort((a, b) => a.startBar - b.startBar || (a.id < b.id ? -1 : 1));

  for (const clip of clips) {
    const pattern = patternsById.get(clip.patternId);
    if (!pattern || clip.lengthBars < 1) continue;

    const clipStartStep = barsToSteps(clip.startBar, options.timeSignature);
    const clipLengthSteps = barsToSteps(clip.lengthBars, options.timeSignature);
    const clipEndStep = clipStartStep + clipLengthSteps;
    const patternLength = Math.max(1, pattern.lengthSteps);

    for (let offset = 0; offset < clipLengthSteps; offset += patternLength) {
      const baseStep = clipStartStep + offset;

      for (const channel of project.channels) {
        const steps = pattern.steps[channel.id];
        if (channel.kind === 'drum' && steps) {
          for (let step = 0; step < Math.min(steps.length, patternLength); step += 1) {
            if (!steps[step]) continue;
            const event: SampleTriggerEvent = {
              kind: 'sample',
              id: `${clip.id}:${offset}:${channel.id}:${step}`,
              step: baseStep + step,
              channelId: channel.id,
              sampleId: channel.id,
              velocity: defaultVelocity,
            };
            if (event.step >= clipStartStep && event.step < Math.min(clipEndStep, endStep)) events.push(event);
          }
        }

        const notes = pattern.notes[channel.id];
        if (notes) {
          for (const note of notes) {
            const event: NoteEvent = {
              kind: 'note',
              id: `${clip.id}:${offset}:${note.id}`,
              step: baseStep + note.startStep,
              channelId: channel.id,
              pitch: note.pitch,
              velocity: clipVelocity(note.velocity),
              durationSteps: Math.max(1, note.durationSteps),
            };
            if (event.step >= clipStartStep && event.step < Math.min(clipEndStep, endStep)) events.push(event);
          }
        }
      }
    }
  }

  return sortMusicalEvents(events);
}

/** The last step that contains musical content, plus one step of tail room. */
export function getSequenceEndStep(events: readonly MusicalEvent[]): number {
  let end = 0;
  for (const event of events) {
    const length = event.kind === 'note' ? event.durationSteps : 1;
    end = Math.max(end, event.step + length);
  }
  return end;
}
