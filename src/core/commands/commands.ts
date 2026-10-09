import {
  DEFAULT_PATTERN_STEPS,
  type Channel,
  type Note,
  type Pattern,
  type PlaylistClip,
  type Project,
  type TimeSignature,
  isValidTimeSignature,
} from '../project/model';

export type ProjectCommand =
  | { type: 'project.tempo.set'; tempo: number }
  | { type: 'project.time-signature.set'; timeSignature: TimeSignature }
  | { type: 'channel.add'; channel: Channel }
  | { type: 'channel.rename'; channelId: string; name: string }
  | { type: 'pattern.step.toggle'; patternId: string; channelId: string; step: number }
  | { type: 'pattern.note.toggle'; patternId: string; channelId: string; note: Note }
  | { type: 'playlist.clip.add'; clip: PlaylistClip }
  | { type: 'playlist.clip.remove'; clipId: string };

export class ProjectCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectCommandError';
  }
}

function requirePattern(project: Project, patternId: string): Pattern {
  const pattern = project.patterns.find((item) => item.id === patternId);
  if (!pattern) throw new ProjectCommandError(`Pattern "${patternId}" does not exist.`);
  return pattern;
}

function requireChannel(project: Project, channelId: string): void {
  if (!project.channels.some((channel) => channel.id === channelId)) {
    throw new ProjectCommandError(`Channel "${channelId}" does not exist.`);
  }
}

function updatePattern(project: Project, patternId: string, update: (pattern: Pattern) => Pattern): Project {
  let changed = false;
  const patterns = project.patterns.map((pattern) => {
    if (pattern.id !== patternId) return pattern;
    changed = true;
    return update(pattern);
  });
  if (!changed) throw new ProjectCommandError(`Pattern "${patternId}" does not exist.`);
  return { ...project, patterns };
}

function validateNote(pattern: Pattern, note: Note): void {
  if (!note.id.trim()) throw new ProjectCommandError('Note IDs must not be empty.');
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
    throw new ProjectCommandError('Note pitch must be a MIDI note from 0 to 127.');
  }
  if (
    !Number.isInteger(note.startStep) ||
    note.startStep < 0 ||
    note.startStep >= pattern.lengthSteps ||
    !Number.isInteger(note.durationSteps) ||
    note.durationSteps < 1 ||
    note.startStep + note.durationSteps > pattern.lengthSteps
  ) {
    throw new ProjectCommandError('Note position or length is outside the pattern.');
  }
  if (!Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) {
    throw new ProjectCommandError('Note velocity must be between 0 and 1.');
  }
}

