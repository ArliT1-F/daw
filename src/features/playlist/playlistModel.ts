import type { PlaylistClip, PlaylistLoop, Project, TimeSignature } from '../../core/project/model';
import { getProjectTempoMap } from '../../core/arrangement/arrangement';
import { quantizeTicks, secondsAtTick, tickAtSeconds, ticksPerBar, ticksPerBeat, TICKS_PER_STEP } from '../../core/time/ticks';

export const TRACK_HEADER_WIDTH = 156;
export const PLAYLIST_RULER_HEIGHT = 30;
export const LOOP_LANE_HEIGHT = 22;
export const CLIP_SLOT_HEIGHT = 34;
export const DEFAULT_PX_PER_BEAT = 24;
export const PLAYLIST_SNAP_OPTIONS = [
  { id: 'bar', label: 'Bar' }, { id: 'beat', label: 'Beat' }, { id: 'step', label: '1/16' },
  { id: 'half-step', label: '1/32' }, { id: 'triplet', label: '1/16 T' }, { id: 'off', label: 'Off (1 tick)' },
] as const;

export function playlistSnapTicks(id: string, signature: TimeSignature): number {
  switch (id) {
    case 'bar': return ticksPerBar(signature);
    case 'beat': return ticksPerBeat(signature);
    case 'half-step': return TICKS_PER_STEP / 2;
    case 'triplet': return TICKS_PER_STEP * 2 / 3;
    case 'off': return 1;
    default: return TICKS_PER_STEP;
  }
}

export function tickToPlaylistX(tick: number, pxPerBeat: number, signature: TimeSignature): number {
  return tick * pxPerBeat / ticksPerBeat(signature);
}

export function playlistXToTick(x: number, pxPerBeat: number, signature: TimeSignature): number {
  return Math.round(x * ticksPerBeat(signature) / pxPerBeat);
}

export function clampPlaylistZoom(value: number): number {
  return Math.max(12, Math.min(144, value));
}

/** Keep relative musical and lane offsets; clamp the group, never its members independently. */
export function translateClips(project: Project, clips: readonly PlaylistClip[], deltaTick: number, deltaTrack = 0): PlaylistClip[] {
  if (!clips.length) return [];
  const dt = Math.max(Math.round(deltaTick), -Math.min(...clips.map((clip) => clip.startTick)));
  const indices = clips.map((clip) => project.tracks.findIndex((track) => track.id === clip.trackId));
  const dy = Math.max(-Math.min(...indices), Math.min(Math.round(deltaTrack), project.tracks.length - 1 - Math.max(...indices)));
  return clips.map((clip, index) => ({ ...clip, startTick: clip.startTick + dt, trackId: project.tracks[indices[index] + dy].id }));
}

/** Left trim advances the instance's source; right resize repeats patterns, never stretches audio. */
export function resizeClips(project: Project, clips: readonly PlaylistClip[], edge: 'start' | 'end', deltaTick: number): PlaylistClip[] {
  if (!clips.length) return [];
  const map = getProjectTempoMap(project);
  const signature = project.settings.timeSignature;
  let lower = edge === 'start' ? -Math.min(...clips.map((clip) => clip.startTick)) : 1 - Math.min(...clips.map((clip) => clip.durationTicks));
  let upper = edge === 'start' ? Math.min(...clips.map((clip) => clip.durationTicks - 1)) : Number.MAX_SAFE_INTEGER;
  if (edge === 'start') {
    for (const clip of clips) {
      if (clip.kind !== 'audio') continue;
      const asset = project.audioAssets.find((item) => item.id === clip.assetId);
      const startSeconds = secondsAtTick(map, signature, clip.startTick);
      const earliest = tickAtSeconds(map, signature, Math.max(0, startSeconds - clip.sourceOffsetSeconds));
      const latest = tickAtSeconds(map, signature, startSeconds + (asset?.durationSeconds ?? 0) - clip.sourceOffsetSeconds) - 1;
      lower = Math.max(lower, earliest - clip.startTick);
      upper = Math.min(upper, latest - clip.startTick);
    }
  }
  const dt = Math.max(lower, Math.min(Math.round(deltaTick), upper));
  return clips.map((clip) => {
    if (edge === 'end') return { ...clip, durationTicks: clip.durationTicks + dt };
    const startTick = clip.startTick + dt;
    const durationTicks = clip.durationTicks - dt;
    if (clip.kind === 'pattern') {
      const length = (project.patterns.find((item) => item.id === clip.patternId)?.lengthSteps ?? 16) * TICKS_PER_STEP;
      return { ...clip, startTick, durationTicks, sourceOffsetTicks: ((clip.sourceOffsetTicks + dt) % length + length) % length };
    }
    const elapsed = secondsAtTick(map, signature, startTick) - secondsAtTick(map, signature, clip.startTick);
    return { ...clip, startTick, durationTicks, sourceOffsetSeconds: Math.max(0, clip.sourceOffsetSeconds + elapsed) };
  });
}

export function duplicateClips(clips: readonly PlaylistClip[], deltaTick: number, id: () => string): PlaylistClip[] {
  return clips.map((clip) => ({ ...clip, id: id(), startTick: clip.startTick + Math.round(deltaTick) }));
}

export function clipGroupSpan(clips: readonly PlaylistClip[]): number {
  return clips.length ? Math.max(...clips.map((clip) => clip.startTick + clip.durationTicks)) - Math.min(...clips.map((clip) => clip.startTick)) : 0;
}

/** Greedy interval coloring: overlapping instances remain individually visible/editable. */
export function layoutClipSlots(clips: readonly PlaylistClip[]): { slots: Map<string, number>; count: number } {
  const ends: number[] = [];
  const slots = new Map<string, number>();
  for (const clip of [...clips].sort((a, b) => a.startTick - b.startTick || a.id.localeCompare(b.id))) {
    let slot = ends.findIndex((end) => end <= clip.startTick);
    if (slot < 0) slot = ends.length;
    ends[slot] = clip.startTick + clip.durationTicks;
    slots.set(clip.id, slot);
  }
  return { slots, count: Math.max(1, ends.length) };
}

export function editLoop(loop: PlaylistLoop, edge: 'start' | 'end' | 'move', deltaTick: number, minimum = 1): PlaylistLoop {
  if (edge === 'move') {
    const dt = Math.max(-loop.startTick, Math.round(deltaTick));
    return { ...loop, startTick: loop.startTick + dt, endTick: loop.endTick + dt };
  }
  if (edge === 'start') return { ...loop, startTick: Math.max(0, Math.min(loop.endTick - minimum, loop.startTick + Math.round(deltaTick))) };
  return { ...loop, endTick: Math.max(loop.startTick + minimum, loop.endTick + Math.round(deltaTick)) };
}

export function snapPlaylistTick(tick: number, grid: number): number {
  return Math.max(0, quantizeTicks(tick, grid));
}
