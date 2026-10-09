import { describe, expect, it } from 'vitest';
import { assertValidProject, createInitialProject, ProjectValidationError } from './model';
import { deserializeProject, serializeProject } from './serialization';

describe('versioned project model', () => {
  it('creates a valid starter session with stable channel, pattern, and mixer references', () => {
    const project = createInitialProject();

    expect(() => assertValidProject(project)).not.toThrow();
    expect(project.version).toBe(1);
    expect(project.channels).toHaveLength(4);
    expect(project.patterns[0].steps['channel-kick']).toHaveLength(16);
    expect(project.playlist[0].patternId).toBe(project.patterns[0].id);
  });

  it('round-trips project content through versioned JSON serialization', () => {
    const project = createInitialProject();
    const encoded = serializeProject(project);
    const decoded = deserializeProject(encoded);

    expect(decoded).toEqual(project);
    expect(encoded).toContain('"version": 1');
  });

  it('rejects invalid JSON and unsupported project versions', () => {
    expect(() => deserializeProject('{not json')).toThrow('not valid JSON');

    const unknownVersion = { ...createInitialProject(), version: 2 };
    expect(() => assertValidProject(unknownVersion)).toThrow(ProjectValidationError);
    expect(() => deserializeProject(JSON.stringify(unknownVersion))).toThrow('Unsupported project version');
  });
});
