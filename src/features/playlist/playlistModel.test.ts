import { describe, expect, it } from 'vitest';
import { createTestArrangement } from '../../core/arrangement/__fixtures__/testArrangement';
import { TICKS_PER_STEP as T } from '../../core/time/ticks';
import { audioDurationTicks, findPatternClipAt, getSongEndTick, patternStepAtSongPosition, songStepForPatternTick } from '../../core/arrangement/arrangement';
import { assertValidProject } from '../../core/project/model';
import { clampPlaylistZoom, clipGroupSpan, duplicateClips, editLoop, layoutClipSlots, playlistSnapTicks, playlistXToTick, resizeClips, tickToPlaylistX, translateClips } from './playlistModel';

const meter = { numerator: 4, denominator: 4 };

describe('Playlist editing math', () => {
  it('supports bars/beats/straight/triplet/off snapping and meter-aware pixel round-trips', () => {
    expect(['bar', 'beat', 'step', 'half-step', 'triplet', 'off'].map((id) => playlistSnapTicks(id, meter))).toEqual([384, 96, 24, 12, 16, 1]);
    const odd = { numerator: 7, denominator: 8 };
    expect(playlistSnapTicks('bar', odd)).toBe(336);
    for (const tick of [0, 1, 24, 96, 387, 8000]) expect(playlistXToTick(tickToPlaylistX(tick, 34, odd), 34, odd)).toBe(tick);
    expect(clampPlaylistZoom(1)).toBe(12);
    expect(clampPlaylistZoom(1000)).toBe(144);
  });
  it('moves mixed groups with relative time/lane offsets and clamps as a group at zero', () => {
    const project = createTestArrangement();
    const originals = project.playlist.filter((clip) => ['clip-a', 'clip-b'].includes(clip.id));
    const moved = translateClips(project, originals, -1000 * T, 0);
    expect(moved.map((clip) => clip.startTick)).toEqual([0, 8 * T]);
    expect(translateClips(project, originals, 4 * T, 5).map((clip) => clip.trackId)).toEqual(['track-main', 'track-layer']); // group already touches last track
    expect(project.playlist[0].startTick).toBe(16 * T);
  });
  it('moves clips between lanes without altering any source offset or duration', () => {
    const project = createTestArrangement();
    const clip = project.playlist[0];
    expect(translateClips(project, [clip], 2 * T, 1)[0]).toEqual({ ...clip, startTick: 18 * T, trackId: 'track-audio' });
  });
  it('right-resizes and left-trims groups while preserving their end boundaries and pattern phase', () => {
    const project = createTestArrangement();
    const clip = project.playlist[0];
    const trim = resizeClips(project, [clip], 'start', 8 * T)[0];
    expect(trim).toMatchObject({ startTick: 24 * T, durationTicks: 40 * T, sourceOffsetTicks: 8 * T });
    expect(trim.startTick + trim.durationTicks).toBe(clip.startTick + clip.durationTicks);
    expect(resizeClips(project, [clip], 'end', -10000)[0].durationTicks).toBe(1);
    expect(resizeClips(project, [clip], 'start', -8 * T)[0]).toMatchObject({ startTick: 8 * T, sourceOffsetTicks: 8 * T });
  });
  it('audio left trim advances real source seconds across tempo changes, while end resize never stretches it', () => {
    const project = createTestArrangement();
    const audio = project.playlist.find((clip) => clip.kind === 'audio')!;
    const trimmed = resizeClips(project, [audio], 'start', 16 * T)[0];
    expect(trimmed.startTick).toBe(36 * T);
    expect(trimmed.kind === 'audio' && trimmed.sourceOffsetSeconds).toBeCloseTo(0.5 + 12 * 0.125 + 4 * 60 / 90 / 4, 12);
    const extended = resizeClips(project, [audio], 'end', 32 * T)[0];
    expect(extended).toMatchObject({ sourceOffsetSeconds: 0.5, durationTicks: 64 * T });
    const clamped = resizeClips(project, [audio], 'start', -10000)[0];
    expect(clamped).toMatchObject({ startTick: 16 * T, sourceOffsetSeconds: 0 });
  });
  it('multi-resize keeps every member valid even when an audio trim constrains the group', () => {
    const project = createTestArrangement();
    const edited = resizeClips(project, project.playlist, 'start', -1000 * T);
    const result = { ...project, playlist: edited };
    assertValidProject(result);
    expect(edited.every((clip, index) => clip.startTick - project.playlist[index].startTick === -4 * T)).toBe(true);
  });
  it('duplicate creates new instance ids only, preserving references and relative placement', () => {
    const project = createTestArrangement();
    let counter = 0;
    const copies = duplicateClips(project.playlist, clipGroupSpan(project.playlist), () => `copy-${++counter}`);
    expect(new Set(copies.map((clip) => clip.id)).size).toBe(4);
    expect(copies[0]).toMatchObject({ patternId: 'pattern-main' });
    expect(copies[3]).toMatchObject({ assetId: 'asset-texture', sourceOffsetSeconds: 0.5 });
    expect(clipGroupSpan(copies)).toBe(clipGroupSpan(project.playlist));
  });
  it('lays overlapping clips in separate visible slots and reuses slots at exclusive ends', () => {
    const project = createTestArrangement();
    const first = project.playlist[0];
    const clips = [first, { ...first, id: 'overlap', startTick: first.startTick + T }, { ...first, id: 'next', startTick: first.startTick + first.durationTicks }];
    const layout = layoutClipSlots(clips);
    expect(layout.count).toBe(2);
    expect(layout.slots.get('overlap')).toBe(1);
    expect(layout.slots.get('next')).toBe(0);
  });
  it('moves/resizes loop markers without negative positions or zero-width ranges', () => {
    const loop = { enabled: true, startTick: 384, endTick: 768 };
    expect(editLoop(loop, 'move', -1000)).toEqual({ ...loop, startTick: 0, endTick: 384 });
    expect(editLoop(loop, 'start', 1000, 24).startTick).toBe(744);
    expect(editLoop(loop, 'end', -1000, 24).endTick).toBe(408);
  });
});

