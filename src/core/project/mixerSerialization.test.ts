import { describe, expect, it } from 'vitest';
import { assertValidProject, createInitialProject, MASTER_MIXER_CHANNEL_ID, MIXER_EFFECT_SLOT_COUNT, type Project } from './model';
import { deserializeProject, serializeProject } from './serialization';
import { applyProjectCommand, createAddMixerChannelCommand } from '../commands';
import { audioSourceId, getInsertChannels } from '../mixer/mixerModel';
import { createTestArrangement } from '../arrangement/__fixtures__/testArrangement';

const MASTER = MASTER_MIXER_CHANNEL_ID;

/** A version 2 document as Phase 5 saved it: buses without any mix state or routing. */
function versionTwoProject(): Project {
  let project = createInitialProject();
  project = applyProjectCommand(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' });
  project = applyProjectCommand(project, { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -8 });
  const legacyMixerChannels = project.mixerChannels.map(({ id, name, role }) => ({ id, name, role }));
  const legacyTracks = project.tracks.map(({ mixerChannelId: _drop, ...track }) => track);
  return { ...project, version: 2 as unknown as Project['version'], mixerChannels: legacyMixerChannels, tracks: legacyTracks } as unknown as Project;
}

describe('version 3 mixer persistence', () => {
  it('round-trips mix state, routing, effect slots, and source assignments through JSON', () => {
    let project = createTestArrangement();
    project = applyProjectCommand(project, createAddMixerChannelCommand(project, 'mixer-bus-a', 'Drum Bus'));
    project = applyProjectCommand(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-bus-a' });
    project = applyProjectCommand(project, { type: 'mixer.channel.route', channelId: 'mixer-bus-a', outputId: MASTER });
    project = applyProjectCommand(project, { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -6.5 });
    project = applyProjectCommand(project, { type: 'mixer.channel.pan.set', channelId: 'mixer-insert-2', pan: -0.4 });
    project = applyProjectCommand(project, { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-3', muted: true });
    project = applyProjectCommand(project, { type: 'mixer.channel.solo.set', channelId: 'mixer-insert-4', solo: true });
    project = applyProjectCommand(project, { type: 'mixer.channel.reorder', channelId: 'mixer-insert-2', toIndex: 0 });
    project = applyProjectCommand(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-2', slot: 1, effect: { id: 'fx-a', type: 'delay', enabled: true, params: { time: 0.3, feedback: 0.25 } } });
    project = applyProjectCommand(project, { type: 'mixer.source.assign', sourceId: audioSourceId(project.tracks[0].id), mixerChannelId: 'mixer-bus-a' });
    project = applyProjectCommand(project, { type: 'mixer.source.assign', sourceId: 'channel-kick', mixerChannelId: 'mixer-bus-a' });

    const copy = deserializeProject(serializeProject(project));
    expect(copy).toEqual(project);
    expect(copy.mixerChannels[0].role).toBe('master');
    expect(getInsertChannels(copy).map((channel) => channel.id)).toEqual(['mixer-insert-2', 'mixer-insert-1', 'mixer-insert-3', 'mixer-insert-4', 'mixer-bus-a']);
    expect(copy.mixerChannels.find((channel) => channel.id === 'mixer-insert-2')?.effects).toHaveLength(2);
  });

  it('serializes the starter project with the new version marker', () => {
    const encoded = serializeProject(createInitialProject());
    expect(encoded).toContain('"version": 3');
    expect(encoded).toContain('"volumeDb": 0');
    expect(encoded).toContain('"outputId": "mixer-master"');
    expect(deserializeProject(encoded)).toEqual(createInitialProject());
  });
});

describe('version 2 → 3 migration', () => {
  it('gives every saved bus a unity mix state and routes the inserts to the master', () => {
    const migrated = deserializeProject(JSON.stringify(versionTwoProject()));

    expect(migrated.version).toBe(3);
    expect(migrated.mixerChannels[0]).toMatchObject({ id: 'mixer-master', role: 'master', volumeDb: 0, pan: 0, muted: false, solo: false, effects: [] });
    expect(migrated.mixerChannels[0].outputId).toBeUndefined();
    for (const channel of migrated.mixerChannels.slice(1)) {
      expect(channel).toMatchObject({ role: 'insert', outputId: 'mixer-master', volumeDb: 0, pan: 0, muted: false, solo: false, effects: [] });
    }
    // Playlist tracks existed without mixer assignments; they are routed to the master bus.
    for (const track of migrated.tracks) expect(track.mixerChannelId).toBe('mixer-master');
    // Rack channel assignments from version 2 are preserved untouched.
    expect(migrated.channels[0].mixerChannelId).toBe('mixer-insert-1');
    expect(deserializeProject(serializeProject(migrated))).toEqual(migrated);
  });

  it('moves the master bus to the front and demotes a second master-role bus to an insert', () => {
    const old = versionTwoProject();
    const reordered = [...(old.mixerChannels as unknown as Array<Record<string, unknown>>).slice(1), (old.mixerChannels as unknown as Array<Record<string, unknown>>)[0], { id: 'mixer-master-2', name: 'Spare', role: 'master' }];
    const migrated = deserializeProject(JSON.stringify({ ...old, mixerChannels: reordered }));

    expect(migrated.mixerChannels[0].id).toBe('mixer-master');
    expect(migrated.mixerChannels.filter((channel) => channel.role === 'master')).toHaveLength(1);
    const demoted = migrated.mixerChannels.find((channel) => channel.id === 'mixer-master-2');
    expect(demoted).toMatchObject({ role: 'insert', outputId: 'mixer-master' });
  });

  it('creates a master bus for a document that lost its own, and repairs dangling references', () => {
    const old = versionTwoProject();
    const channels = (old.channels as unknown as Array<Record<string, unknown>>).map((channel, index) =>
      index === 0 ? { ...channel, mixerChannelId: 'mixer-ghost' } : channel,
    );
    const tracks = (old.tracks as unknown as Array<Record<string, unknown>>).map((track) => ({ ...track, mixerChannelId: 'mixer-ghost' }));
    const mixerChannels = (old.mixerChannels as unknown as Array<Record<string, unknown>>).filter((channel) => channel.role !== 'master');

    const migrated = deserializeProject(JSON.stringify({ ...old, channels, tracks, mixerChannels }));
    expect(migrated.mixerChannels[0]).toMatchObject({ id: MASTER, role: 'master' });
    expect(migrated.channels[0].mixerChannelId).toBe(MASTER);
    for (const track of migrated.tracks) expect(track.mixerChannelId).toBe(MASTER);
    expect(() => assertValidProject(migrated)).not.toThrow();
  });

  it('keeps version 1 documents migrating through both steps in one pass', () => {
    const v1 = versionTwoProject();
    const { tracks: _tracks, audioAssets: _assets, ...legacy } = v1;
    const settings = { ...v1.settings };
    delete (settings as Record<string, unknown>).tempoChanges;
    delete (settings as Record<string, unknown>).loop;
    const document = {
      ...legacy,
      settings,
      version: 1,
      playlist: [{ id: 'old-a', patternId: v1.patterns[0].id, startBar: 2, lengthBars: 3 }],
    };
    const migrated = deserializeProject(JSON.stringify(document));
    expect(migrated.version).toBe(3);
    expect(migrated.mixerChannels[0].role).toBe('master');
    expect(migrated.tracks).toHaveLength(1);
    expect(migrated.tracks[0].mixerChannelId).toBe('mixer-master');
  });
});

describe('version 3 mixer validation', () => {
  function corrupt(mutate: (project: Project) => void): unknown {
    const project = createInitialProject();
    mutate(project);
    return project;
  }

  it('rejects routing that cannot exist: cycles, self-routes, missing destinations, and master outputs', () => {
    expect(() => assertValidProject(corrupt((project) => {
      const insert = project.mixerChannels.find((channel) => channel.id === 'mixer-insert-1')!;
      insert.outputId = 'mixer-insert-2';
      project.mixerChannels.find((channel) => channel.id === 'mixer-insert-2')!.outputId = 'mixer-insert-1';
    }))).toThrow('cycle');

    expect(() => assertValidProject(corrupt((project) => {
      project.mixerChannels.find((channel) => channel.id === 'mixer-insert-1')!.outputId = 'mixer-insert-1';
    }))).toThrow('cannot route to itself');

    expect(() => assertValidProject(corrupt((project) => {
      project.mixerChannels.find((channel) => channel.id === 'mixer-insert-1')!.outputId = 'mixer-ghost';
    }))).toThrow('missing mixer channel');

    expect(() => assertValidProject(corrupt((project) => {
      project.mixerChannels[0].outputId = 'mixer-insert-1';
    }))).toThrow('master bus cannot be routed');

    expect(() => assertValidProject(corrupt((project) => {
      delete (project.mixerChannels.find((channel) => channel.id === 'mixer-insert-1') as { outputId?: string }).outputId;
    }))).toThrow('needs a destination');
  });

  it('rejects structurally invalid mixer lists', () => {
    expect(() => assertValidProject(corrupt((project) => {
      const extraMaster = { ...project.mixerChannels[0], id: 'mixer-master-2', name: 'Spare' };
      project.mixerChannels.push(extraMaster);
    }))).toThrow('exactly one master');

    expect(() => assertValidProject(corrupt((project) => {
      const [master, first] = project.mixerChannels;
      project.mixerChannels = [first, master, ...project.mixerChannels.slice(2)];
    }))).toThrow('first mixer channel must be the master');

    // A masterless document is rejected outright by validation (migration, not validation, would
    // invent one for an imported file).
    expect(() => assertValidProject(corrupt((project) => {
      project.mixerChannels = project.mixerChannels.filter((channel) => channel.role !== 'master');
    }))).toThrow('master');
    expect(() => assertValidProject(corrupt((project) => {
      project.mixerChannels = [];
    }))).toThrow('at least one mixer channel');

    expect(() => assertValidProject(corrupt((project) => {
      project.tracks[0].mixerChannelId = 'mixer-ghost';
    }))).toThrow('missing mixer channel');
  });

  it('rejects out-of-range mix state and malformed effect slots', () => {
    const cases: Array<(project: Project) => void> = [
      (project) => { project.mixerChannels[1].volumeDb = 12.1; },
      (project) => { project.mixerChannels[1].volumeDb = -60.1; },
      (project) => { project.mixerChannels[1].volumeDb = Number.NaN; },
      (project) => { project.mixerChannels[1].pan = 1.01; },
      (project) => { project.mixerChannels[1].pan = -1.01; },
      (project) => { project.mixerChannels[1].muted = 'yes' as unknown as boolean; },
      (project) => { project.mixerChannels[1].solo = 1 as unknown as boolean; },
      (project) => { project.mixerChannels[1].effects = [{ id: 'fx', type: 'delay', enabled: true, params: { rate: Number.NaN } }]; },
      (project) => { project.mixerChannels[1].effects = [{ id: 'fx', type: '', enabled: true, params: {} }]; },
      (project) => { project.mixerChannels[1].effects = [{ id: 'fx', type: 'delay', enabled: 'on' as unknown as boolean, params: {} }]; },
      (project) => { project.mixerChannels[1].effects = [{ id: 'fx', type: 'delay', enabled: true, params: {} }, { id: 'fx', type: 'delay', enabled: false, params: {} }]; },
      (project) => {
        project.mixerChannels[1].effects = Array.from({ length: MIXER_EFFECT_SLOT_COUNT + 1 }, (_, index) => ({ id: `fx-${index}`, type: null, enabled: false, params: {} }));
      },
    ];
    for (const mutate of cases) {
      expect(() => assertValidProject(corrupt(mutate))).toThrow();
    }
  });
});
