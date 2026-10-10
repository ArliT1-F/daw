import {
  assertValidProject,
  type AudioAsset,
  type PlaylistClip,
  type PlaylistLoop,
  type PlaylistTrack,
  type Project,
  type ProjectTempoChange,
} from '../project/model';
import { ProjectCommandError } from './commandError';

export type ArrangementCommand =
  | { type: 'playlist.track.add'; track: PlaylistTrack }
  | { type: 'playlist.track.rename'; trackId: string; name: string }
  | { type: 'playlist.track.reorder'; trackId: string; toIndex: number }
  | { type: 'playlist.track.mute.set'; trackId: string; muted: boolean }
  | { type: 'playlist.track.solo.set'; trackId: string; solo: boolean }
  | { type: 'playlist.track.remove'; trackId: string }
  | { type: 'playlist.clip.add'; clip: PlaylistClip }
  | { type: 'playlist.clip.remove'; clipId: string }
  /** Atomic multi-clip edit; existing ids are updated and fresh ids insert instances only. */
  | { type: 'playlist.clips.edit'; upserts: PlaylistClip[]; removeIds?: string[] }
  | { type: 'playlist.loop.set'; changes: Partial<PlaylistLoop> }
  | { type: 'audio.asset.add'; asset: AudioAsset }
  | { type: 'project.tempo-changes.set'; changes: ProjectTempoChange[] };

function requireTrack(project: Project, id: string): PlaylistTrack {
  const track = project.tracks.find((item) => item.id === id);
  if (!track) throw new ProjectCommandError(`Playlist track "${id}" does not exist.`);
  return track;
}

/** Arrangement commands always validate their entire result, including foreign-key references. */
export function applyArrangementCommand(project: Project, command: ArrangementCommand): Project {
  let next: Project;
  switch (command.type) {
    case 'playlist.track.add':
      next = { ...project, tracks: [...project.tracks, { ...command.track, name: command.track.name.trim() }] };
      break;
    case 'playlist.track.rename': {
      const track = requireTrack(project, command.trackId);
      const name = command.name.trim();
      if (name === track.name) return project;
      next = { ...project, tracks: project.tracks.map((item) => item.id === track.id ? { ...item, name } : item) };
      break;
    }
    case 'playlist.track.mute.set':
    case 'playlist.track.solo.set': {
      const track = requireTrack(project, command.trackId);
      const changes = command.type === 'playlist.track.mute.set' ? { muted: command.muted } : { solo: command.solo };
      if (Object.entries(changes).every(([key, value]) => track[key as 'muted' | 'solo'] === value)) return project;
      next = { ...project, tracks: project.tracks.map((item) => item.id === track.id ? { ...item, ...changes } : item) };
      break;
    }
    case 'playlist.track.reorder': {
      const track = requireTrack(project, command.trackId);
      const index = project.tracks.indexOf(track);
      if (!Number.isInteger(command.toIndex) || command.toIndex < 0 || command.toIndex >= project.tracks.length) {
        throw new ProjectCommandError('Track order is outside the Playlist.');
      }
      if (index === command.toIndex) return project;
      const tracks = project.tracks.filter((item) => item.id !== track.id);
      tracks.splice(command.toIndex, 0, track);
      next = { ...project, tracks };
      break;
    }
    case 'playlist.track.remove':
      requireTrack(project, command.trackId);
      next = {
        ...project,
        tracks: project.tracks.filter((track) => track.id !== command.trackId),
        playlist: project.playlist.filter((clip) => clip.trackId !== command.trackId),
      };
      break;
    case 'playlist.clip.add':
      if (project.playlist.some((clip) => clip.id === command.clip.id)) throw new ProjectCommandError('Playlist clip ID is already in use.');
      next = { ...project, playlist: [...project.playlist, { ...command.clip }] };
      break;
    case 'playlist.clip.remove': {
      const playlist = project.playlist.filter((clip) => clip.id !== command.clipId);
      if (playlist.length === project.playlist.length) return project;
      next = { ...project, playlist };
      break;
    }
    case 'playlist.clips.edit': {
      const byId = new Map(command.upserts.map((clip) => [clip.id, clip]));
      if (byId.size !== command.upserts.length) throw new ProjectCommandError('Edited clip IDs must be unique.');
      const remove = new Set(command.removeIds ?? []);
      if (command.upserts.some((clip) => remove.has(clip.id))) throw new ProjectCommandError('A clip cannot be updated and deleted in the same edit.');
      const playlist = project.playlist.filter((clip) => !remove.has(clip.id)).map((clip) => {
        const update = byId.get(clip.id);
        byId.delete(clip.id);
        return update ? { ...update } : clip;
      });
      playlist.push(...[...byId.values()].map((clip) => ({ ...clip })));
      if (JSON.stringify(playlist) === JSON.stringify(project.playlist)) return project;
      next = { ...project, playlist };
      break;
    }
    case 'playlist.loop.set': {
      const loop = { ...project.settings.loop, ...command.changes };
      if (loop.enabled === project.settings.loop.enabled && loop.startTick === project.settings.loop.startTick && loop.endTick === project.settings.loop.endTick) return project;
      next = { ...project, settings: { ...project.settings, loop } };
      break;
    }
    case 'audio.asset.add':
      next = { ...project, audioAssets: [...project.audioAssets, { ...command.asset, ...(command.asset.peaks ? { peaks: [...command.asset.peaks] } : {}) }] };
      break;
    case 'project.tempo-changes.set': {
      if (JSON.stringify(command.changes) === JSON.stringify(project.settings.tempoChanges)) return project;
      next = { ...project, settings: { ...project.settings, tempoChanges: command.changes.map((change) => ({ ...change })) } };
      break;
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
  try {
    assertValidProject(next);
  } catch (error) {
    throw new ProjectCommandError(error instanceof Error ? error.message : 'Invalid arrangement edit.');
  }
  return next;
}
