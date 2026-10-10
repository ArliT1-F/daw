import { describe, expect, it } from 'vitest';
import {
  createProjectHistory,
  projectHistoryReducer,
  ProjectCommandError,
  applyProjectCommand,
  type ProjectCommand,
} from './commands';
import { createAddMixerChannelCommand, mixerEffectSlotId } from './mixerCommands';
import {
  assertValidProject,
  createInitialProject,
  createMasterMixerChannel,
  createMixerChannel,
  MAX_MIXER_INSERTS,
  MIXER_EFFECT_SLOT_COUNT,
  MIXER_MAX_DB,
  MIXER_MIN_DB,
  type MixerChannel,
  type Project,
} from '../project/model';
import { audioSourceId, getInsertChannels } from '../mixer/mixerModel';

const MASTER = 'mixer-master';

function starter(): Project {
  return createInitialProject();
}

function apply(project: Project, command: ProjectCommand): Project {
  return applyProjectCommand(project, command);
}

function mixerChannel(project: Project, id: string): MixerChannel {
  const channel = project.mixerChannels.find((item) => item.id === id);
  if (!channel) throw new Error(`missing mixer channel ${id}`);
  return channel;
}

/** A second insert so routing has somewhere legal to go besides the master bus. */
function withExtraInsert(project: Project, id = 'mixer-insert-5'): Project {
  return apply(project, createAddMixerChannelCommand(project, id, 'Sub Bus'));
}

