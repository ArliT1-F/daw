export const PROJECT_FORMAT = 'gridline-project' as const;
export const PROJECT_VERSION = 1 as const;
export const DEFAULT_PATTERN_STEPS = 16;

export type ChannelKind = 'drum' | 'instrument';
export type MixerChannelRole = 'master' | 'insert';

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface ProjectSettings {
  tempo: number;
  timeSignature: TimeSignature;
}

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  color: string;
  mixerChannelId: string;
}

export interface Note {
  id: string;
  pitch: number;
  startStep: number;
  durationSteps: number;
  velocity: number;
}

export interface Pattern {
  id: string;
  name: string;
  lengthSteps: number;
  steps: Record<string, boolean[]>;
  notes: Record<string, Note[]>;
}

export interface PlaylistClip {
  id: string;
  patternId: string;
  startBar: number;
  lengthBars: number;
}

export interface MixerChannel {
  id: string;
  name: string;
  role: MixerChannelRole;
}

/** Serializable project content only. UI selections and live audio objects never belong here. */
export interface Project {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  id: string;
  name: string;
  settings: ProjectSettings;
  channels: Channel[];
  patterns: Pattern[];
  playlist: PlaylistClip[];
  mixerChannels: MixerChannel[];
}

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

let fallbackIdCounter = 0;

/** Generate an ID once when creating an entity; persist it rather than deriving it from its display name. */
export function createStableId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `${prefix}-${randomId}`;

  fallbackIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

export function isValidTimeSignature(value: unknown): value is TimeSignature {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.numerator) &&
    Number(value.numerator) >= 1 &&
    Number(value.numerator) <= 16 &&
    [2, 4, 8, 16].includes(Number(value.denominator))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProjectValidationError(message);
}

function ensureUniqueIds(items: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    ensure(typeof item.id === 'string' && item.id.trim().length > 0, `${label} IDs must be non-empty strings.`);
    ensure(!ids.has(item.id), `${label} IDs must be unique.`);
    ids.add(item.id);
  }
}

