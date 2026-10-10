import {
  DEFAULT_PATTERN_STEPS,
  DEFAULT_STEP_VELOCITY,
  SUPPORTED_PATTERN_LENGTHS,
  type Channel,
  type Note,
  type Pattern,
  type Project,
  type TimeSignature,
  isValidTimeSignature,
} from '../project/model';
import { patternLengthTicks } from '../time/ticks';
import { applyArrangementCommand, type ArrangementCommand } from './arrangementCommands';
import { ProjectCommandError } from './commandError';
export { ProjectCommandError } from './commandError';

export type ProjectCommand =
  | ArrangementCommand
  | { type: 'project.batch'; commands: ProjectCommand[] }
  | { type: 'project.tempo.set'; tempo: number }
  | { type: 'project.swing.set'; swing: number }
  | { type: 'project.time-signature.set'; timeSignature: TimeSignature }
  | { type: 'channel.add'; channel: Channel }
  | { type: 'channel.rename'; channelId: string; name: string }
  | { type: 'channel.mute.set'; channelId: string; muted: boolean }
  | { type: 'channel.solo.set'; channelId: string; solo: boolean }
  | { type: 'channel.sample.assign'; channelId: string; sampleId: string; sampleName: string }
  | { type: 'channel.sample.clear'; channelId: string }
  | { type: 'pattern.add'; pattern: Pattern }
  | { type: 'pattern.rename'; patternId: string; name: string }
  | { type: 'pattern.duplicate'; patternId: string; newPatternId: string; name?: string }
  | { type: 'pattern.clear'; patternId: string }
  | { type: 'pattern.length.set'; patternId: string; lengthSteps: number }
  | { type: 'pattern.step.toggle'; patternId: string; channelId: string; step: number }
  | { type: 'pattern.step.set'; patternId: string; channelId: string; step: number; active: boolean; velocity?: number }
  | { type: 'pattern.note.toggle'; patternId: string; channelId: string; note: Note }
  | { type: 'pattern.note.add'; patternId: string; channelId: string; note: Note }
  | { type: 'pattern.note.remove'; patternId: string; channelId: string; noteId: string }
  | { type: 'pattern.note.update'; patternId: string; channelId: string; noteId: string; changes: Partial<Omit<Note, 'id'>> }
  | { type: 'pattern.notes.replace'; patternId: string; channelId: string; notes: Note[] }
;


function requirePattern(project: Project, patternId: string): Pattern {
  const pattern = project.patterns.find((item) => item.id === patternId);
  if (!pattern) throw new ProjectCommandError(`Pattern "${patternId}" does not exist.`);
  return pattern;
}

function cloneRows<T>(rows: Record<string, T[]>): Record<string, T[]> {
  return Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, [...row]]));
}

function cloneNotes(notes: Record<string, Note[]>): Record<string, Note[]> {
  return Object.fromEntries(Object.entries(notes).map(([id, list]) => [id, list.map((note) => ({ ...note }))]));
}

function requireChannel(project: Project, channelId: string): void {
  if (!project.channels.some((channel) => channel.id === channelId)) {
    throw new ProjectCommandError(`Channel "${channelId}" does not exist.`);
  }
}

function requireName(name: string, label: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new ProjectCommandError(`${label} must be between 1 and 80 characters.`);
  return trimmed;
}

function validateVelocity(velocity: number): number {
  if (!Number.isFinite(velocity) || velocity < 0 || velocity > 1) {
    throw new ProjectCommandError('Step velocity must be between 0 and 1.');
  }
  return velocity;
}

/** Write one step of a pattern, keeping `steps` and `velocities` rows in lockstep. */
function setPatternStep(project: Project, patternId: string, channelId: string, step: number, active: boolean, velocity?: number): Project {
  requireChannel(project, channelId);
  const pattern = requirePattern(project, patternId);
  if (!Number.isInteger(step) || step < 0 || step >= pattern.lengthSteps) {
    throw new ProjectCommandError('Step is outside the pattern.');
  }
  const channelSteps = pattern.steps[channelId];
  const channelVelocities = pattern.velocities[channelId];
  if (!channelSteps || !channelVelocities) throw new ProjectCommandError('The pattern has no step row for this channel.');
  const nextVelocity = velocity === undefined ? channelVelocities[step] : validateVelocity(velocity);
  if (channelSteps[step] === active && channelVelocities[step] === nextVelocity) return project;
  const steps = [...channelSteps];
  const velocities = [...channelVelocities];
  steps[step] = active;
  velocities[step] = nextVelocity;
  return updatePattern(project, patternId, (current) => ({
    ...current,
    steps: { ...current.steps, [channelId]: steps },
    velocities: { ...current.velocities, [channelId]: velocities },
  }));
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
  const lengthTicks = patternLengthTicks(pattern.lengthSteps);
  if (
    !Number.isInteger(note.startTick) ||
    note.startTick < 0 ||
    note.startTick >= lengthTicks ||
    !Number.isInteger(note.durationTicks) ||
    note.durationTicks < 1 ||
    note.startTick + note.durationTicks > lengthTicks
  ) {
    throw new ProjectCommandError('Note position or length is outside the pattern.');
  }
  if (!Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) {
    throw new ProjectCommandError('Note velocity must be between 0 and 1.');
  }
}