describe('mixer channel mix state', () => {
  it('sets volume and pan immutably and rejects out-of-range values', () => {
    const project = starter();
    const quieter = apply(project, { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -12.5 });

    expect(quieter).not.toBe(project);
    expect(mixerChannel(quieter, 'mixer-insert-1').volumeDb).toBe(-12.5);
    expect(mixerChannel(project, 'mixer-insert-1').volumeDb).toBe(0);
    expect(quieter.mixerChannels).not.toBe(project.mixerChannels);
    // Untouched channels keep their identity, so memoised consumers do not re-render.
    expect(mixerChannel(quieter, 'mixer-insert-2')).toBe(mixerChannel(project, 'mixer-insert-2'));

    const panned = apply(quieter, { type: 'mixer.channel.pan.set', channelId: 'mixer-insert-1', pan: -0.75 });
    expect(mixerChannel(panned, 'mixer-insert-1')).toMatchObject({ volumeDb: -12.5, pan: -0.75 });

    for (const volumeDb of [MIXER_MIN_DB - 0.5, MIXER_MAX_DB + 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => apply(project, { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb })).toThrow(ProjectCommandError);
    }
    for (const pan of [-1.01, 1.01, Number.NaN]) {
      expect(() => apply(project, { type: 'mixer.channel.pan.set', channelId: 'mixer-insert-1', pan })).toThrow(ProjectCommandError);
    }
    expect(mixerChannel(project, 'mixer-insert-1')).toMatchObject({ volumeDb: 0, pan: 0 });
  });

  it('accepts the full fader range including exact silence and the maximum boost', () => {
    let project = starter();
    for (const volumeDb of [MIXER_MIN_DB, MIXER_MAX_DB, 0]) {
      project = apply(project, { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb });
      expect(mixerChannel(project, 'mixer-insert-1').volumeDb).toBe(volumeDb);
      expect(() => assertValidProject(project)).not.toThrow();
    }
  });

  it('toggles mute and solo independently and treats a repeat as a no-op', () => {
    const project = starter();
    const muted = apply(project, { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-2', muted: true });
    expect(mixerChannel(muted, 'mixer-insert-2')).toMatchObject({ muted: true, solo: false });
    expect(apply(muted, { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-2', muted: true })).toBe(muted);

    const soloed = apply(muted, { type: 'mixer.channel.solo.set', channelId: 'mixer-insert-2', solo: true });
    expect(mixerChannel(soloed, 'mixer-insert-2')).toMatchObject({ muted: true, solo: true });

    const cleared = apply(soloed, { type: 'mixer.solo.clear' });
    expect(getInsertChannels(cleared).some((channel) => channel.solo)).toBe(false);
    expect(mixerChannel(cleared, 'mixer-insert-2').muted).toBe(true);
    expect(apply(cleared, { type: 'mixer.solo.clear' })).toBe(cleared);
  });

  it('renames a channel and rejects empty or overlong names', () => {
    const project = starter();
    const renamed = apply(project, { type: 'mixer.channel.rename', channelId: 'mixer-insert-1', name: '  Thump  ' });
    expect(mixerChannel(renamed, 'mixer-insert-1').name).toBe('Thump');
    expect(apply(project, { type: 'mixer.channel.rename', channelId: 'mixer-insert-1', name: 'Kick' })).toBe(project);
    expect(() => apply(project, { type: 'mixer.channel.rename', channelId: 'mixer-insert-1', name: '   ' })).toThrow('between 1 and 80');
    expect(() => apply(project, { type: 'mixer.channel.rename', channelId: 'mixer-insert-1', name: 'x'.repeat(81) })).toThrow('between 1 and 80');
    expect(() => apply(project, { type: 'mixer.channel.rename', channelId: 'ghost', name: 'X' })).toThrow('does not exist');
  });
});

describe('mixer channel ordering and lifetime', () => {
  it('adds an insert routed to the master bus with a stable id', () => {
    const project = starter();
    const added = apply(project, createAddMixerChannelCommand(project, 'mixer-bus-a', 'Drum Bus'));

    expect(added.mixerChannels).toHaveLength(project.mixerChannels.length + 1);
    expect(mixerChannel(added, 'mixer-bus-a')).toMatchObject({
      name: 'Drum Bus',
      role: 'insert',
      volumeDb: 0,
      pan: 0,
      muted: false,
      solo: false,
      outputId: MASTER,
      effects: [],
    });
    expect(added.mixerChannels.at(-1)?.id).toBe('mixer-bus-a');
    expect(() => assertValidProject(added)).not.toThrow();
  });

  it('gives an unnamed new channel a non-colliding default name', () => {
    expect(mixerChannel(apply(starter(), createAddMixerChannelCommand(starter(), 'mixer-bus-a')), 'mixer-bus-a').name).toBe('Insert 5');
    const colliding = apply(starter(), { type: 'mixer.channel.rename', channelId: 'mixer-insert-1', name: 'Sub' });
    expect(mixerChannel(apply(colliding, createAddMixerChannelCommand(colliding, 'mixer-bus-a', 'Sub')), 'mixer-bus-a').name).toBe('Sub 2');
  });

  it('refuses a duplicate id, a second master, or an insert beyond the limit', () => {
    const project = starter();
    expect(() => apply(project, { type: 'mixer.channel.add', channel: createMixerChannel('mixer-insert-1', 'Copy', MASTER) })).toThrow('already in use');
    expect(() => apply(project, { type: 'mixer.channel.add', channel: createMasterMixerChannel('mixer-master-2') })).toThrow('one master bus');
    expect(() => apply(project, { type: 'mixer.channel.add', channel: { ...createMixerChannel('mixer-bus-a', 'A', MASTER), id: '   ' } })).toThrow('needs an ID');
    expect(() => createAddMixerChannelCommand(fullMixer(), 'mixer-overflow')).toThrow(`at most ${MAX_MIXER_INSERTS}`);
  });

  it('reorders inserts while the master bus stays first', () => {
    const project = starter();
    const moved = apply(project, { type: 'mixer.channel.reorder', channelId: 'mixer-insert-4', toIndex: 0 });

    expect(moved.mixerChannels[0].id).toBe(MASTER);
    expect(getInsertChannels(moved).map((channel) => channel.id)).toEqual([
      'mixer-insert-4',
      'mixer-insert-1',
      'mixer-insert-2',
      'mixer-insert-3',
    ]);
    expect(apply(project, { type: 'mixer.channel.reorder', channelId: 'mixer-insert-4', toIndex: 3 })).toBe(project);
    expect(() => apply(project, { type: 'mixer.channel.reorder', channelId: 'mixer-insert-1', toIndex: -1 })).toThrow('outside the mixer');
    expect(() => apply(project, { type: 'mixer.channel.reorder', channelId: 'mixer-insert-1', toIndex: 4 })).toThrow('outside the mixer');
    expect(() => apply(project, { type: 'mixer.channel.reorder', channelId: 'mixer-insert-1', toIndex: 1.5 })).toThrow('outside the mixer');
    expect(() => apply(project, { type: 'mixer.channel.reorder', channelId: MASTER, toIndex: 0 })).toThrow('master bus stays');
  });

  it('removes an insert and splices its feeders into its own destination', () => {
    const project = withExtraInsert(starter());
    let routed = apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-5' });
    routed = apply(routed, { type: 'mixer.source.assign', sourceId: 'channel-snare', mixerChannelId: 'mixer-insert-5' });
    routed = apply(routed, { type: 'mixer.source.assign', sourceId: audioSourceId('track-audio'), mixerChannelId: 'mixer-insert-5' });

    const removed = apply(routed, { type: 'mixer.channel.remove', channelId: 'mixer-insert-5' });

    expect(removed.mixerChannels.some((channel) => channel.id === 'mixer-insert-5')).toBe(false);
    // Whatever fed the removed bus now feeds where that bus was going: the master bus.
    expect(mixerChannel(removed, 'mixer-insert-1').outputId).toBe(MASTER);
    expect(removed.channels.find((channel) => channel.id === 'channel-snare')?.mixerChannelId).toBe(MASTER);
    expect(removed.tracks.find((track) => track.id === 'track-audio')?.mixerChannelId).toBe(MASTER);
    expect(() => assertValidProject(removed)).not.toThrow();
    expect(() => apply(project, { type: 'mixer.channel.remove', channelId: MASTER })).toThrow('cannot be removed');
  });

  it('keeps a sub-bus chain connected when a link in the middle is removed', () => {
    let project = withExtraInsert(starter());
    project = apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' });
    project = apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-2', outputId: 'mixer-insert-5' });

    const removed = apply(project, { type: 'mixer.channel.remove', channelId: 'mixer-insert-5' });
    expect(mixerChannel(removed, 'mixer-insert-1').outputId).toBe('mixer-insert-2');
    expect(mixerChannel(removed, 'mixer-insert-2').outputId).toBe(MASTER);
    expect(() => assertValidProject(removed)).not.toThrow();
  });
});

describe('mixer routing edits', () => {
  it('routes an insert to another insert or back to the master bus', () => {
    const project = withExtraInsert(starter());
    const routed = apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-5' });
    expect(mixerChannel(routed, 'mixer-insert-1').outputId).toBe('mixer-insert-5');
    expect(apply(routed, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-5' })).toBe(routed);

    const back = apply(routed, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: MASTER });
    expect(mixerChannel(back, 'mixer-insert-1').outputId).toBe(MASTER);
  });

  it('rejects self-routing, missing destinations, cycles, and rerouting the master bus', () => {
    const project = withExtraInsert(starter());
    expect(() => apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-1' })).toThrow('cannot route to itself');
    expect(() => apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'ghost' })).toThrow('does not exist');
    expect(() => apply(project, { type: 'mixer.channel.route', channelId: MASTER, outputId: 'mixer-insert-1' })).toThrow('cannot be rerouted');
    expect(() => apply(project, { type: 'mixer.channel.route', channelId: 'ghost', outputId: MASTER })).toThrow('does not exist');

    const chained = apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-5' });
    expect(() => apply(chained, { type: 'mixer.channel.route', channelId: 'mixer-insert-5', outputId: 'mixer-insert-1' })).toThrow('cycle');
    // The rejected edit left the project untouched.
    expect(mixerChannel(chained, 'mixer-insert-5').outputId).toBe(MASTER);
  });

  it('rejects a cycle that would only close several channels upstream', () => {
    let project = starter();
    project = apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' });
    project = apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-2', outputId: 'mixer-insert-3' });
    project = apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-3', outputId: 'mixer-insert-4' });
    expect(() => apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-4', outputId: 'mixer-insert-2' })).toThrow('cycle');
    expect(() => apply(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-4', outputId: 'mixer-insert-1' })).toThrow('cycle');
    expect(() => assertValidProject(project)).not.toThrow();
  });
});

describe('track and channel mixer assignments', () => {
  it('assigns a Channel Rack channel and a Playlist track to a mixer channel', () => {
    const project = withExtraInsert(starter());
    const assigned = apply(project, { type: 'mixer.source.assign', sourceId: 'channel-kick', mixerChannelId: 'mixer-insert-5' });
    expect(assigned.channels.find((channel) => channel.id === 'channel-kick')?.mixerChannelId).toBe('mixer-insert-5');
    expect(assigned.mixerChannels).toEqual(project.mixerChannels);

    const trackAssigned = apply(project, { type: 'mixer.source.assign', sourceId: audioSourceId('track-audio'), mixerChannelId: 'mixer-insert-5' });
    expect(trackAssigned.tracks.find((track) => track.id === 'track-audio')?.mixerChannelId).toBe('mixer-insert-5');
    expect(trackAssigned.channels).toEqual(project.channels);
  });

  it('treats an unchanged assignment as a no-op and rejects unknown ids', () => {
    const project = starter();
    expect(apply(project, { type: 'mixer.source.assign', sourceId: 'channel-kick', mixerChannelId: 'mixer-insert-1' })).toBe(project);
    expect(apply(project, { type: 'mixer.source.assign', sourceId: audioSourceId('track-main'), mixerChannelId: MASTER })).toBe(project);
    expect(() => apply(project, { type: 'mixer.source.assign', sourceId: 'ghost', mixerChannelId: MASTER })).toThrow('does not exist');
    expect(() => apply(project, { type: 'mixer.source.assign', sourceId: audioSourceId('ghost'), mixerChannelId: MASTER })).toThrow('does not exist');
    expect(() => apply(project, { type: 'mixer.source.assign', sourceId: 'channel-kick', mixerChannelId: 'ghost' })).toThrow('does not exist');
  });

  it('routes a source straight to the master bus, bypassing every insert', () => {
    const project = starter();
    const direct = apply(project, { type: 'mixer.source.assign', sourceId: 'channel-bass', mixerChannelId: MASTER });
    expect(direct.channels.find((channel) => channel.id === 'channel-bass')?.mixerChannelId).toBe(MASTER);
    expect(() => assertValidProject(direct)).not.toThrow();
  });
});

describe('prepared effect slots', () => {
  it('places, replaces, and clears slots without touching mix state', () => {
    const project = starter();
    const slot = { id: 'fx-1', type: 'lowpass', enabled: true, params: { cutoff: 0.6 } };
    const filled = apply(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 0, effect: slot });

    expect(mixerChannel(filled, 'mixer-insert-1').effects).toEqual([slot]);
    expect(mixerChannel(filled, 'mixer-insert-1').volumeDb).toBe(0);
    expect(mixerChannel(filled, 'mixer-insert-1').outputId).toBe(MASTER);

    // Filling a later slot pads the gap with deterministic empty bypass slots.
    const padded = apply(filled, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 2, effect: { ...slot, id: 'fx-3' } });
    expect(padded.mixerChannels[1].effects).toHaveLength(3);
    expect(padded.mixerChannels[1].effects[1]).toEqual({ id: mixerEffectSlotId('mixer-insert-1', 1), type: null, enabled: false, params: {} });

    const replaced = apply(padded, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 0, effect: { ...slot, type: 'delay' } });
    expect(replaced.mixerChannels[1].effects[0].type).toBe('delay');

    // Clearing a slot *before* a filled one keeps it as an explicit empty bypass, so slot
    // positions stay stable while the chain is edited.
    const gapKept = apply(replaced, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 1, effect: null });
    expect(gapKept.mixerChannels[1].effects).toHaveLength(3);
    expect(gapKept.mixerChannels[1].effects[1]).toMatchObject({ type: null, enabled: false });
    expect(gapKept.mixerChannels[1].effects[2].type).toBe('lowpass');

    // Clearing the trailing slots trims them away, so an emptied channel stores no effect data.
    const cleared = apply(replaced, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 2, effect: null });
    expect(cleared.mixerChannels[1].effects).toEqual([{ id: 'fx-1', type: 'delay', enabled: true, params: { cutoff: 0.6 } }]);
    const clearedFirst = apply(cleared, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 0, effect: null });
    expect(clearedFirst.mixerChannels[1].effects).toEqual([]);
  });

  it('rejects an out-of-range slot, a duplicate id, and a malformed effect', () => {
    const project = starter();
    const slot = { id: 'fx-1', type: 'lowpass', enabled: true, params: { cutoff: 0.6 } };
    expect(() => apply(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: MIXER_EFFECT_SLOT_COUNT, effect: slot })).toThrow('effect slot must be');
    expect(() => apply(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: -1, effect: slot })).toThrow('effect slot must be');
    expect(() => apply(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 0.5, effect: slot })).toThrow('effect slot must be');

    const filled = apply(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 0, effect: slot });
    expect(() => apply(filled, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 1, effect: slot })).toThrow('unique within a channel');
    expect(() => apply(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 0, effect: { ...slot, id: '  ' } })).toThrow('needs an ID');
    expect(() => apply(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 0, effect: { ...slot, params: { cutoff: Number.NaN } } })).toThrow('finite number');
    expect(apply(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 0, effect: null })).toBe(project);
  });
});

