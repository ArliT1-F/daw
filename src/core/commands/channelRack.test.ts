import { describe, expect, it } from 'vitest';
import {
  ProjectCommandError,
  applyProjectCommand,
  createEmptyPattern,
  createProjectHistory,
  projectHistoryReducer,
} from './commands';
import { DEFAULT_STEP_VELOCITY, assertValidProject, createInitialProject, type Project } from '../project/model';

function starter(): Project {
  return createInitialProject();
}

function clone(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project;
}

describe('step editing with velocity', () => {
  it('turns a step on with an explicit velocity and off without losing it', () => {
    const initial = starter();
    const on = applyProjectCommand(initial, {
      type: 'pattern.step.set',
      patternId: 'pattern-main',
      channelId: 'channel-kick',
      step: 1,
      active: true,
      velocity: 0.4,
    });
    expect(on.patterns[0].steps['channel-kick'][1]).toBe(true);
    expect(on.patterns[0].velocities['channel-kick'][1]).toBe(0.4);

    const off = applyProjectCommand(on, {
      type: 'pattern.step.set',
      patternId: 'pattern-main',
      channelId: 'channel-kick',
      step: 1,
      active: false,
    });
    expect(off.patterns[0].steps['channel-kick'][1]).toBe(false);
    // Toggling off keeps the stored velocity so the next toggle restores the feel.
    expect(off.patterns[0].velocities['channel-kick'][1]).toBe(0.4);

    const initialVelocity = initial.patterns[0].velocities['channel-kick'][1];
    expect(initialVelocity).toBe(DEFAULT_STEP_VELOCITY);
    expect(initial.patterns[0].steps['channel-kick'][1]).toBe(false);
  });

  it('rejects velocities outside 0..1, steps outside the pattern, and missing channels', () => {
    const project = starter();
    const base = { type: 'pattern.step.set' as const, patternId: 'pattern-main', channelId: 'channel-kick', step: 0, active: true };
    expect(() => applyProjectCommand(project, { ...base, velocity: 1.5 })).toThrow(ProjectCommandError);
    expect(() => applyProjectCommand(project, { ...base, velocity: -0.2 })).toThrow(ProjectCommandError);
    expect(() => applyProjectCommand(project, { ...base, velocity: Number.NaN })).toThrow(ProjectCommandError);
    expect(() => applyProjectCommand(project, { ...base, step: 99 })).toThrow('Step is outside the pattern.');
    expect(() =>
      applyProjectCommand(project, { ...base, channelId: 'channel-missing' }),
    ).toThrow('does not exist');
  });

  it('is a no-op when nothing changes, so repeated clicks do not spam history', () => {
    const project = starter();
    const before = project.patterns[0].steps['channel-kick'][0];
    expect(before).toBe(true);
    const next = applyProjectCommand(project, {
      type: 'pattern.step.set',
      patternId: 'pattern-main',
      channelId: 'channel-kick',
      step: 0,
      active: true,
      velocity: DEFAULT_STEP_VELOCITY,
    });
    expect(next).toBe(project);
  });
});

