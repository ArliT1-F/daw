import { describe, expect, it } from 'vitest';
import { assertValidProject, createInitialProject, ProjectValidationError } from './model';
import { deserializeProject, serializeProject } from './serialization';

describe('versioned project model', () => {
  it('creates a valid starter session with stable channel, pattern, and mixer references', () => {
    const project = createInitialProject();

    expect(() => assertValidProject(project)).not.toThrow();
    expect(project.version).toBe(3);
    expect(project.channels).toHaveLength(4);
    expect(project.patterns[0].steps['channel-kick']).toHaveLength(16);
    expect((project.playlist[0].kind === 'pattern' && project.playlist[0].patternId)).toBe(project.patterns[0].id);
  });

  it('round-trips project content through versioned JSON serialization', () => {
    const project = createInitialProject();
    const encoded = serializeProject(project);
    const decoded = deserializeProject(encoded);

    expect(decoded).toEqual(project);
    expect(encoded).toContain('"version": 3');
  });

  it('rejects invalid JSON and unsupported project versions', () => {
    expect(() => deserializeProject('{not json')).toThrow('not valid JSON');

    const unknownVersion = { ...createInitialProject(), version: 999 };
    expect(() => assertValidProject(unknownVersion)).toThrow(ProjectValidationError);
    expect(() => deserializeProject(JSON.stringify(unknownVersion))).toThrow('Unsupported project version');
  });

  it('rejects projects with invalid sequencer data (swing, velocities, mute state)', () => {
    const badSwing = { ...createInitialProject(), settings: { ...createInitialProject().settings, swing: 1.5 } };
    expect(() => assertValidProject(badSwing)).toThrow('Swing');

    const missingVelocities = createInitialProject();
    delete missingVelocities.patterns[0].velocities['channel-kick'];
    expect(() => assertValidProject(missingVelocities)).toThrow('velocities are missing');

    const badVelocity = createInitialProject();
    badVelocity.patterns[0].velocities['channel-kick'][3] = 7;
    expect(() => assertValidProject(badVelocity)).toThrow('0 to 1');

    const missingMute = createInitialProject();
    delete (missingMute.channels[0] as Partial<typeof missingMute.channels[0]>).muted;
    expect(() => assertValidProject(missingMute)).toThrow('mute state');

    const badSample = createInitialProject();
    badSample.channels[0].sampleId = '   ';
    expect(() => assertValidProject(badSample)).toThrow('sample ID');
  });

  it('keeps step velocity rows aligned with step rows in the starter project', () => {
    const project = createInitialProject();
    for (const channel of project.channels) {
      expect(project.patterns[0].velocities[channel.id]).toHaveLength(project.patterns[0].steps[channel.id].length);
    }
  });
});