describe('mixer history and validation', () => {
  it('undoes and redoes a mixer edit like any other project command', () => {
    const history = createProjectHistory(starter());
    const afterMute = projectHistoryReducer(history, { type: 'command', command: { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-1', muted: true } });
    const afterRoute = projectHistoryReducer(afterMute, { type: 'command', command: { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' } });

    expect(mixerChannel(afterRoute.project, 'mixer-insert-1')).toMatchObject({ muted: true, outputId: 'mixer-insert-2' });
    const undone = projectHistoryReducer(afterRoute, { type: 'undo' });
    expect(mixerChannel(undone.project, 'mixer-insert-1')).toMatchObject({ muted: true, outputId: MASTER });
    expect(projectHistoryReducer(undone, { type: 'undo' }).project).toEqual(history.project);
    expect(mixerChannel(projectHistoryReducer(undone, { type: 'redo' }).project, 'mixer-insert-1').outputId).toBe('mixer-insert-2');
  });

  it('coalesces a fader drag into one undo entry and starts a new entry per gesture', () => {
    let state = createProjectHistory(starter());
    for (const volumeDb of [-1, -2, -3, -4]) {
      state = projectHistoryReducer(state, { type: 'command', command: { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb }, coalesceKey: 'drag-1' });
    }
    expect(mixerChannel(state.project, 'mixer-insert-1').volumeDb).toBe(-4);
    expect(state.past).toHaveLength(1);
    expect(mixerChannel(state.past[0], 'mixer-insert-1').volumeDb).toBe(0);

    // A second gesture on the same control is its own undo entry.
    for (const volumeDb of [-5, -6]) {
      state = projectHistoryReducer(state, { type: 'command', command: { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb }, coalesceKey: 'drag-2' });
    }
    expect(state.past).toHaveLength(2);
    expect(mixerChannel(state.past[1], 'mixer-insert-1').volumeDb).toBe(-4);

    // Undo returns to the start of the last gesture, not one pixel back.
    expect(mixerChannel(projectHistoryReducer(state, { type: 'undo' }).project, 'mixer-insert-1').volumeDb).toBe(-4);

    // A command without a key never coalesces, and undo/redo reset the gesture.
    const discrete = projectHistoryReducer(state, { type: 'command', command: { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-2', muted: true } });
    expect(discrete.past).toHaveLength(3);
    expect(discrete.coalesceKey).toBeNull();
  });

  it('validates the whole document after every mixer edit', () => {
    const project = withExtraInsert(starter());
    const commands: ProjectCommand[] = [
      { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -9 },
      { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-5' },
      { type: 'mixer.source.assign', sourceId: audioSourceId('track-main'), mixerChannelId: 'mixer-insert-1' },
    ];
    const edited = commands.reduce(apply, project);
    expect(() => assertValidProject(edited)).not.toThrow();
    // A hand-corrupted document is still rejected if it ever reaches the model.
    const corrupt: Project = { ...edited, mixerChannels: edited.mixerChannels.map((channel) => (channel.id === 'mixer-insert-5' ? { ...channel, outputId: 'mixer-insert-1' } : channel)) };
    expect(() => assertValidProject(corrupt)).toThrow('cycle');
  });
});

function fullMixer(): Project {
  let project = starter();
  while (getInsertChannels(project).length < MAX_MIXER_INSERTS) {
    project = apply(project, createAddMixerChannelCommand(project, `mixer-fill-${getInsertChannels(project).length}`));
  }
  return project;
}
