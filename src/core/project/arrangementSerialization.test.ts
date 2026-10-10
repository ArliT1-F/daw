import { describe, expect, it } from 'vitest';
import { assertValidProject, createInitialProject } from './model';
import { deserializeProject, serializeProject } from './serialization';
import { createTestArrangement } from '../arrangement/__fixtures__/testArrangement';
import { ArrangementEventSource } from '../events';
import { TICKS_PER_STEP as T } from '../time/ticks';

/** A genuine version 1 document: bar positions, no tracks or assets, and mixer buses that carried
 *  only an id, a name, and a role. */
function legacyProject() {
  const project = createInitialProject();
  const { tracks: _tracks, audioAssets: _assets, ...old } = project;
  const { tempoChanges: _changes, loop: _loop, ...settings } = project.settings;
  const mixerChannels = project.mixerChannels.map(({ id, name, role }) => ({ id, name, role }));
  return { ...old, mixerChannels, version: 1, settings, playlist: [
    { id: 'old-a', patternId: 'pattern-main', startBar: 2, lengthBars: 3 },
    { id: 'old-b', patternId: 'pattern-main', startBar: 5, lengthBars: 1 },
  ] };
}

describe('arrangement document serialization and migration', () => {
  it('round-trips overlapping shared patterns, audio sources/trims, track mix, loop, and tempo markers', () => {
    const project = createTestArrangement();
    project.tracks[1].solo = true;
    project.playlist[0].name = 'Reusable intro';
    const json = serializeProject(project);
    const copy = deserializeProject(json);
    expect(copy).toEqual(project);
    expect(copy.patterns).toHaveLength(2);
    expect(copy.audioAssets).toHaveLength(1);
    expect(json).not.toContain('AudioBuffer');
    expect(json).not.toContain('currentTime');
    expect(new ArrangementEventSource(copy).queryWindow({ startStep: 40, endStep: 50, includeSustains: true })).toEqual(new ArrangementEventSource(project).queryWindow({ startStep: 40, endStep: 50, includeSustains: true }));
  });
  it('migrates version 1 bar positions to one track and keeps the original shared pattern identities', () => {
    const old = legacyProject();
    const project = deserializeProject(JSON.stringify(old));
    expect(project.version).toBe(3);
    expect(project.patterns).toEqual(old.patterns);
    expect(project.tracks).toHaveLength(1);
    expect(project.playlist[0]).toMatchObject({ kind: 'pattern', patternId: 'pattern-main', trackId: project.tracks[0].id, startTick: 32 * T, durationTicks: 48 * T });
    expect(project.playlist[1]).toMatchObject({ kind: 'pattern', patternId: 'pattern-main', startTick: 80 * T });
    expect(project.settings.loop).toEqual({ enabled: true, startTick: 0, endTick: 128 * T });
    expect(deserializeProject(serializeProject(project))).toEqual(project);
  });
  it('migrates older projects using their actual meter, not an assumed 4/4 grid', () => {
    const old = legacyProject();
    old.settings.timeSignature = { numerator: 7, denominator: 8 };
    expect(deserializeProject(JSON.stringify(old)).playlist[0].startTick).toBe(28 * T);
  });
  it('rejects corrupt legacy instances instead of coercing invalid values', () => {
    const old = legacyProject();
    old.playlist[0].startBar = -1;
    expect(() => deserializeProject(JSON.stringify(old))).toThrow('Version 1 playlist');
  });
  it('rejects foreign-key, kind, precision, offset and asset-metadata corruption on deserialize', () => {
    const cases = [
      (project: ReturnType<typeof createTestArrangement>) => { project.playlist[0].trackId = 'missing'; },
      (project: ReturnType<typeof createTestArrangement>) => { project.playlist[0].startTick = 0.5; },
      (project: ReturnType<typeof createTestArrangement>) => { project.playlist[0].durationTicks = -1; },
      (project: ReturnType<typeof createTestArrangement>) => { project.audioAssets[0].durationSeconds = 0; },
      (project: ReturnType<typeof createTestArrangement>) => { project.audioAssets[0].peaks = [2]; },
      (project: ReturnType<typeof createTestArrangement>) => { project.tracks[0].id = project.tracks[1].id; },
      (project: ReturnType<typeof createTestArrangement>) => { project.settings.loop.endTick = project.settings.loop.startTick; },
    ];
    for (const corrupt of cases) {
      const project = createTestArrangement();
      corrupt(project);
      expect(() => deserializeProject(JSON.stringify(project))).toThrow();
    }
  });
  it('keeps migrated version 1 mixer buses routed to the master bus and gives the new track a route', () => {
    const project = deserializeProject(JSON.stringify(legacyProject()));
    expect(project.mixerChannels[0]).toMatchObject({ id: 'mixer-master', role: 'master', volumeDb: 0, muted: false, solo: false });
    expect(project.mixerChannels[0].outputId).toBeUndefined();
    expect(project.mixerChannels.slice(1)).toHaveLength(4);
    for (const channel of project.mixerChannels.slice(1)) {
      expect(channel).toMatchObject({ role: 'insert', outputId: 'mixer-master', pan: 0, effects: [] });
    }
    expect(project.tracks[0].mixerChannelId).toBe('mixer-master');
    for (const channel of project.channels) expect(channel.mixerChannelId).toMatch(/^mixer-/);
  });

  it('requires explicit arrangement fields in the current version, rather than silently creating missing content', () => {
    const project = { ...createTestArrangement(), tracks: undefined };
    expect(() => assertValidProject(project)).toThrow('at least one');
  });
});
