import { assertValidProject, ProjectValidationError, type Project } from './model';
import { ticksPerBar } from '../time/ticks';

export function serializeProject(project: Project): string {
  assertValidProject(project);
  return JSON.stringify(project, null, 2);
}

/** Migrate the Phase 1–4 bar-based, single-lane document without copying any pattern sources. */
function migrateVersionOne(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const old = value as Record<string, unknown>;
  if (old.format !== 'gridline-project' || old.version !== 1) return value;
  const settings = old.settings as Project['settings'] | undefined;
  if (!settings?.timeSignature || !Array.isArray(old.playlist)) {
    throw new ProjectValidationError('Version 1 project settings or playlist are missing.');
  }
  const barTicks = ticksPerBar(settings.timeSignature);
  const playlist = old.playlist.map((item: unknown) => {
    const clip = item as { id?: unknown; patternId?: unknown; startBar?: unknown; lengthBars?: unknown } | null;
    if (!clip || !Number.isSafeInteger(clip.startBar) || Number(clip.startBar) < 0 || !Number.isSafeInteger(clip.lengthBars) || Number(clip.lengthBars) < 1) {
      throw new ProjectValidationError('Version 1 playlist clip position or length is invalid.');
    }
    return {
      id: clip.id,
      kind: 'pattern',
      trackId: 'track-migrated',
      patternId: clip.patternId,
      startTick: Number(clip.startBar) * barTicks,
      durationTicks: Number(clip.lengthBars) * barTicks,
      sourceOffsetTicks: 0,
    };
  });
  return {
    ...old,
    version: 2,
    settings: { ...settings, tempoChanges: [], loop: { enabled: true, startTick: 0, endTick: 8 * barTicks } },
    tracks: [{ id: 'track-migrated', name: 'Patterns', color: '#9992e8', muted: false, solo: false }],
    audioAssets: [],
    playlist,
  };
}

export function deserializeProject(serialized: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error('Project data is not valid JSON.', { cause: error });
  }
  const migrated = migrateVersionOne(parsed);
  assertValidProject(migrated);
  return migrated;
}