describe('pattern management commands', () => {
  it('duplicates a pattern with a new stable id, a derived name, and independent rows', () => {
    const initial = starter();
    const duplicate = applyProjectCommand(initial, {
      type: 'pattern.duplicate',
      patternId: 'pattern-main',
      newPatternId: 'pattern-copy-1',
    });

    expect(duplicate.patterns).toHaveLength(2);
    const copy = duplicate.patterns[1];
    expect(copy.id).toBe('pattern-copy-1');
    expect(copy.name).toBe('Pattern 01 copy');
    expect(copy.steps['channel-kick']).toEqual(initial.patterns[0].steps['channel-kick']);
    expect(copy.velocities['channel-kick']).toEqual(initial.patterns[0].velocities['channel-kick']);
    expect(copy.notes['channel-bass']).toEqual(initial.patterns[0].notes['channel-bass']);

    // Deep copy: editing the copy never touches the source pattern.
    const edited = applyProjectCommand(duplicate, {
      type: 'pattern.step.set',
      patternId: 'pattern-copy-1',
      channelId: 'channel-kick',
      step: 1,
      active: true,
    });
    expect(edited.patterns[1].steps['channel-kick'][1]).toBe(true);
    expect(edited.patterns[0].steps['channel-kick'][1]).toBe(false);
    expect(duplicate.patterns[0]).not.toBe(copy);

    expect(() =>
      applyProjectCommand(initial, { type: 'pattern.duplicate', patternId: 'pattern-main', newPatternId: 'pattern-main' }),
    ).toThrow('unused ID');
    expect(() =>
      applyProjectCommand(initial, { type: 'pattern.duplicate', patternId: 'pattern-nope', newPatternId: 'x' }),
    ).toThrow('does not exist');
  });

  it('clears every step, velocity, and note in one undoable command', () => {
    const initial = starter();
    const cleared = applyProjectCommand(initial, { type: 'pattern.clear', patternId: 'pattern-main' });
    const pattern = cleared.patterns[0];

    expect(pattern.steps['channel-kick'].every((step) => step === false)).toBe(true);
    expect(pattern.velocities['channel-hat'].every((velocity) => velocity === DEFAULT_STEP_VELOCITY)).toBe(true);
    expect(pattern.notes['channel-bass']).toEqual([]);
    expect(pattern.lengthSteps).toBe(16);
    // The original is untouched.
    expect(initial.patterns[0].steps['channel-kick'][0]).toBe(true);
    expect(initial.patterns[0].notes['channel-bass'].length).toBeGreaterThan(0);
    expect(() => assertValidProject(cleared)).not.toThrow();
  });

  it('renames patterns with validation', () => {
    const initial = starter();
    const renamed = applyProjectCommand(initial, { type: 'pattern.rename', patternId: 'pattern-main', name: '  Groove A  ' });
    expect(renamed.patterns[0].name).toBe('Groove A');
    expect(() => applyProjectCommand(initial, { type: 'pattern.rename', patternId: 'pattern-main', name: '   ' })).toThrow(
      ProjectCommandError,
    );
    expect(() => applyProjectCommand(initial, { type: 'pattern.rename', patternId: 'missing', name: 'X' })).toThrow(
      ProjectCommandError,
    );
  });

  it('switches pattern length between 16 and 32 steps, resizing rows and notes', () => {
    const initial = starter();
    const grown = applyProjectCommand(initial, { type: 'pattern.length.set', patternId: 'pattern-main', lengthSteps: 32 });
    const grownPattern = grown.patterns[0];
    expect(grownPattern.lengthSteps).toBe(32);
    expect(grownPattern.steps['channel-kick']).toHaveLength(32);
    expect(grownPattern.steps['channel-kick'][20]).toBe(false);
    expect(grownPattern.velocities['channel-kick']).toHaveLength(32);
    expect(grownPattern.velocities['channel-kick'][20]).toBe(DEFAULT_STEP_VELOCITY);
    // Existing notes survive the grow.
    expect(grownPattern.notes['channel-bass']).toHaveLength(4);
    expect(() => assertValidProject(grown)).not.toThrow();

    // Add content beyond step 16, then shrink: it must be dropped so validation still passes.
    const withTail = applyProjectCommand(grown, {
      type: 'pattern.step.set',
      patternId: 'pattern-main',
      channelId: 'channel-kick',
      step: 24,
      active: true,
      velocity: 0.6,
    });
    const shrunk = applyProjectCommand(withTail, { type: 'pattern.length.set', patternId: 'pattern-main', lengthSteps: 16 });
    expect(shrunk.patterns[0].lengthSteps).toBe(16);
    expect(shrunk.patterns[0].steps['channel-kick']).toHaveLength(16);
    expect(shrunk.patterns[0].steps['channel-kick'][24]).toBeUndefined();
    expect(() => assertValidProject(shrunk)).not.toThrow();

    expect(() =>
      applyProjectCommand(initial, { type: 'pattern.length.set', patternId: 'pattern-main', lengthSteps: 24 }),
    ).toThrow('16 or 32');
    // Original unchanged.
    expect(initial.patterns[0].lengthSteps).toBe(16);
  });

  it('adds a validated empty pattern and rejects duplicates or malformed rows', () => {
    const initial = starter();
    const pattern = createEmptyPattern('pattern-new', 'Pattern 02', initial.channels, 32);
    const added = applyProjectCommand(initial, { type: 'pattern.add', pattern });
    expect(added.patterns).toHaveLength(2);
    expect(added.patterns[1].steps['channel-kick']).toHaveLength(32);
    expect(() => assertValidProject(added)).not.toThrow();

    expect(() => applyProjectCommand(added, { type: 'pattern.add', pattern })).toThrow('already in use');
    const missingRow = createEmptyPattern('pattern-bad', 'Bad', initial.channels);
    delete missingRow.steps['channel-hat'];
    expect(() => applyProjectCommand(initial, { type: 'pattern.add', pattern: missingRow })).toThrow('every channel');
  });
});