describe('source/transport alignment', () => {
  it('the Piano Roll/Channel Rack follow instance-relative source phase rather than global song modulo', () => {
    const project = createTestArrangement();
    expect(patternStepAtSongPosition(project, 'pattern-main', 26, 'clip-b')).toBe(2);
    expect(patternStepAtSongPosition(project, 'pattern-main', 26, 'clip-a')).toBe(10);
    expect(patternStepAtSongPosition(project, 'pattern-harmony', 40, 'clip-c')).toBe(8);
    expect(patternStepAtSongPosition(project, 'pattern-main', 70)).toBeNull();
    expect(findPatternClipAt(project, 'pattern-main', 26, 'clip-b')?.id).toBe('clip-b');
  });
  it('Piano Roll seeking resolves the current repeat of its selected arrangement instance', () => {
    const project = createTestArrangement();
    expect(songStepForPatternTick(project, 'pattern-main', 4 * T, 26, 'clip-b')).toBe(28);
    expect(songStepForPatternTick(project, 'pattern-main', 4 * T, 37, 'clip-a')).toBe(36);
    expect(songStepForPatternTick(project, 'pattern-harmony', 10 * T, 41, 'clip-c')).toBe(42);
  });
  it('calculates import lengths with tempo automation and grows the song beyond the initial eight bars', () => {
    const project = createTestArrangement();
    expect(audioDurationTicks(project, 24 * T, 1)).toBe(8 * T);
    expect(audioDurationTicks(project, 32 * T, 1)).toBe(6 * T);
    project.playlist[0].startTick = 1000 * T;
    expect(getSongEndTick(project)).toBe(1048 * T);
  });
});
