import { describe, expect, it } from 'vitest';
import { createEmptyChannel, createProjectHistory, projectHistoryReducer, applyProjectCommand, ProjectCommandError } from './commands';
import { createInitialProject } from '../project/model';

describe('project commands and history', () => {
  it('toggles a step immutably and supports undo and redo', () => {
    const initial = createInitialProject();
    const command = { type: 'pattern.step.toggle' as const, patternId: 'pattern-main', channelId: 'channel-kick', step: 1 };
    const edited = applyProjectCommand(initial, command);

    expect(edited).not.toBe(initial);
    expect(edited.patterns[0].steps['channel-kick'][1]).toBe(true);
    expect(initial.patterns[0].steps['channel-kick'][1]).toBe(false);

    const afterEdit = projectHistoryReducer(createProjectHistory(initial), { type: 'command', command });
    const undone = projectHistoryReducer(afterEdit, { type: 'undo' });
    const redone = projectHistoryReducer(undone, { type: 'redo' });
    expect(undone.project.patterns[0].steps['channel-kick'][1]).toBe(false);
    expect(redone.project.patterns[0].steps['channel-kick'][1]).toBe(true);
  });

  it('adds a channel with matching empty lanes in every pattern', () => {
    const initial = createInitialProject();
    const channel = createEmptyChannel('channel-pad', 'Pad', '#82a6d9');
    const edited = applyProjectCommand(initial, { type: 'channel.add', channel });

    expect(edited.channels.some((item) => item.id === channel.id)).toBe(true);
    expect(edited.patterns[0].steps[channel.id]).toEqual(Array(16).fill(false));
    expect(edited.patterns[0].notes[channel.id]).toEqual([]);
  });

  it('clears the redo stack after a new edit and rejects out-of-range tempo', () => {
    const initial = createProjectHistory(createInitialProject());
    const afterTempo = projectHistoryReducer(initial, { type: 'command', command: { type: 'project.tempo.set', tempo: 130 } });
    const undone = projectHistoryReducer(afterTempo, { type: 'undo' });
    const branched = projectHistoryReducer(undone, { type: 'command', command: { type: 'project.tempo.set', tempo: 132 } });

    expect(branched.future).toHaveLength(0);
    expect(() => applyProjectCommand(initial.project, { type: 'project.tempo.set', tempo: 301 })).toThrow(ProjectCommandError);
  });
});
