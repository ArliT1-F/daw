import {
  assertValidProject,
  createMasterMixerChannel,
  MASTER_MIXER_CHANNEL_ID,
  MIXER_DEFAULT_DB,
  ProjectValidationError,
  type Project,
} from './model';
import { ticksPerBar } from '../time/ticks';

export function serializeProject(project: Project): string {
  assertValidProject(project);
  return JSON.stringify(project, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Migrate the Phase 1–4 bar-based, single-lane document without copying any pattern sources. */
function migrateVersionOne(value: unknown): unknown {
  if (!isRecord(value) || value.format !== 'gridline-project' || value.version !== 1) return value;
  const old = value;
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

/**
 * Migrate the Phase 5 mixer document to the Phase 6 mixer.
 *
 * Version 2 mixer channels carried only an id, a name, and a role, and every bus fed the master
 * implicitly. This migration makes that explicit instead of inventing routing:
 *  - each channel gains a unity fader, centre pan, cleared mute/solo, and an empty effect chain;
 *  - the master bus moves to the front and every other bus is routed to it (an extra master-role
 *    channel, which version 2 tolerated, becomes an insert);
 *  - a document with no usable master bus gets the well-known one;
 *  - Playlist tracks gain a mixer assignment on the master bus (they had no dedicated fader before);
 *  - rack channel and track references to a bus that no longer exists fall back to the master, so
 *    migration never produces a dangling route.
 */
function migrateVersionTwo(value: unknown): unknown {
  if (!isRecord(value) || value.format !== 'gridline-project' || value.version !== 2) return value;
  const existing = Array.isArray(value.mixerChannels) ? value.mixerChannels.filter(isRecord) : [];
  const masterRecord = existing.find((channel) => channel.role === 'master' && typeof channel.id === 'string' && channel.id.trim().length > 0);
  const masterId = masterRecord ? String(masterRecord.id) : MASTER_MIXER_CHANNEL_ID;
  const mixerChannels: unknown[] = [
    masterRecord
      ? { ...masterRecord, role: 'master', volumeDb: MIXER_DEFAULT_DB, pan: 0, muted: false, solo: false, effects: [] }
      : createMasterMixerChannel(masterId),
  ];
  for (const channel of existing) {
    if (channel === masterRecord) continue;
    mixerChannels.push({
      ...channel,
      role: 'insert',
      volumeDb: MIXER_DEFAULT_DB,
      pan: 0,
      muted: false,
      solo: false,
      outputId: masterId,
      effects: [],
    });
  }

  const knownIds = new Set(mixerChannels.map((channel) => String((channel as Record<string, unknown>).id)));
  const withRoute = (source: unknown): unknown => {
    if (!isRecord(source)) return source;
    const target = typeof source.mixerChannelId === 'string' && knownIds.has(source.mixerChannelId) ? source.mixerChannelId : masterId;
    return { ...source, mixerChannelId: target };
  };
  return {
    ...value,
    version: 3,
    mixerChannels,
    channels: Array.isArray(value.channels) ? value.channels.map(withRoute) : value.channels,
    tracks: Array.isArray(value.tracks) ? value.tracks.map(withRoute) : value.tracks,
  };
}

export function deserializeProject(serialized: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error('Project data is not valid JSON.', { cause: error });
  }
  const migrated = migrateVersionTwo(migrateVersionOne(parsed));
  assertValidProject(migrated);
  return migrated;
}
