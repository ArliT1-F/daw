import { isTrackAudible } from '../arrangement/arrangement';
import { DEFAULT_STEP_VELOCITY, type Pattern, type PlaylistClip, type Project, type TimeSignature } from '../project/model';
import { stepsPerBeat } from '../time/musicalTime';
import { ticksToSteps } from '../time/ticks';
import { sortMusicalEvents, type MusicalEvent, type MusicalEventSource, type MusicalEventWindow } from './musicalEvents';

function velocity(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_STEP_VELOCITY;
}

/** Compile only one repeat per source. Instance placement and repeat expansion happen per window. */
export function buildPatternEvents(project: Project, pattern: Pattern, signature = project.settings.timeSignature, defaultVelocity = DEFAULT_STEP_VELOCITY): MusicalEvent[] {
  const events: MusicalEvent[] = [];
  const beat = stepsPerBeat(signature);
  const stride = Math.max(2, beat);
  const swing = Math.min(1, Math.max(0, project.settings.swing || 0));
  const swingOffset = (step: number) => step % stride === stride / 2 ? swing * beat / 6 : 0;
  const anySolo = project.channels.some((channel) => channel.solo);
  for (const channel of project.channels) {
    if (channel.muted || (anySolo && !channel.solo)) continue;
    if (channel.kind === 'drum' || channel.sampleId) {
      const steps = pattern.steps[channel.id] ?? [];
      for (let index = 0; index < Math.min(steps.length, pattern.lengthSteps); index += 1) {
        const step = index + swingOffset(index);
        if (!steps[index] || step >= pattern.lengthSteps) continue;
        events.push({
          kind: 'sample', id: JSON.stringify(['sample', channel.id, index]), step, patternId: pattern.id,
          channelId: channel.id, sampleId: channel.sampleId ?? channel.id,
          velocity: velocity(pattern.velocities[channel.id]?.[index] ?? defaultVelocity),
        });
      }
    }
    for (const note of pattern.notes[channel.id] ?? []) {
      const start = ticksToSteps(note.startTick);
      const step = start + swingOffset(start);
      const durationSteps = Math.min(ticksToSteps(Math.max(1, note.durationTicks)), pattern.lengthSteps - step);
      if (step < 0 || durationSteps <= 0) continue;
      events.push({
        kind: 'note', id: JSON.stringify(['note', channel.id, note.id]), step, patternId: pattern.id, channelId: channel.id,
        pitch: note.pitch, velocity: velocity(note.velocity), durationSteps,
      });
    }
  }
  return sortMusicalEvents(events);
}

interface IndexedClip {
  clip: PlaylistClip;
  start: number;
  end: number;
}

/**
 * Immutable, indexed arrangement snapshot. Construction does not expand a song into events.
 * Query cost depends on intersecting clips and repeats in the requested playback window, not
 * the song length. Overlaps mix additively; event identity is per clip/channel/repeat, never per
 * pattern alone. Prefix maximum ends keep long, overlapping instances visible to range queries.
 */
export class ArrangementEventSource implements MusicalEventSource {
  private readonly clips: IndexedClip[];
  private readonly prefixEnds: number[];
  private readonly patterns: Map<string, Pattern>;
  private readonly templates = new Map<string, MusicalEvent[]>();
  private readonly assets: Map<string, Project['audioAssets'][number]>;

  constructor(project: Project, signature: TimeSignature = project.settings.timeSignature, defaultVelocity?: number) {
    this.patterns = new Map(project.patterns.map((pattern) => [pattern.id, pattern]));
    this.assets = new Map(project.audioAssets.map((asset) => [asset.id, asset]));
    this.clips = project.playlist.filter((clip) => isTrackAudible(project, clip.trackId)).map((clip) => ({
      clip, start: ticksToSteps(clip.startTick), end: ticksToSteps(clip.startTick + clip.durationTicks),
    })).sort((a, b) => a.start - b.start || a.clip.id.localeCompare(b.clip.id));
    let maximum = 0;
    this.prefixEnds = this.clips.map((item) => (maximum = Math.max(maximum, item.end)));
    for (const clip of this.clips) {
      if (clip.clip.kind !== 'pattern' || this.templates.has(clip.clip.patternId)) continue;
      const pattern = this.patterns.get(clip.clip.patternId);
      if (pattern) this.templates.set(pattern.id, buildPatternEvents(project, pattern, signature, defaultVelocity));
    }
  }

  queryWindow({ startStep, endStep, includeSustains = false }: MusicalEventWindow): MusicalEvent[] {
    if (!Number.isFinite(startStep) || !Number.isFinite(endStep) || endStep <= startStep) return [];
    const from = Math.max(0, startStep);
    const result: MusicalEvent[] = [];
    let low = 0;
    let high = this.prefixEnds.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.prefixEnds[middle] <= from) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.clips.length && this.clips[index].start < endStep; index += 1) {
      const { clip, start, end } = this.clips[index];
      if (end <= from) continue;
      if (clip.kind === 'audio') {
        const asset = this.assets.get(clip.assetId);
        if (!asset || (start < from && !includeSustains)) continue;
        result.push({
          kind: 'audio', id: JSON.stringify(['audio', clip.id]), clipId: clip.id, trackId: clip.trackId,
          channelId: `audio:${clip.trackId}`, step: start, endStep: end, assetId: clip.assetId,
          sourceOffsetSeconds: clip.sourceOffsetSeconds, sourceDurationSeconds: asset.durationSeconds,
          durationSteps: end - start, velocity: clip.gain,
        });
        continue;
      }
      const pattern = this.patterns.get(clip.patternId);
      const templates = this.templates.get(clip.patternId);
      if (!pattern || !templates || pattern.lengthSteps <= 0) continue;
      const length = pattern.lengthSteps;
      const base = start - (ticksToSteps(clip.sourceOffsetTicks) % length);
      // A preceding repeat can contain a held note at the trim/seek/loop entry.
      const first = Math.max(0, Math.floor((from - base) / length) - 1);
      const last = Math.floor((Math.min(end, endStep) - base) / length);
      for (let repeat = first; repeat <= last; repeat += 1) {
        const origin = base + repeat * length;
        for (const template of templates) {
          const onset = origin + template.step;
          const common = { id: JSON.stringify(['pattern', clip.id, clip.patternId, repeat, template.id]), clipId: clip.id, trackId: clip.trackId, endStep: end };
          if (template.kind === 'sample') {
            if (onset >= Math.max(start, from) && onset < Math.min(end, endStep)) result.push({ ...template, ...common, step: onset });
          } else if (template.kind === 'note') {
            const step = Math.max(start, onset);
            const noteEnd = Math.min(end, onset + template.durationSteps);
            if (noteEnd <= step || step >= endStep) continue;
            if (step >= from || (includeSustains && noteEnd > from)) {
              result.push({ ...template, ...common, step, durationSteps: noteEnd - step });
            }
          }
        }
      }
    }
    return sortMusicalEvents(result);
  }
}