describe('channel mix and sample commands', () => {
  it('toggles mute and solo per channel', () => {
    const initial = starter();
    const muted = applyProjectCommand(initial, { type: 'channel.mute.set', channelId: 'channel-kick', muted: true });
    expect(muted.channels.find((channel) => channel.id === 'channel-kick')?.muted).toBe(true);
    expect(initial.channels.find((channel) => channel.id === 'channel-kick')?.muted).toBe(false);

    const soloed = applyProjectCommand(muted, { type: 'channel.solo.set', channelId: 'channel-hat', solo: true });
    expect(soloed.channels.find((channel) => channel.id === 'channel-hat')?.solo).toBe(true);
    expect(muted.channels.find((channel) => channel.id === 'channel-hat')?.solo).toBe(false);

    expect(() => applyProjectCommand(initial, { type: 'channel.mute.set', channelId: 'nope', muted: true })).toThrow(
      ProjectCommandError,
    );
  });

  it('assigns and clears sample references without storing audio data', () => {
    const initial = starter();
    const assigned = applyProjectCommand(initial, {
      type: 'channel.sample.assign',
      channelId: 'channel-kick',
      sampleId: 'sample-abc',
      sampleName: 'thump.wav',
    });
    const kick = assigned.channels.find((channel) => channel.id === 'channel-kick');
    expect(kick?.sampleId).toBe('sample-abc');
    expect(kick?.sampleName).toBe('thump.wav');
    expect(kick?.kind).toBe('drum');
    expect(() => assertValidProject(assigned)).not.toThrow();

    const cleared = applyProjectCommand(assigned, { type: 'channel.sample.clear', channelId: 'channel-kick' });
    const clearedKick = cleared.channels.find((channel) => channel.id === 'channel-kick');
    expect(clearedKick?.sampleId).toBeUndefined();
    expect(clearedKick?.sampleName).toBeUndefined();
    expect(() => assertValidProject(cleared)).not.toThrow();

    expect(() =>
      applyProjectCommand(initial, { type: 'channel.sample.assign', channelId: 'channel-kick', sampleId: ' ', sampleName: 'x.wav' }),
    ).toThrow(ProjectCommandError);
    expect(() =>
      applyProjectCommand(initial, { type: 'channel.sample.assign', channelId: 'channel-kick', sampleId: 'x', sampleName: '  ' }),
    ).toThrow(ProjectCommandError);
  });
});

describe('swing setting', () => {
  it('accepts 0..1 and rejects everything else', () => {
    const initial = starter();
    const swung = applyProjectCommand(initial, { type: 'project.swing.set', swing: 0.42 });
    expect(swung.settings.swing).toBe(0.42);
    expect(initial.settings.swing).toBe(0);

    expect(() => applyProjectCommand(initial, { type: 'project.swing.set', swing: 1.2 })).toThrow('Swing');
    expect(() => applyProjectCommand(initial, { type: 'project.swing.set', swing: -0.1 })).toThrow('Swing');
    expect(() => applyProjectCommand(initial, { type: 'project.swing.set', swing: Number.NaN })).toThrow('Swing');
  });

  it('undoes and redoes pattern duplication through history', () => {
    const history = createProjectHistory(starter());
    const duplicated = projectHistoryReducer(history, {
      type: 'command',
      command: { type: 'pattern.duplicate', patternId: 'pattern-main', newPatternId: 'pattern-copy-1' },
    });
    expect(duplicated.project.patterns).toHaveLength(2);
    const undone = projectHistoryReducer(duplicated, { type: 'undo' });
    expect(undone.project.patterns).toHaveLength(1);
    const redone = projectHistoryReducer(undone, { type: 'redo' });
    expect(redone.project.patterns).toHaveLength(2);
    expect(redone.project.patterns[1].id).toBe('pattern-copy-1');
  });
});

// Keep the helper honest: cloned projects must pass full validation after any command above.
describe('clone helper', () => {
  it('produces a valid standalone project', () => {
    expect(() => assertValidProject(clone(starter()))).not.toThrow();
  });
});
