import { barsToSteps, stepsPerBeat } from '../time/musicalTime';
import { DEFAULT_STEP_VELOCITY, type Project, type TimeSignature } from '../project/model';
import { sortMusicalEvents, type MusicalEvent, type NoteEvent, type SampleTriggerEvent } from './musicalEvents';

/**
 * Translate project data into a flat, time-ordered musical event list.
 *
 * This is the only place where the project model is interpreted for playback; the audio layer
 * receives plain events and knows nothing about patterns, clips, or channels.
 *
 * Rules:
 *  - Playlist clips place their pattern at `startBar`; the pattern repeats to fill `lengthBars`
 *    and is truncated at the clip end.
 *  - Drum channels and channels with a loaded sample contribute one-shot sample triggers;
 *    every channel contributes its piano-roll notes.
 *  - Muted channels contribute nothing. When any channel is soloed, only soloed, unmuted
 *    channels contribute.
 *  - Step velocities come from the pattern's serializable velocity rows.
 *  - Swing delays the offbeat step of every beat by up to one third of a step (full swing =
 *    triplet feel), so events keep integer grid positions only when swing is 0.
 *  - Events outside `[0, endStep)` are dropped so the loop region always defines playback.
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

function clampSwing(value: number | undefined): number {
  if (!Number.isFinite(value as number)) return 0;
  return Math.min(1, Math.max(0, value as number));
}

/**
 * Build the playback event list for a project.
 */
export function buildPlaylistEvents(project: Project, options: SequenceBuildOptions): MusicalEvent[] {
  const endStep = Number.isFinite(options.endStep) ? Math.max(0, options.endStep as number) : Number.POSITIVE_INFINITY;
  const defaultVelocity = clipVelocity(options.defaultStepVelocity ?? DEFAULT_STEP_VELOCITY);
  const swing = clampSwing(project.settings.swing);

  // Swing grid: within every beat, the second half of the beat is delayed. Full swing moves it
  // from 0.5 to 2/3 of the beat (triplet feel), i.e. by one sixth of a beat.
  const stepsPerBeatValue = stepsPerBeat(options.timeSignature);
  const swingStride = stepsPerBeatValue >= 2 ? stepsPerBeatValue : 2;
  const swingDelay = (swing * stepsPerBeatValue) / 6;
  const swingOffset = (step: number): number => {
    if (swingDelay <= 0) return 0;
    const phase = ((step % swingStride) + swingStride) % swingStride;
    return phase === swingStride / 2 ? swingDelay : 0;
  };

  const events: MusicalEvent[] = [];
  const patternsById = new Map(project.patterns.map((pattern) => [pattern.id, pattern]));
  const clips = [...project.playlist].sort((a, b) => a.startBar - b.startBar || (a.id < b.id ? -1 : 1));

  const soloActive = project.channels.some((channel) => channel.solo === true);
  const audibleChannels = new Set(
    project.channels
      .filter((channel) => channel.muted !== true && (!soloActive || channel.solo === true))
      .map((channel) => channel.id),
  );

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
        if (!audibleChannels.has(channel.id)) continue;

        const steps = pattern.steps[channel.id];
        const isSampleChannel = channel.kind === 'drum' || Boolean(channel.sampleId);
        if (isSampleChannel && steps) {
          const velocityRow = pattern.velocities[channel.id];
          for (let step = 0; step < Math.min(steps.length, patternLength); step += 1) {
            if (!steps[step]) continue;
            const gridStep = baseStep + step;
            const event: SampleTriggerEvent = {
              kind: 'sample',
              id: `${clip.id}:${offset}:${channel.id}:${step}`,
              step: gridStep,
              patternId: clip.patternId,
              channelId: channel.id,
              sampleId: channel.sampleId ?? channel.id,
              velocity: clipVelocity(velocityRow?.[step] ?? defaultVelocity),
            };
            if (gridStep >= clipStartStep && gridStep < Math.min(clipEndStep, endStep)) {
              events.push({ ...event, step: gridStep + swingOffset(gridStep) });
            }
          }
        }

        const notes = pattern.notes[channel.id];
        if (notes) {
          for (const note of notes) {
            const gridStep = baseStep + note.startStep;
            const event: NoteEvent = {
              kind: 'note',
              id: `${clip.id}:${offset}:${note.id}`,
              step: gridStep,
              patternId: clip.patternId,
              channelId: channel.id,
              pitch: note.pitch,
              velocity: clipVelocity(note.velocity),
              durationSteps: Math.max(1, note.durationSteps),
            };
            if (gridStep >= clipStartStep && gridStep < Math.min(clipEndStep, endStep)) {
              events.push({ ...event, step: gridStep + swingOffset(gridStep) });
            }
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