function notesAreEqual(a: readonly Note[], b: readonly Note[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left.id !== right.id ||
      left.pitch !== right.pitch ||
      left.startTick !== right.startTick ||
      left.durationTicks !== right.durationTicks ||
      left.velocity !== right.velocity
    ) {
      return false;
    }
  }
  return true;
}

function requireNoteLane(pattern: Pattern, channelId: string): Note[] {
  const currentNotes = pattern.notes[channelId];
  if (!currentNotes) throw new ProjectCommandError('The pattern has no note lane for this channel.');
  return currentNotes;
}

function replaceNoteLane(project: Project, patternId: string, channelId: string, notes: Note[]): Project {
  return updatePattern(project, patternId, (current) => ({
    ...current,
    notes: { ...current.notes, [channelId]: notes.map((note) => ({ ...note })) },
  }));
}

/** Apply one project edit immutably. The same command can be replayed after undo. */
export function applyProjectCommand(project: Project, command: ProjectCommand): Project {
  switch (command.type) {
    case 'project.batch':
      return command.commands.reduce(applyProjectCommand, project);
    case 'project.tempo.set': {
      if (!Number.isFinite(command.tempo) || command.tempo < 20 || command.tempo > 300) {
        throw new ProjectCommandError('Tempo must be between 20 and 300 BPM.');
      }
      if (project.settings.tempo === command.tempo) return project;
      return { ...project, settings: { ...project.settings, tempo: command.tempo } };
    }

    case 'project.swing.set': {
      if (!Number.isFinite(command.swing) || command.swing < 0 || command.swing > 1) {
        throw new ProjectCommandError('Swing must be between 0 and 1.');
      }
      if (project.settings.swing === command.swing) return project;
      return { ...project, settings: { ...project.settings, swing: command.swing } };
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
        velocities: { ...pattern.velocities, [channel.id]: Array.from({ length: pattern.lengthSteps }, () => DEFAULT_STEP_VELOCITY) },
        notes: { ...pattern.notes, [channel.id]: [] },
      }));
      return { ...project, channels, patterns };
    }

    case 'channel.rename': {
      requireChannel(project, command.channelId);
      const name = requireName(command.name, 'Channel name');
      if (project.channels.find((channel) => channel.id === command.channelId)?.name === name) return project;
      return {
        ...project,
        channels: project.channels.map((channel) =>
          channel.id === command.channelId ? { ...channel, name } : channel,
        ),
      };
    }

    case 'channel.mute.set': {
      requireChannel(project, command.channelId);
      if (typeof command.muted !== 'boolean') throw new ProjectCommandError('Mute state must be a boolean.');
      return {
        ...project,
        channels: project.channels.map((channel) =>
          channel.id === command.channelId ? { ...channel, muted: command.muted } : channel,
        ),
      };
    }

    case 'channel.solo.set': {
      requireChannel(project, command.channelId);
      if (typeof command.solo !== 'boolean') throw new ProjectCommandError('Solo state must be a boolean.');
      return {
        ...project,
        channels: project.channels.map((channel) =>
          channel.id === command.channelId ? { ...channel, solo: command.solo } : channel,
        ),
      };
    }

    case 'channel.sample.assign': {
      requireChannel(project, command.channelId);
      const sampleId = command.sampleId.trim();
      const sampleName = requireName(command.sampleName, 'Sample name');
      if (!sampleId) throw new ProjectCommandError('A sample ID is required.');
      return {
        ...project,
        channels: project.channels.map((channel) =>
          channel.id === command.channelId ? { ...channel, sampleId, sampleName } : channel,
        ),
      };
    }

    case 'channel.sample.clear': {
      requireChannel(project, command.channelId);
      if (!project.channels.some((channel) => channel.id === command.channelId && channel.sampleId)) return project;
      return {
        ...project,
        channels: project.channels.map((channel) =>
          channel.id === command.channelId ? { ...channel, sampleId: undefined, sampleName: undefined } : channel,
        ),
      };
    }

    case 'pattern.add': {
      const { pattern } = command;
      if (!pattern.id.trim() || project.patterns.some((item) => item.id === pattern.id)) {
        throw new ProjectCommandError('Pattern ID is missing or already in use.');
      }
      requireName(pattern.name, 'Pattern name');
      if (!SUPPORTED_PATTERN_LENGTHS.includes(pattern.lengthSteps as (typeof SUPPORTED_PATTERN_LENGTHS)[number])) {
        throw new ProjectCommandError('Pattern length must be 16 or 32 steps.');
      }
      const channelIds = project.channels.map((channel) => channel.id);
      const stepKeys = Object.keys(pattern.steps);
      const velocityKeys = Object.keys(pattern.velocities);
      const noteKeys = Object.keys(pattern.notes);
      const sameKeys = (keys: string[]) =>
        keys.length === channelIds.length && channelIds.every((id) => keys.includes(id));
      if (!sameKeys(stepKeys) || !sameKeys(velocityKeys) || !sameKeys(noteKeys)) {
        throw new ProjectCommandError('A new pattern needs step, velocity, and note rows for every channel.');
      }
      for (const channelId of channelIds) {
        const steps = pattern.steps[channelId];
        const velocities = pattern.velocities[channelId];
        if (!Array.isArray(steps) || steps.length !== pattern.lengthSteps || !steps.every((step) => typeof step === 'boolean')) {
          throw new ProjectCommandError('Pattern step rows must match the pattern length.');
        }
        if (!Array.isArray(velocities) || velocities.length !== pattern.lengthSteps || !velocities.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
          throw new ProjectCommandError('Pattern velocity rows must match the pattern length with values from 0 to 1.');
        }
        if (!Array.isArray(pattern.notes[channelId])) {
          throw new ProjectCommandError('Pattern note rows are required for every channel.');
        }
      }
      return { ...project, patterns: [...project.patterns, { ...pattern, steps: cloneRows(pattern.steps), velocities: cloneRows(pattern.velocities), notes: cloneNotes(pattern.notes) }] };
    }

    case 'pattern.rename': {
      const name = requireName(command.name, 'Pattern name');
      requirePattern(project, command.patternId);
      if (project.patterns.find((pattern) => pattern.id === command.patternId)?.name === name) return project;
      return {
        ...project,
        patterns: project.patterns.map((pattern) =>
          pattern.id === command.patternId ? { ...pattern, name } : pattern,
        ),
      };
    }

    case 'pattern.duplicate': {
      const source = requirePattern(project, command.patternId);
      if (!command.newPatternId.trim() || project.patterns.some((pattern) => pattern.id === command.newPatternId)) {
        throw new ProjectCommandError('A duplicate pattern needs a new, unused ID.');
      }
      const name = command.name === undefined ? `${source.name} copy` : requireName(command.name, 'Pattern name');
      const copy: Pattern = {
        id: command.newPatternId,
        name,
        lengthSteps: source.lengthSteps,
        steps: cloneRows(source.steps),
        velocities: cloneRows(source.velocities),
        notes: cloneNotes(source.notes),
      };
      const patterns: Pattern[] = [];
      for (const pattern of project.patterns) {
        patterns.push(pattern);
        if (pattern.id === source.id) patterns.push(copy);
      }
      return { ...project, patterns };
    }

    case 'pattern.clear': {
      requirePattern(project, command.patternId);
      return updatePattern(project, command.patternId, (pattern) => ({
        ...pattern,
        steps: Object.fromEntries(project.channels.map((channel) => [channel.id, Array.from({ length: pattern.lengthSteps }, () => false)])),
        velocities: Object.fromEntries(project.channels.map((channel) => [channel.id, Array.from({ length: pattern.lengthSteps }, () => DEFAULT_STEP_VELOCITY)])),
        notes: Object.fromEntries(project.channels.map((channel) => [channel.id, []])),
      }));
    }

    case 'pattern.length.set': {
      const pattern = requirePattern(project, command.patternId);
      if (!SUPPORTED_PATTERN_LENGTHS.includes(command.lengthSteps as (typeof SUPPORTED_PATTERN_LENGTHS)[number])) {
        throw new ProjectCommandError('Pattern length must be 16 or 32 steps.');
      }
      if (pattern.lengthSteps === command.lengthSteps) return project;
      const length = command.lengthSteps;
      const steps: Pattern['steps'] = {};
      const velocities: Pattern['velocities'] = {};
      const notes: Pattern['notes'] = {};
      for (const channel of project.channels) {
        const row = pattern.steps[channel.id] ?? [];
        steps[channel.id] = Array.from({ length }, (_, index) => row[index] ?? false);
        const velocityRow = pattern.velocities[channel.id] ?? [];
        velocities[channel.id] = Array.from({ length }, (_, index) => velocityRow[index] ?? DEFAULT_STEP_VELOCITY);
        const lengthTicks = patternLengthTicks(length);
        notes[channel.id] = (pattern.notes[channel.id] ?? [])
          .filter((note) => note.startTick < lengthTicks)
          .map((note) => ({ ...note, durationTicks: Math.min(note.durationTicks, lengthTicks - note.startTick) }));
      }
      return updatePattern(project, command.patternId, (current) => ({
        ...current,
        lengthSteps: length,
        steps,
        velocities,
        notes,
      }));
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

    case 'pattern.step.set': {
      return setPatternStep(project, command.patternId, command.channelId, command.step, command.active, command.velocity);
    }

    case 'pattern.note.toggle': {
      requireChannel(project, command.channelId);
      const pattern = requirePattern(project, command.patternId);
      validateNote(pattern, command.note);
      const currentNotes = requireNoteLane(pattern, command.channelId);
      const exists = currentNotes.some((note) => note.id === command.note.id);
      return replaceNoteLane(
        project,
        command.patternId,
        command.channelId,
        exists ? currentNotes.filter((note) => note.id !== command.note.id) : [...currentNotes, command.note],
      );
    }

    case 'pattern.note.add': {
      requireChannel(project, command.channelId);
      const pattern = requirePattern(project, command.patternId);
      validateNote(pattern, command.note);
      const currentNotes = requireNoteLane(pattern, command.channelId);
      if (currentNotes.some((note) => note.id === command.note.id)) {
        throw new ProjectCommandError('Note IDs must be unique.');
      }
      return replaceNoteLane(project, command.patternId, command.channelId, [...currentNotes, command.note]);
    }

    case 'pattern.note.remove': {
      requireChannel(project, command.channelId);
      const pattern = requirePattern(project, command.patternId);
      const currentNotes = requireNoteLane(pattern, command.channelId);
      const nextNotes = currentNotes.filter((note) => note.id !== command.noteId);
      if (nextNotes.length === currentNotes.length) return project;
      return replaceNoteLane(project, command.patternId, command.channelId, nextNotes);
    }

    case 'pattern.note.update': {
      requireChannel(project, command.channelId);
      const pattern = requirePattern(project, command.patternId);
      const currentNotes = requireNoteLane(pattern, command.channelId);
      const index = currentNotes.findIndex((note) => note.id === command.noteId);
      if (index < 0) throw new ProjectCommandError('Note does not exist.');
      const updated: Note = { ...currentNotes[index], ...command.changes, id: currentNotes[index].id };
      validateNote(pattern, updated);
      if (
        updated.pitch === currentNotes[index].pitch &&
        updated.startTick === currentNotes[index].startTick &&
        updated.durationTicks === currentNotes[index].durationTicks &&
        updated.velocity === currentNotes[index].velocity
      ) {
        return project;
      }
      const nextNotes = [...currentNotes];
      nextNotes[index] = updated;
      return replaceNoteLane(project, command.patternId, command.channelId, nextNotes);
    }

    case 'pattern.notes.replace': {
      requireChannel(project, command.channelId);
      const pattern = requirePattern(project, command.patternId);
      requireNoteLane(pattern, command.channelId);
      const seen = new Set<string>();
      for (const note of command.notes) {
        validateNote(pattern, note);
        if (seen.has(note.id)) throw new ProjectCommandError('Note IDs must be unique.');
        seen.add(note.id);
      }
      if (notesAreEqual(pattern.notes[command.channelId] ?? [], command.notes)) return project;
      return replaceNoteLane(project, command.patternId, command.channelId, command.notes);
    }

    case 'playlist.track.add':
    case 'playlist.track.rename':
    case 'playlist.track.reorder':
    case 'playlist.track.mute.set':
    case 'playlist.track.solo.set':
    case 'playlist.track.remove':
    case 'playlist.clip.add':
    case 'playlist.clip.remove':
    case 'playlist.clips.edit':
    case 'playlist.loop.set':
    case 'audio.asset.add':
    case 'project.tempo-changes.set':
      return applyArrangementCommand(project, command);

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

export function createEmptyChannel(
  id: string,
  name: string,
  color: string,
  mixerChannelId = 'mixer-insert-1',
  kind: Channel['kind'] = 'instrument',
): Channel {
  return { id, name, kind, color, mixerChannelId, muted: false, solo: false };
}

export function createEmptyPatternSteps(length = DEFAULT_PATTERN_STEPS): boolean[] {
  return Array.from({ length }, () => false);
}

/** A new, empty 16- or 32-step pattern with rows for every channel in the project. */
export function createEmptyPattern(id: string, name: string, channels: readonly Channel[], lengthSteps = DEFAULT_PATTERN_STEPS): Pattern {
  return {
    id,
    name,
    lengthSteps,
    steps: Object.fromEntries(channels.map((channel) => [channel.id, createEmptyPatternSteps(lengthSteps)])),
    velocities: Object.fromEntries(channels.map((channel) => [channel.id, Array.from({ length: lengthSteps }, () => DEFAULT_STEP_VELOCITY)])),
    notes: Object.fromEntries(channels.map((channel) => [channel.id, []])),
  };
}
