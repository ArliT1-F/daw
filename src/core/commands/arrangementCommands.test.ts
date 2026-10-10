import { describe, expect, it } from 'vitest';
import { applyProjectCommand, createProjectHistory, projectHistoryReducer, ProjectCommandError } from './commands';
import { assertValidProject, createInitialProject } from '../project/model';
import { createPlaylistTrack } from '../arrangement/arrangement';
import { createTestArrangement } from '../arrangement/__fixtures__/testArrangement';
import { TICKS_PER_STEP as T } from '../time/ticks';

describe('undoable Playlist commands', () => {
  it('creates, renames, reorders, mutes and solos independent tracks without altering sources/placements', () => {
    const original = createTestArrangement();
    let project = applyProjectCommand(original, { type: 'playlist.track.add', track: createPlaylistTrack('New lane', 4, 'new-lane') });
    project = applyProjectCommand(project, { type: 'playlist.track.rename', trackId: 'new-lane', name: '  Texture lane  ' });
    project = applyProjectCommand(project, { type: 'playlist.track.reorder', trackId: 'new-lane', toIndex: 0 });
    project = applyProjectCommand(project, { type: 'playlist.track.mute.set', trackId: 'new-lane', muted: true });
    project = applyProjectCommand(project, { type: 'playlist.track.solo.set', trackId: 'new-lane', solo: true });
    expect(project.tracks[0]).toMatchObject({ name: 'Texture lane', muted: true, solo: true });
    expect(project.patterns).toBe(original.patterns);
    expect(project.playlist).toBe(original.playlist);
    expect(original.tracks.some((track) => track.id === 'new-lane')).toBe(false);
    assertValidProject(project);
  });
  it('rejects invalid/missing tracks, duplicate ids, bad mix states, and invalid ordering', () => {
    const project = createInitialProject();
    expect(() => applyProjectCommand(project, { type: 'playlist.track.rename', trackId: 'nope', name: 'New' })).toThrow(ProjectCommandError);
    expect(() => applyProjectCommand(project, { type: 'playlist.track.rename', trackId: 'track-main', name: ' ' })).toThrow('name');
    expect(() => applyProjectCommand(project, { type: 'playlist.track.add', track: project.tracks[0] })).toThrow('unique');
    expect(() => applyProjectCommand(project, { type: 'playlist.track.reorder', trackId: 'track-main', toIndex: 99 })).toThrow('order');
  });
  it('duplicates only clip instances; all copies retain reusable source ids and object references', () => {
    const original = createTestArrangement();
    const copies = original.playlist.map((clip, index) => ({ ...clip, id: `copy-${index}`, startTick: clip.startTick + 64 * T }));
    const project = applyProjectCommand(original, { type: 'playlist.clips.edit', upserts: copies });
    expect(project.playlist).toHaveLength(8);
    expect(project.patterns).toBe(original.patterns);
    expect(project.audioAssets).toBe(original.audioAssets);
    expect(copies[0].kind === 'pattern' && copies[0].patternId).toBe('pattern-main');
    expect(copies[3].kind === 'audio' && copies[3].assetId).toBe('asset-texture');
  });
  it('moves/resizes multiple clips as a single history step and round-trips undo/redo', () => {
    const project = createTestArrangement();
    const moved = project.playlist.map((clip) => ({ ...clip, startTick: clip.startTick + 8 * T, durationTicks: clip.durationTicks + 4 * T }));
    const initial = createProjectHistory(project);
    const edited = projectHistoryReducer(initial, { type: 'command', command: { type: 'playlist.clips.edit', upserts: moved } });
    expect(edited.past).toHaveLength(1);
    expect(edited.project.playlist).toEqual(moved);
    const undone = projectHistoryReducer(edited, { type: 'undo' });
    expect(undone.project).toBe(project);
    expect(projectHistoryReducer(undone, { type: 'redo' }).project.playlist).toEqual(moved);
  });
  it('rejects an invalid member of a batch without partially editing the arrangement', () => {
    const project = createTestArrangement();
    const before = JSON.stringify(project);
    expect(() => applyProjectCommand(project, { type: 'project.batch', commands: [
      { type: 'playlist.track.rename', trackId: 'track-main', name: 'Changed' },
      { type: 'playlist.clips.edit', upserts: [{ ...project.playlist[0], trackId: 'missing' }] },
    ] })).toThrow('missing track');
    expect(JSON.stringify(project)).toBe(before);
  });
  it('adds decoded-asset metadata and its instance atomically in one undo step', () => {
    const initial = createProjectHistory(createInitialProject());
    const edited = projectHistoryReducer(initial, { type: 'command', command: { type: 'project.batch', commands: [
      { type: 'audio.asset.add', asset: { id: 'source', name: 'voice.wav', durationSeconds: 2 } },
      { type: 'playlist.clip.add', clip: { id: 'audio', kind: 'audio', trackId: 'track-audio', assetId: 'source', startTick: 384, durationTicks: 192, sourceOffsetSeconds: 0.5, gain: 1 } },
    ] } });
    expect(edited.past).toHaveLength(1);
    expect(edited.project.audioAssets).toHaveLength(1);
    expect(edited.project.playlist.at(-1)).toMatchObject({ kind: 'audio', assetId: 'source' });
    expect(projectHistoryReducer(edited, { type: 'undo' }).project.audioAssets).toHaveLength(0);
  });
  it('validates audio trim, durations, source ids, and mutually exclusive clip kinds', () => {
    const project = createTestArrangement();
    const clip = project.playlist.find((item) => item.kind === 'audio')!;
    expect(() => applyProjectCommand(project, { type: 'playlist.clips.edit', upserts: [{ ...clip, durationTicks: 0 }] })).toThrow('duration');
    if (clip.kind !== 'audio') throw new Error('Bad fixture');
    expect(() => applyProjectCommand(project, { type: 'playlist.clips.edit', upserts: [{ ...clip, sourceOffsetSeconds: 8 }] })).toThrow('source offset');
    expect(() => applyProjectCommand(project, { type: 'playlist.clips.edit', upserts: [{ ...clip, assetId: 'missing' }] })).toThrow('missing audio asset');
    expect(() => applyProjectCommand(project, { type: 'playlist.clips.edit', upserts: [{ ...clip, gain: 3 }] })).toThrow('gain');
    expect(() => applyProjectCommand(project, { type: 'playlist.clips.edit', upserts: [clip, clip] })).toThrow('unique');
  });
  it('deletes a multi-selection without deleting or modifying the sources', () => {
    const project = createTestArrangement();
    const edited = applyProjectCommand(project, { type: 'playlist.clips.edit', upserts: [], removeIds: ['clip-a', 'clip-b', 'clip-audio'] });
    expect(edited.playlist.map((clip) => clip.id)).toEqual(['clip-c']);
    expect(edited.patterns).toBe(project.patterns);
    expect(edited.audioAssets).toBe(project.audioAssets);
  });
  it('removes track instances atomically but retains sources and requires a remaining lane', () => {
    let project = createTestArrangement();
    project = applyProjectCommand(project, { type: 'playlist.track.remove', trackId: 'track-audio' });
    expect(project.playlist.map((clip) => clip.id)).toEqual(['clip-a', 'clip-b']);
    project = applyProjectCommand(project, { type: 'playlist.track.remove', trackId: 'track-main' });
    expect(() => applyProjectCommand(project, { type: 'playlist.track.remove', trackId: 'track-layer' })).toThrow('at least one');
  });
  it('saves loop state and sorted tempo markers, rejecting inverted loops and ambiguous maps', () => {
    let project = createInitialProject();
    project = applyProjectCommand(project, { type: 'playlist.loop.set', changes: { startTick: 768, endTick: 1536 } });
    project = applyProjectCommand(project, { type: 'project.tempo-changes.set', changes: [{ tick: 768, bpm: 90 }, { tick: 1536, bpm: 140 }] });
    expect(project.settings.loop).toMatchObject({ startTick: 768, endTick: 1536 });
    expect(() => applyProjectCommand(project, { type: 'playlist.loop.set', changes: { endTick: 700 } })).toThrow('follow');
    expect(() => applyProjectCommand(project, { type: 'project.tempo-changes.set', changes: [{ tick: 1, bpm: 90 }, { tick: 1, bpm: 140 }] })).toThrow('increasing');
    expect(() => applyProjectCommand(project, { type: 'project.tempo-changes.set', changes: [{ tick: 0, bpm: 90 }] })).toThrow('positive');
  });
  it('no-op changes do not consume undo history', () => {
    const initial = createProjectHistory(createInitialProject());
    for (const command of [
      { type: 'playlist.track.rename' as const, trackId: 'track-main', name: 'Patterns' },
      { type: 'playlist.clips.edit' as const, upserts: initial.project.playlist },
      { type: 'playlist.loop.set' as const, changes: initial.project.settings.loop },
    ]) expect(projectHistoryReducer(initial, { type: 'command', command })).toBe(initial);
  });
});
