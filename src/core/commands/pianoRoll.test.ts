import { describe, expect, it } from 'vitest';
import {
  ProjectCommandError,
  applyProjectCommand,
  createEmptyChannel,
  createProjectHistory,
  projectHistoryReducer,
} from './commands';
import { assertValidProject, createInitialProject, type Note, type Project } from '../project/model';
import { serializeProject, deserializeProject } from '../project/serialization';
import { TICKS_PER_STEP } from '../time/ticks';

function starter(): Project {
  return createInitialProject();
}

function bassNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-new',
    pitch: 64,
    startTick: 48,
    durationTicks: 24,
    velocity: 0.6,
    ...overrides,
  };
}

describe('piano-roll note commands', () => {
  it('adds, updates, and removes notes through undoable commands', () => {
    const initial = starter();
    const added = applyProjectCommand(initial, {
      type: 'pattern.note.add',
      patternId: 'pattern-main',
      channelId: 'channel-bass',
      note: bassNote(),
    });
    expect(added.patterns[0].notes['channel-bass'].some((note) => note.id === 'note-new')).toBe(true);
    expect(initial.patterns[0].notes['channel-bass']).toHaveLength(4);

    const moved = applyProjectCommand(added, {
      type: 'pattern.note.update',
      patternId: 'pattern-main',
      channelId: 'channel-bass',
      noteId: 'note-new',
      changes: { startTick: 96, pitch: 67, durationTicks: 48, velocity: 0.4 },
    });
    const updated = moved.patterns[0].notes['channel-bass'].find((note) => note.id === 'note-new');
    expect(updated).toMatchObject({ startTick: 96, pitch: 67, durationTicks: 48, velocity: 0.4 });

    const removed = applyProjectCommand(moved, {
      type: 'pattern.note.remove',
      patternId: 'pattern-main',
      channelId: 'channel-bass',
      noteId: 'note-new',
    });
    expect(removed.patterns[0].notes['channel-bass'].some((note) => note.id === 'note-new')).toBe(false);

    const history = createProjectHistory(initial);
    const afterAdd = projectHistoryReducer(history, {
      type: 'command',
      command: { type: 'pattern.note.add', patternId: 'pattern-main', channelId: 'channel-bass', note: bassNote() },
    });
    const undone = projectHistoryReducer(afterAdd, { type: 'undo' });
    expect(undone.project.patterns[0].notes['channel-bass']).toHaveLength(4);
    const redone = projectHistoryReducer(undone, { type: 'redo' });
    expect(redone.project.patterns[0].notes['channel-bass'].some((note) => note.id === 'note-new')).toBe(true);
  });

  it('replaces a whole lane in one undo step for multi-note edits', () => {
    const initial = starter();
    const notes: Note[] = [
      bassNote({ id: 'a', startTick: 0, pitch: 60, durationTicks: 24 }),
      bassNote({ id: 'b', startTick: 96, pitch: 64, durationTicks: 48 }),
    ];
    const replaced = applyProjectCommand(initial, {
      type: 'pattern.notes.replace',
      patternId: 'pattern-main',
      channelId: 'channel-bass',
      notes,
    });
    expect(replaced.patterns[0].notes['channel-bass']).toHaveLength(2);
    expect(replaced.patterns[0].notes['channel-kick']).toEqual([]);
    const again = applyProjectCommand(replaced, {
      type: 'pattern.notes.replace',
      patternId: 'pattern-main',
      channelId: 'channel-bass',
      notes,
    });
    expect(again).toBe(replaced);
  });

  it('rejects notes that leave the pattern, MIDI range, or velocity range', () => {
    const project = starter();
    const base = { type: 'pattern.note.add' as const, patternId: 'pattern-main', channelId: 'channel-bass' };
    expect(() => applyProjectCommand(project, { ...base, note: bassNote({ pitch: 128 }) })).toThrow(ProjectCommandError);
    expect(() => applyProjectCommand(project, { ...base, note: bassNote({ startTick: -1 }) })).toThrow('outside the pattern');
    expect(() => applyProjectCommand(project, { ...base, note: bassNote({ startTick: 380, durationTicks: 24 }) })).toThrow(
      'outside the pattern',
    );
    expect(() => applyProjectCommand(project, { ...base, note: bassNote({ durationTicks: 0 }) })).toThrow('outside the pattern');
    expect(() => applyProjectCommand(project, { ...base, note: bassNote({ velocity: 1.2 }) })).toThrow('velocity');
    expect(() =>
      applyProjectCommand(project, { ...base, note: bassNote({ id: 'note-bass-1' }) }),
    ).toThrow('unique');
  });

  it('toggles a note by id and serializes ticks with the project', () => {
    const project = starter();
    const note = bassNote({ id: 'toggle-me' });
    const added = applyProjectCommand(project, {
      type: 'pattern.note.toggle',
      patternId: 'pattern-main',
      channelId: 'channel-bass',
      note,
    });
    expect(added.patterns[0].notes['channel-bass'].some((item) => item.id === 'toggle-me')).toBe(true);
    const removed = applyProjectCommand(added, {
      type: 'pattern.note.toggle',
      patternId: 'pattern-main',
      channelId: 'channel-bass',
      note,
    });
    expect(removed.patterns[0].notes['channel-bass'].some((item) => item.id === 'toggle-me')).toBe(false);

    const encoded = serializeProject(added);
    expect(encoded).toContain('"startTick"');
    expect(encoded).toContain('"durationTicks"');
    const decoded = deserializeProject(encoded);
    expect(decoded.patterns[0].notes['channel-bass'].find((item) => item.id === 'toggle-me')).toEqual(note);
    expect(() => assertValidProject(decoded)).not.toThrow();
  });

  it('clamps notes when the pattern shrinks and keeps tick fields integer', () => {
    const grown = applyProjectCommand(starter(), { type: 'pattern.length.set', patternId: 'pattern-main', lengthSteps: 32 });
    const withTail = applyProjectCommand(grown, {
      type: 'pattern.note.add',
      patternId: 'pattern-main',
      channelId: 'channel-bass',
      note: bassNote({ id: 'tail', startTick: 16 * TICKS_PER_STEP, durationTicks: 96 }),
    });
    expect(withTail.patterns[0].notes['channel-bass'].some((note) => note.id === 'tail')).toBe(true);
    const shrunk = applyProjectCommand(withTail, { type: 'pattern.length.set', patternId: 'pattern-main', lengthSteps: 16 });
    expect(shrunk.patterns[0].notes['channel-bass'].some((note) => note.id === 'tail')).toBe(false);
    expect(() => assertValidProject(shrunk)).not.toThrow();
  });

  it('adds empty note and velocity lanes when a channel is created', () => {
    const channel = createEmptyChannel('channel-pad', 'Pad', '#82a6d9');
    const edited = applyProjectCommand(starter(), { type: 'channel.add', channel });
    expect(edited.patterns[0].notes[channel.id]).toEqual([]);
    expect(edited.patterns[0].velocities[channel.id]).toHaveLength(16);
    expect(() => assertValidProject(edited)).not.toThrow();
  });
});
