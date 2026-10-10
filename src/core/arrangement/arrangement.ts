import { createStableId, MASTER_MIXER_CHANNEL_ID, type PatternClip, type PlaylistClip, type PlaylistTrack, type Project } from '../project/model';
import { secondsAtTick, tickAtSeconds, ticksPerBar, ticksToSteps, TICKS_PER_STEP } from '../time/ticks';
import type { TempoMap } from '../time/musicalTime';

export const TRACK_COLORS = ['#9992e8', '#79c8b8', '#e6a75c', '#e67872', '#7fa8d8', '#b98bd9'];

/**
 * A new Playlist track. Audio clips on the track are routed to `mixerChannelId`; pass
 * `defaultMixerDestination(project)` from the UI to give the track a real insert fader.
 */
export function createPlaylistTrack(
  name: string,
  index = 0,
  id = createStableId('track'),
  mixerChannelId = MASTER_MIXER_CHANNEL_ID,
): PlaylistTrack {
  return { id, name, color: TRACK_COLORS[index % TRACK_COLORS.length], muted: false, solo: false, mixerChannelId };
}

/**
 * Identity of the arrangement-affecting part of a project.
 *
 * The engine retires sounding voices and refills its lookahead window whenever the arrangement
 * changes, so this signature deliberately excludes everything that cannot change a generated
 * event: display names and colours, mixer fader/pan/mute/solo state, and mixer routing. Moving a
 * fader must never cut a held note.
 */
export function arrangementSignature(project: Project): string {
  return JSON.stringify([
    project.settings.tempo,
    project.settings.timeSignature,
    project.settings.swing,
    project.settings.tempoChanges,
    project.settings.loop,
    project.channels.map((channel) => [channel.id, channel.kind, channel.muted, channel.solo, channel.sampleId ?? null]),
    project.patterns.map((pattern) => [pattern.id, pattern.lengthSteps, pattern.steps, pattern.velocities, pattern.notes]),
    project.tracks.map((track) => [track.id, track.muted, track.solo]),
    project.audioAssets.map((asset) => [asset.id, asset.durationSeconds]),
    project.playlist.map((clip) => [
      clip.id, clip.kind, clip.trackId, clip.startTick, clip.durationTicks,
      clip.kind === 'pattern' ? [clip.patternId, clip.sourceOffsetTicks] : [clip.assetId, clip.sourceOffsetSeconds, clip.gain],
    ]),
  ]);
}

export function getProjectTempoMap(project: Project): TempoMap {
  return [{ step: 0, bpm: project.settings.tempo }, ...project.settings.tempoChanges.map((change) => ({ step: ticksToSteps(change.tick), bpm: change.bpm }))];
}

/** The song can grow independently of the saved loop and the horizontally-scrolled viewport. */
export function getSongEndTick(project: Project): number {
  return project.playlist.reduce((endTick, clip) => Math.max(endTick, clip.startTick + clip.durationTicks), ticksPerBar(project.settings.timeSignature));
}

export function getPlaybackRegion(project: Project): { enabled: boolean; startStep: number; endStep: number } {
  const loop = project.settings.loop;
  return {
    enabled: loop.enabled,
    startStep: loop.enabled ? ticksToSteps(loop.startTick) : 0,
    endStep: ticksToSteps(loop.enabled ? loop.endTick : getSongEndTick(project)),
  };
}

export function clipDisplayName(project: Project, clip: PlaylistClip): string {
  return clip.name ?? (clip.kind === 'pattern'
    ? project.patterns.find((pattern) => pattern.id === clip.patternId)?.name
    : project.audioAssets.find((asset) => asset.id === clip.assetId)?.name) ?? 'Missing source';
}

/** Duration for an imported native-speed source, integrated over any song tempo changes. */
export function audioDurationTicks(project: Project, startTick: number, durationSeconds: number): number {
  const map = getProjectTempoMap(project);
  const end = tickAtSeconds(map, project.settings.timeSignature, secondsAtTick(map, project.settings.timeSignature, startTick) + durationSeconds);
  return Math.max(1, end - startTick);
}

export function isTrackAudible(project: Project, trackId: string): boolean {
  const track = project.tracks.find((item) => item.id === trackId);
  return Boolean(track && !track.muted && (!project.tracks.some((item) => item.solo) || track.solo));
}

/** Prefer the selected instance when several reusable-pattern clips overlap. */
export function findPatternClipAt(project: Project, patternId: string, songStep: number, preferredId?: string): PatternClip | null {
  const tick = songStep * TICKS_PER_STEP;
  const candidates = project.playlist.filter((clip): clip is PatternClip =>
    clip.kind === 'pattern' && clip.patternId === patternId && isTrackAudible(project, clip.trackId) && tick >= clip.startTick && tick < clip.startTick + clip.durationTicks,
  );
  return candidates.find((clip) => clip.id === preferredId) ?? candidates[0] ?? null;
}

export function patternStepAtSongPosition(project: Project, patternId: string, songStep: number, preferredId?: string): number | null {
  const clip = findPatternClipAt(project, patternId, songStep, preferredId);
  const pattern = project.patterns.find((item) => item.id === patternId);
  if (!clip || !pattern) return null;
  const length = pattern.lengthSteps * TICKS_PER_STEP;
  return ((songStep * TICKS_PER_STEP - clip.startTick + clip.sourceOffsetTicks) % length) / TICKS_PER_STEP;
}

/** Seek the current pattern repeat in its actual instance, not an unrelated song-grid repeat. */
export function songStepForPatternTick(project: Project, patternId: string, patternTick: number, songStep: number, preferredId?: string): number {
  const selected = project.playlist.find((clip): clip is PatternClip => clip.kind === 'pattern' && clip.patternId === patternId && clip.id === preferredId);
  const clip = findPatternClipAt(project, patternId, songStep, preferredId) ?? selected ?? project.playlist.find((item): item is PatternClip => item.kind === 'pattern' && item.patternId === patternId);
  const pattern = project.patterns.find((item) => item.id === patternId);
  if (!clip || !pattern) return ticksToSteps(patternTick);
  const length = pattern.lengthSteps * TICKS_PER_STEP;
  const sourceStart = clip.startTick - (clip.sourceOffsetTicks % length);
  const current = Math.max(clip.startTick, Math.min(songStep * TICKS_PER_STEP, clip.startTick + clip.durationTicks - 1));
  const repeat = Math.floor((current - sourceStart) / length);
  let target = sourceStart + repeat * length + patternTick;
  if (target < clip.startTick) target += length;
  if (target >= clip.startTick + clip.durationTicks) target -= length;
  return ticksToSteps(Math.max(clip.startTick, Math.min(clip.startTick + clip.durationTicks - 1, target)));
}