/** Apply one project edit immutably. The same command can be replayed after undo. */
export function applyProjectCommand(project: Project, command: ProjectCommand): Project {
  switch (command.type) {
    case 'project.tempo.set': {
      if (!Number.isFinite(command.tempo) || command.tempo < 20 || command.tempo > 300) {
        throw new ProjectCommandError('Tempo must be between 20 and 300 BPM.');
      }
      if (project.settings.tempo === command.tempo) return project;
      return { ...project, settings: { ...project.settings, tempo: command.tempo } };
    }

    case 'project.time-signature.set': {
      if (!isValidTimeSignature(command.timeSignature)) {
        throw new ProjectCommandError('Time signature is not supported.');
      }
      if (
        project.settings.timeSignature.numerator === command.timeSignature.numerator &&
        project.settings.timeSignature.denominator === command.timeSignature.denominator
      ) {
        return project;
      }
      return {
        ...project,
        settings: { ...project.settings, timeSignature: { ...command.timeSignature } },
      };
    }

    case 'channel.add': {
      const { channel } = command;
      if (!channel.id.trim() || !channel.name.trim()) {
        throw new ProjectCommandError('A new channel needs an ID and a name.');
      }
      if (project.channels.some((item) => item.id === channel.id)) {
        throw new ProjectCommandError(`Channel ID "${channel.id}" is already in use.`);
      }
      if (!project.mixerChannels.some((item) => item.id === channel.mixerChannelId)) {
        throw new ProjectCommandError(`Mixer channel "${channel.mixerChannelId}" does not exist.`);
      }
      const channels = [...project.channels, { ...channel }];
      const patterns = project.patterns.map((pattern) => ({
        ...pattern,
        steps: { ...pattern.steps, [channel.id]: Array.from({ length: pattern.lengthSteps }, () => false) },
        notes: { ...pattern.notes, [channel.id]: [] },
      }));
      return { ...project, channels, patterns };
    }

    case 'channel.rename': {
      requireChannel(project, command.channelId);
      const name = command.name.trim();
      if (!name || name.length > 80) throw new ProjectCommandError('Channel name must be between 1 and 80 characters.');
      if (project.channels.find((channel) => channel.id === command.channelId)?.name === name) return project;
      return {
        ...project,
        channels: project.channels.map((channel) =>
          channel.id === command.channelId ? { ...channel, name } : channel,
        ),
      };
    }

    case 'pattern.step.toggle': {
      requireChannel(project, command.channelId);
      const pattern = requirePattern(project, command.patternId);
      if (!Number.isInteger(command.step) || command.step < 0 || command.step >= pattern.lengthSteps) {
        throw new ProjectCommandError('Step is outside the pattern.');
      }
      const channelSteps = pattern.steps[command.channelId];
      if (!channelSteps) throw new ProjectCommandError('The pattern has no step row for this channel.');
      const steps = [...channelSteps];
      steps[command.step] = !steps[command.step];
      return updatePattern(project, command.patternId, (current) => ({
        ...current,
        steps: { ...current.steps, [command.channelId]: steps },
      }));
    }

    case 'pattern.note.toggle': {
      requireChannel(project, command.channelId);
      const pattern = requirePattern(project, command.patternId);
      validateNote(pattern, command.note);
      const currentNotes = pattern.notes[command.channelId];
      if (!currentNotes) throw new ProjectCommandError('The pattern has no note lane for this channel.');
      const exists = currentNotes.some((note) => note.id === command.note.id);
      return updatePattern(project, command.patternId, (current) => ({
        ...current,
        notes: {
          ...current.notes,
          [command.channelId]: exists
            ? currentNotes.filter((note) => note.id !== command.note.id)
            : [...currentNotes, { ...command.note }],
        },
      }));
    }

    case 'playlist.clip.add': {
      const { clip } = command;
      if (!clip.id.trim() || project.playlist.some((item) => item.id === clip.id)) {
        throw new ProjectCommandError('Playlist clip ID is missing or already in use.');
      }
      requirePattern(project, clip.patternId);
      if (!Number.isInteger(clip.startBar) || clip.startBar < 0 || !Number.isInteger(clip.lengthBars) || clip.lengthBars < 1) {
        throw new ProjectCommandError('Playlist clip position or length is invalid.');
      }
      return { ...project, playlist: [...project.playlist, { ...clip }] };
    }

    case 'playlist.clip.remove': {
      const playlist = project.playlist.filter((clip) => clip.id !== command.clipId);
      return playlist.length === project.playlist.length ? project : { ...project, playlist };
    }

    default: {
      const exhaustiveCheck: never = command;
      return exhaustiveCheck;
    }
  }
}

export interface ProjectHistoryState {
  project: Project;
  past: Project[];
  future: Project[];
}

export type ProjectHistoryAction =
  | { type: 'command'; command: ProjectCommand }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'replace'; project: Project };

export const MAX_UNDO_STEPS = 100;

export function createProjectHistory(project: Project): ProjectHistoryState {
  return { project, past: [], future: [] };
}

export function projectHistoryReducer(state: ProjectHistoryState, action: ProjectHistoryAction): ProjectHistoryState {
  switch (action.type) {
    case 'command': {
      const project = applyProjectCommand(state.project, action.command);
      if (project === state.project) return state;
      return {
        project,
        past: [...state.past, state.project].slice(-MAX_UNDO_STEPS),
        future: [],
      };
    }
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        project: previous,
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future].slice(0, MAX_UNDO_STEPS),
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        project: next,
        past: [...state.past, state.project].slice(-MAX_UNDO_STEPS),
        future: state.future.slice(1),
      };
    }
    case 'replace':
      return createProjectHistory(action.project);
    default: {
      const exhaustiveCheck: never = action;
      return exhaustiveCheck;
    }
  }
}

export function createEmptyChannel(id: string, name: string, color: string, mixerChannelId = 'mixer-insert-1'): Channel {
  return { id, name, kind: 'instrument', color, mixerChannelId };
}

export function createEmptyPatternSteps(): boolean[] {
  return Array.from({ length: DEFAULT_PATTERN_STEPS }, () => false);
}