/** Validate untrusted JSON before it enters project state. */
export function assertValidProject(value: unknown): asserts value is Project {
  ensure(isRecord(value), 'Project data must be an object.');
  ensure(value.format === PROJECT_FORMAT, 'This file is not a Gridline project.');
  ensure(value.version === PROJECT_VERSION, `Unsupported project version: ${String(value.version)}.`);
  ensure(typeof value.id === 'string' && value.id.trim().length > 0, 'Project ID is missing.');
  ensure(typeof value.name === 'string' && value.name.trim().length > 0, 'Project name is missing.');
  ensure(isRecord(value.settings), 'Project settings are missing.');
  ensure(
    Number.isFinite(value.settings.tempo) && Number(value.settings.tempo) >= 20 && Number(value.settings.tempo) <= 300,
    'Tempo must be between 20 and 300 BPM.',
  );
  ensure(isValidTimeSignature(value.settings.timeSignature), 'Time signature is invalid.');

  ensure(Array.isArray(value.channels), 'Project channels must be an array.');
  ensure(Array.isArray(value.patterns) && value.patterns.length > 0, 'A project must contain at least one pattern.');
  ensure(Array.isArray(value.playlist), 'Project playlist must be an array.');
  ensure(Array.isArray(value.mixerChannels), 'Project mixer channels must be an array.');

  const channels = value.channels as unknown[];
  const patterns = value.patterns as unknown[];
  const playlist = value.playlist as unknown[];
  const mixerChannels = value.mixerChannels as unknown[];

  for (const channel of channels) {
    ensure(isRecord(channel), 'Channel data must be an object.');
    ensure(typeof channel.id === 'string' && channel.id.trim().length > 0, 'Channel ID is missing.');
    ensure(typeof channel.name === 'string' && channel.name.trim().length > 0, 'Channel name is missing.');
    ensure(channel.kind === 'drum' || channel.kind === 'instrument', 'Channel kind is invalid.');
    ensure(typeof channel.color === 'string' && /^#[\da-f]{6}$/i.test(channel.color), 'Channel color must be a six-digit hex value.');
    ensure(typeof channel.mixerChannelId === 'string', 'Channel mixer routing ID is missing.');
  }
  ensureUniqueIds(channels as Array<{ id: string }>, 'Channel');
  const channelIds = new Set(channels.map((channel) => String((channel as Record<string, unknown>).id)));

  for (const mixerChannel of mixerChannels) {
    ensure(isRecord(mixerChannel), 'Mixer channel data must be an object.');
    ensure(typeof mixerChannel.id === 'string' && mixerChannel.id.trim().length > 0, 'Mixer channel ID is missing.');
    ensure(typeof mixerChannel.name === 'string' && mixerChannel.name.trim().length > 0, 'Mixer channel name is missing.');
    ensure(mixerChannel.role === 'master' || mixerChannel.role === 'insert', 'Mixer channel role is invalid.');
  }
  ensureUniqueIds(mixerChannels as Array<{ id: string }>, 'Mixer channel');
  const mixerIds = new Set(mixerChannels.map((channel) => String((channel as Record<string, unknown>).id)));
  for (const channel of channels as Array<Record<string, unknown>>) {
    ensure(mixerIds.has(String(channel.mixerChannelId)), `Channel ${String(channel.name)} routes to a missing mixer channel.`);
  }

  for (const pattern of patterns) {
    ensure(isRecord(pattern), 'Pattern data must be an object.');
    ensure(typeof pattern.id === 'string' && pattern.id.trim().length > 0, 'Pattern ID is missing.');
    ensure(typeof pattern.name === 'string' && pattern.name.trim().length > 0, 'Pattern name is missing.');
    ensure(Number.isInteger(pattern.lengthSteps) && Number(pattern.lengthSteps) >= 1 && Number(pattern.lengthSteps) <= 1024, 'Pattern length is invalid.');
    ensure(isRecord(pattern.steps) && isRecord(pattern.notes), 'Pattern step and note maps are required.');

    for (const channelId of channelIds) {
      const steps = pattern.steps[channelId];
      const notes = pattern.notes[channelId];
      ensure(Array.isArray(steps) && steps.length === Number(pattern.lengthSteps), `Pattern steps are missing for channel ${channelId}.`);
      ensure(steps.every((step) => typeof step === 'boolean'), `Pattern steps for channel ${channelId} must be boolean values.`);
      ensure(Array.isArray(notes), `Pattern notes are missing for channel ${channelId}.`);
      for (const note of notes) {
        ensure(isRecord(note), 'Note data must be an object.');
        ensure(typeof note.id === 'string' && note.id.trim().length > 0, 'Note ID is missing.');
        ensure(Number.isInteger(note.pitch) && Number(note.pitch) >= 0 && Number(note.pitch) <= 127, 'Note pitch is invalid.');
        ensure(Number.isInteger(note.startStep) && Number(note.startStep) >= 0 && Number(note.startStep) < Number(pattern.lengthSteps), 'Note start position is invalid.');
        ensure(Number.isInteger(note.durationSteps) && Number(note.durationSteps) >= 1 && Number(note.startStep) + Number(note.durationSteps) <= Number(pattern.lengthSteps), 'Note duration is invalid.');
        ensure(Number.isFinite(note.velocity) && Number(note.velocity) >= 0 && Number(note.velocity) <= 1, 'Note velocity must be from 0 to 1.');
      }
      ensureUniqueIds(notes as Array<{ id: string }>, 'Note');
    }
    ensure(Object.keys(pattern.steps).length === channelIds.size, 'Pattern contains steps for an unknown channel.');
    ensure(Object.keys(pattern.notes).length === channelIds.size, 'Pattern contains notes for an unknown channel.');
  }
  ensureUniqueIds(patterns as Array<{ id: string }>, 'Pattern');

  const patternIds = new Set(patterns.map((pattern) => String((pattern as Record<string, unknown>).id)));
  for (const clip of playlist) {
    ensure(isRecord(clip), 'Playlist clip data must be an object.');
    ensure(typeof clip.id === 'string' && clip.id.trim().length > 0, 'Playlist clip ID is missing.');
    ensure(typeof clip.patternId === 'string' && patternIds.has(clip.patternId), 'Playlist clip references a missing pattern.');
    ensure(Number.isInteger(clip.startBar) && Number(clip.startBar) >= 0, 'Playlist clip start bar is invalid.');
    ensure(Number.isInteger(clip.lengthBars) && Number(clip.lengthBars) >= 1, 'Playlist clip length is invalid.');
  }
  ensureUniqueIds(playlist as Array<{ id: string }>, 'Playlist clip');
}

function buildStepRow(length: number, activeSteps: number[] = []): boolean[] {
  return Array.from({ length }, (_, index) => activeSteps.includes(index));
}

export function createInitialProject(): Project {
  const channels: Channel[] = [
    { id: 'channel-kick', name: 'Kick', kind: 'drum', color: '#e6a75c', mixerChannelId: 'mixer-insert-1' },
    { id: 'channel-snare', name: 'Snare', kind: 'drum', color: '#e67872', mixerChannelId: 'mixer-insert-2' },
    { id: 'channel-hat', name: 'Closed Hat', kind: 'drum', color: '#79c89b', mixerChannelId: 'mixer-insert-3' },
    { id: 'channel-bass', name: 'Soft Synth', kind: 'instrument', color: '#9992e8', mixerChannelId: 'mixer-insert-4' },
  ];
  const notes: Record<string, Note[]> = Object.fromEntries(channels.map((channel) => [channel.id, []]));
  notes['channel-bass'] = [
    { id: 'note-bass-1', pitch: 60, startStep: 0, durationSteps: 4, velocity: 0.82 },
    { id: 'note-bass-2', pitch: 67, startStep: 4, durationSteps: 2, velocity: 0.72 },
    { id: 'note-bass-3', pitch: 62, startStep: 8, durationSteps: 4, velocity: 0.78 },
    { id: 'note-bass-4', pitch: 65, startStep: 12, durationSteps: 4, velocity: 0.72 },
  ];

  const project: Project = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: 'project-starter',
    name: 'Untitled Session',
    settings: { tempo: 124, timeSignature: { numerator: 4, denominator: 4 } },
    channels,
    patterns: [
      {
        id: 'pattern-main',
        name: 'Pattern 01',
        lengthSteps: DEFAULT_PATTERN_STEPS,
        steps: {
          'channel-kick': buildStepRow(DEFAULT_PATTERN_STEPS, [0, 8]),
          'channel-snare': buildStepRow(DEFAULT_PATTERN_STEPS, [4, 12]),
          'channel-hat': buildStepRow(DEFAULT_PATTERN_STEPS, [0, 2, 4, 6, 8, 10, 12, 14]),
          'channel-bass': buildStepRow(DEFAULT_PATTERN_STEPS, [0, 8]),
        },
        notes,
      },
    ],
    playlist: [{ id: 'clip-main-0', patternId: 'pattern-main', startBar: 0, lengthBars: 4 }],
    mixerChannels: [
      { id: 'mixer-master', name: 'Master', role: 'master' },
      { id: 'mixer-insert-1', name: 'Insert 1', role: 'insert' },
      { id: 'mixer-insert-2', name: 'Insert 2', role: 'insert' },
      { id: 'mixer-insert-3', name: 'Insert 3', role: 'insert' },
      { id: 'mixer-insert-4', name: 'Insert 4', role: 'insert' },
    ],
  };
  assertValidProject(project);
  return project;
}
