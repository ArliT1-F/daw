import { TICKS_PER_STEP } from '../time/ticks';

export const PROJECT_FORMAT = 'gridline-project' as const;
export const PROJECT_VERSION = 3 as const;
export const DEFAULT_PATTERN_STEPS = 16;
/** Step lengths the step sequencer can toggle between. */
export const SUPPORTED_PATTERN_LENGTHS = [16, 32] as const;
/** Velocity applied to steps the model has no explicit velocity for (0..1). */
export const DEFAULT_STEP_VELOCITY = 0.85;
/** Swing is stored as a fraction of full triplet feel, 0 (straight) to 1. */
export const MAX_SWING = 1;

/**
 * Mixer fader range in decibels relative to unity gain.
 * `MIXER_MIN_DB` is the fader floor and is rendered/applied as true silence.
 */
export const MIXER_MIN_DB = -60;
export const MIXER_MAX_DB = 12;
export const MIXER_DEFAULT_DB = 0;
/** Stereo pan limits: -1 hard left, 0 centre, +1 hard right. */
export const MIXER_PAN_LIMIT = 1;
/** Upper bound on non-master mixer channels, so a project cannot grow an unbounded node graph. */
export const MAX_MIXER_INSERTS = 32;
/** Prepared effect slots per mixer channel. Phase 7 fills them with real processors. */
export const MIXER_EFFECT_SLOT_COUNT = 4;
/** Mixer channel and source names share the Playlist track limit. */
export const MAX_MIXER_NAME_LENGTH = 80;
/**
 * Well-known master bus id used by the starter project and by migrations that must supply a
 * master. Runtime code always locates the master by `role`, never by this id.
 */
export const MASTER_MIXER_CHANNEL_ID = 'mixer-master';

export type ChannelKind = 'drum' | 'instrument';
export type MixerChannelRole = 'master' | 'insert';

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface ProjectSettings {
  tempo: number;
  timeSignature: TimeSignature;
  /** Shuffle amount applied to offbeat steps during playback: 0 (straight) .. 1 (triplet). */
  swing: number;
  /** Base tempo is `tempo`; changes apply at absolute song ticks (> 0). */
  tempoChanges: ProjectTempoChange[];
  /** Saved song loop, independent of the viewport and editor selection. End is exclusive. */
  loop: PlaylistLoop;
}

export interface ProjectTempoChange {
  tick: number;
  bpm: number;
}

export interface PlaylistLoop {
  enabled: boolean;
  startTick: number;
  endTick: number;
}

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  color: string;
  /** Mixer channel this instrument/drum channel is routed to. */
  mixerChannelId: string;
  /** Silent during playback when true. Serializable mix state, not an audio object. */
  muted: boolean;
  /** When any channel is soloed, only soloed (and unmuted) channels play. */
  solo: boolean;
  /** Stable ID of a loaded sample asset. Absent = built-in synthesized voice. */
  sampleId?: string;
  /** Display name of the loaded sample file. */
  sampleName?: string;
}

export interface Note {
  id: string;
  /** MIDI note number, 0..127. */
  pitch: number;
  /**
   * Start position in integer ticks from the beginning of the pattern.
   * Canonical timing unit — see `src/core/time/ticks.ts`.
   */
  startTick: number;
  /** Length in integer ticks. */
  durationTicks: number;
  /** 0..1 */
  velocity: number;
}

export interface Pattern {
  id: string;
  name: string;
  lengthSteps: number;
  steps: Record<string, boolean[]>;
  /** Per-step velocity (0..1) parallel to `steps`; defaults to DEFAULT_STEP_VELOCITY. */
  velocities: Record<string, number[]>;
  notes: Record<string, Note[]>;
}

export interface PlaylistTrack {
  id: string;
  name: string;
  color: string;
  muted: boolean;
  solo: boolean;
  /**
   * Mixer channel this track's audio clips are routed to. Playlist audio is the only signal a
   * track carries; pattern clips stay routed through their Channel Rack channels.
   */
  mixerChannelId: string;
}

/** Serializable metadata. Decoded buffers live only in the runtime SampleStore. */
export interface AudioAsset {
  id: string;
  name: string;
  durationSeconds: number;
  /** Small peak envelope for the Playlist preview, not encoded/decoded audio. */
  peaks?: number[];
}

interface PlaylistClipBase {
  id: string;
  trackId: string;
  /** Optional instance label; otherwise the reusable source's name is displayed. */
  name?: string;
  startTick: number;
  durationTicks: number;
}

export interface PatternClip extends PlaylistClipBase {
  kind: 'pattern';
  patternId: string;
  /** Start within the source pattern. Repeated to fill the instance, without copying it. */
  sourceOffsetTicks: number;
}

export interface AudioClip extends PlaylistClipBase {
  kind: 'audio';
  assetId: string;
  /** Trim-in in real source seconds. Audio plays at native speed (no time stretching). */
  sourceOffsetSeconds: number;
  gain: number;
}

export type PlaylistClip = PatternClip | AudioClip;

/**
 * One prepared effect slot in a mixer channel's insert chain.
 *
 * Phase 6 stores and validates the slot but does not process audio with it: an empty slot is a
 * unity bypass in the graph. Phase 7 replaces `type: null` with a processor definition without
 * changing the document shape or rewiring the channel.
 */
export interface MixerEffectSlot {
  id: string;
  /** Processor type key, or `null` while the slot is an empty bypass. */
  type: string | null;
  /** A disabled slot is bypassed even when a processor type is assigned. */
  enabled: boolean;
  /** Normalised processor parameters; interpreted by the processor, never by the graph. */
  params: Record<string, number>;
}

export interface MixerChannel {
  id: string;
  name: string;
  role: MixerChannelRole;
  /** Fader position in dB relative to unity gain, from `MIXER_MIN_DB` to `MIXER_MAX_DB`. */
  volumeDb: number;
  /** Stereo pan: -1 left, 0 centre, 1 right. */
  pan: number;
  /** Silent during playback when true. Mute always wins over solo. */
  muted: boolean;
  /** When any insert is soloed, only soloed (and unmuted) inserts pass signal. */
  solo: boolean;
  /**
   * Destination mixer channel id. Required for inserts and forbidden on the master bus, which
   * always feeds the safety limiter and the hardware output. Routing must stay acyclic so every
   * insert reaches the master exactly once.
   */
  outputId?: string;
  /** Prepared insert-effect slots, in signal order. Bounded by `MIXER_EFFECT_SLOT_COUNT`. */
  effects: MixerEffectSlot[];
}

/** An insert mixer channel with every default filled in, ready to be added to a project. */
export function createMixerChannel(id: string, name: string, outputId: string): MixerChannel {
  return { id, name, role: 'insert', volumeDb: MIXER_DEFAULT_DB, pan: 0, muted: false, solo: false, outputId, effects: [] };
}

/** The single master bus. It has no `outputId`: it always feeds the limiter and the hardware out. */
export function createMasterMixerChannel(id: string, name = 'Master'): MixerChannel {
  return { id, name, role: 'master', volumeDb: MIXER_DEFAULT_DB, pan: 0, muted: false, solo: false, effects: [] };
}

/** An empty, bypassed effect slot for a mixer channel's insert chain. */
export function createMixerEffectSlot(id: string): MixerEffectSlot {
  return { id, type: null, enabled: false, params: {} };
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
  tracks: PlaylistTrack[];
  audioAssets: AudioAsset[];
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
  ensure(
    Number.isFinite(value.settings.swing) && Number(value.settings.swing) >= 0 && Number(value.settings.swing) <= MAX_SWING,
    'Swing must be between 0 and 1.',
  );

  ensure(Array.isArray(value.settings.tempoChanges), 'Tempo changes must be an array.');
  let lastTempoTick = 0;
  for (const change of value.settings.tempoChanges) {
    ensure(isRecord(change), 'Tempo change data must be an object.');
    ensure(Number.isSafeInteger(change.tick) && Number(change.tick) > lastTempoTick, 'Tempo changes must have unique, increasing positive ticks.');
    ensure(Number.isFinite(change.bpm) && Number(change.bpm) >= 20 && Number(change.bpm) <= 300, 'Tempo change must be between 20 and 300 BPM.');
    lastTempoTick = Number(change.tick);
  }
  ensure(isRecord(value.settings.loop), 'Playlist loop is missing.');
  ensure(typeof value.settings.loop.enabled === 'boolean', 'Loop enabled state must be a boolean.');
  ensure(Number.isSafeInteger(value.settings.loop.startTick) && Number(value.settings.loop.startTick) >= 0, 'Loop start is invalid.');
  ensure(Number.isSafeInteger(value.settings.loop.endTick) && Number(value.settings.loop.endTick) > Number(value.settings.loop.startTick), 'Loop end must follow loop start.');

  ensure(Array.isArray(value.tracks) && value.tracks.length > 0, 'A project must contain at least one Playlist track.');
  ensure(Array.isArray(value.audioAssets), 'Audio assets must be an array.');
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
    ensure(typeof channel.muted === 'boolean', 'Channel mute state must be a boolean.');
    ensure(typeof channel.solo === 'boolean', 'Channel solo state must be a boolean.');
    if (channel.sampleId !== undefined) {
      ensure(typeof channel.sampleId === 'string' && channel.sampleId.trim().length > 0, 'Channel sample ID must be a non-empty string.');
    }
    if (channel.sampleName !== undefined) {
      ensure(typeof channel.sampleName === 'string' && channel.sampleName.trim().length > 0, 'Channel sample name must be a non-empty string.');
    }
  }
  ensureUniqueIds(channels as Array<{ id: string }>, 'Channel');
  const channelIds = new Set(channels.map((channel) => String((channel as Record<string, unknown>).id)));

  assertValidMixerChannels(mixerChannels);
  const mixerIds = new Set(mixerChannels.map((channel) => String((channel as Record<string, unknown>).id)));
  for (const channel of channels as Array<Record<string, unknown>>) {
    ensure(mixerIds.has(String(channel.mixerChannelId)), `Channel ${String(channel.name)} routes to a missing mixer channel.`);
  }

  for (const pattern of patterns) {
    ensure(isRecord(pattern), 'Pattern data must be an object.');
    ensure(typeof pattern.id === 'string' && pattern.id.trim().length > 0, 'Pattern ID is missing.');
    ensure(typeof pattern.name === 'string' && pattern.name.trim().length > 0, 'Pattern name is missing.');
    ensure(Number.isInteger(pattern.lengthSteps) && Number(pattern.lengthSteps) >= 1 && Number(pattern.lengthSteps) <= 1024, 'Pattern length is invalid.');
    ensure(isRecord(pattern.steps) && isRecord(pattern.velocities) && isRecord(pattern.notes), 'Pattern step, velocity, and note maps are required.');

    for (const channelId of channelIds) {
      const steps = pattern.steps[channelId];
      const velocities = pattern.velocities[channelId];
      const notes = pattern.notes[channelId];
      ensure(Array.isArray(steps) && steps.length === Number(pattern.lengthSteps), `Pattern steps are missing for channel ${channelId}.`);
      ensure(steps.every((step) => typeof step === 'boolean'), `Pattern steps for channel ${channelId} must be boolean values.`);
      ensure(Array.isArray(velocities) && velocities.length === Number(pattern.lengthSteps), `Pattern velocities are missing for channel ${channelId}.`);
      ensure(
        velocities.every((velocity) => Number.isFinite(velocity) && Number(velocity) >= 0 && Number(velocity) <= 1),
        `Pattern velocities for channel ${channelId} must be from 0 to 1.`,
      );
      ensure(Array.isArray(notes), `Pattern notes are missing for channel ${channelId}.`);
      for (const note of notes) {
        ensure(isRecord(note), 'Note data must be an object.');
        ensure(typeof note.id === 'string' && note.id.trim().length > 0, 'Note ID is missing.');
        ensure(Number.isInteger(note.pitch) && Number(note.pitch) >= 0 && Number(note.pitch) <= 127, 'Note pitch is invalid.');
        const lengthTicks = Number(pattern.lengthSteps) * TICKS_PER_STEP;
        ensure(Number.isInteger(note.startTick) && Number(note.startTick) >= 0 && Number(note.startTick) < lengthTicks, 'Note start position is invalid.');
        ensure(
          Number.isInteger(note.durationTicks) &&
            Number(note.durationTicks) >= 1 &&
            Number(note.startTick) + Number(note.durationTicks) <= lengthTicks,
          'Note duration is invalid.',
        );
        ensure(Number.isFinite(note.velocity) && Number(note.velocity) >= 0 && Number(note.velocity) <= 1, 'Note velocity must be from 0 to 1.');
      }
      ensureUniqueIds(notes as Array<{ id: string }>, 'Note');
    }
    ensure(Object.keys(pattern.steps).length === channelIds.size, 'Pattern contains steps for an unknown channel.');
    ensure(Object.keys(pattern.velocities).length === channelIds.size, 'Pattern contains velocities for an unknown channel.');
    ensure(Object.keys(pattern.notes).length === channelIds.size, 'Pattern contains notes for an unknown channel.');
  }
  ensureUniqueIds(patterns as Array<{ id: string }>, 'Pattern');

  for (const track of value.tracks) {
    ensure(isRecord(track), 'Playlist track data must be an object.');
    ensure(typeof track.id === 'string' && track.id.trim().length > 0, 'Playlist track ID is missing.');
    ensure(typeof track.name === 'string' && track.name.trim().length > 0 && track.name.length <= 80, 'Playlist track name is invalid.');
    ensure(typeof track.color === 'string' && /^#[\da-f]{6}$/i.test(track.color), 'Playlist track color must be a six-digit hex value.');
    ensure(typeof track.muted === 'boolean' && typeof track.solo === 'boolean', 'Playlist track mute/solo state must be boolean.');
    ensure(
      typeof track.mixerChannelId === 'string' && mixerIds.has(track.mixerChannelId),
      `Playlist track ${String(track.name)} routes to a missing mixer channel.`,
    );
  }
  ensureUniqueIds(value.tracks as Array<{ id: string }>, 'Playlist track');
  const trackIds = new Set(value.tracks.map((track) => String((track as Record<string, unknown>).id)));

  for (const asset of value.audioAssets) {
    ensure(isRecord(asset), 'Audio asset data must be an object.');
    ensure(typeof asset.id === 'string' && asset.id.trim().length > 0, 'Audio asset ID is missing.');
    ensure(typeof asset.name === 'string' && asset.name.trim().length > 0, 'Audio asset name is missing.');
    ensure(Number.isFinite(asset.durationSeconds) && Number(asset.durationSeconds) > 0, 'Audio asset duration must be positive.');
    if (asset.peaks !== undefined) {
      ensure(Array.isArray(asset.peaks) && asset.peaks.length <= 256 && asset.peaks.every((peak) => Number.isFinite(peak) && Number(peak) >= 0 && Number(peak) <= 1), 'Audio asset peaks are invalid.');
    }
  }
  ensureUniqueIds(value.audioAssets as Array<{ id: string }>, 'Audio asset');
  const assetsById = new Map((value.audioAssets as AudioAsset[]).map((asset) => [asset.id, asset]));
  const patternsById = new Map((patterns as Pattern[]).map((pattern) => [pattern.id, pattern]));
  for (const clip of playlist) {
    ensure(isRecord(clip), 'Playlist clip data must be an object.');
    ensure(typeof clip.id === 'string' && clip.id.trim().length > 0, 'Playlist clip ID is missing.');
    ensure(typeof clip.trackId === 'string' && trackIds.has(clip.trackId), 'Playlist clip references a missing track.');
    ensure(Number.isSafeInteger(clip.startTick) && Number(clip.startTick) >= 0, 'Playlist clip start is invalid.');
    ensure(Number.isSafeInteger(clip.durationTicks) && Number(clip.durationTicks) >= 1 && Number.isSafeInteger(Number(clip.startTick) + Number(clip.durationTicks)), 'Playlist clip duration is invalid.');
    if (clip.name !== undefined) ensure(typeof clip.name === 'string' && clip.name.trim().length > 0 && clip.name.length <= 80, 'Playlist clip name is invalid.');
    if (clip.kind === 'pattern') {
      ensure(typeof clip.patternId === 'string' && patternsById.has(clip.patternId), 'Playlist clip references a missing pattern.');
      // Offsets may exceed a pattern's length after a source edit; playback wraps them modulo its length.
      ensure(Number.isSafeInteger(clip.sourceOffsetTicks) && Number(clip.sourceOffsetTicks) >= 0, 'Pattern clip source offset is invalid.');
      ensure(clip.assetId === undefined, 'Pattern clips cannot reference an audio asset.');
    } else if (clip.kind === 'audio') {
      ensure(typeof clip.assetId === 'string' && assetsById.has(clip.assetId), 'Playlist clip references a missing audio asset.');
      const asset = assetsById.get(String(clip.assetId))!;
      ensure(Number.isFinite(clip.sourceOffsetSeconds) && Number(clip.sourceOffsetSeconds) >= 0 && Number(clip.sourceOffsetSeconds) < asset.durationSeconds, 'Audio clip source offset is outside the asset.');
      ensure(Number.isFinite(clip.gain) && Number(clip.gain) >= 0 && Number(clip.gain) <= 2, 'Audio clip gain must be between 0 and 2.');
      ensure(clip.patternId === undefined, 'Audio clips cannot reference a pattern.');
    } else {
      ensure(false, 'Playlist clip kind is invalid.');
    }
  }
  ensureUniqueIds(playlist as Array<{ id: string }>, 'Playlist clip');
}

/** Validate one mixer channel's prepared effect-slot chain. Slots are data only until Phase 7. */
function assertValidEffectSlots(value: unknown, channelName: string): void {
  ensure(Array.isArray(value), `Mixer channel ${channelName} effect slots must be an array.`);
  ensure(
    value.length <= MIXER_EFFECT_SLOT_COUNT,
    `Mixer channel ${channelName} has more than ${MIXER_EFFECT_SLOT_COUNT} effect slots.`,
  );
  const slotIds = new Set<string>();
  for (const slot of value) {
    ensure(isRecord(slot), `Mixer channel ${channelName} has an invalid effect slot.`);
    ensure(
      typeof slot.id === 'string' && slot.id.trim().length > 0 && !slotIds.has(slot.id),
      `Mixer channel ${channelName} effect slot IDs must be unique, non-empty strings.`,
    );
    slotIds.add(String(slot.id));
    ensure(
      slot.type === null || (typeof slot.type === 'string' && slot.type.trim().length > 0),
      `Mixer channel ${channelName} has an invalid effect type.`,
    );
    ensure(typeof slot.enabled === 'boolean', `Mixer channel ${channelName} effect slot state must be a boolean.`);
    ensure(isRecord(slot.params), `Mixer channel ${channelName} effect parameters must be an object.`);
    for (const [key, param] of Object.entries(slot.params)) {
      ensure(
        key.trim().length > 0 && Number.isFinite(param),
        `Mixer channel ${channelName} effect parameter "${key}" must be a finite number.`,
      );
    }
  }
}

/**
 * Validate the mixer channel list, its mix state, and its routing graph.
 *
 * Routing rules (the same rules mixer commands enforce before an edit is committed):
 *  - exactly one master bus, always first, so channel order and the master position stay stable;
 *  - at most `MAX_MIXER_INSERTS` inserts, each with a unique id, a fader inside the dB range,
 *    a pan inside -1..1, boolean mute/solo, and a bounded effect-slot list;
 *  - every insert names an existing destination that is not itself;
 *  - the destination graph is acyclic and every insert reaches the master bus, so no signal path
 *    can feed itself, loop forever, or bypass the master output.
 */
export function assertValidMixerChannels(value: unknown): void {
  ensure(Array.isArray(value) && value.length > 0, 'A project must contain at least one mixer channel.');
  for (const mixerChannel of value) {
    ensure(isRecord(mixerChannel), 'Mixer channel data must be an object.');
    ensure(typeof mixerChannel.id === 'string' && mixerChannel.id.trim().length > 0, 'Mixer channel ID is missing.');
    ensure(
      typeof mixerChannel.name === 'string' && mixerChannel.name.trim().length > 0 && mixerChannel.name.length <= MAX_MIXER_NAME_LENGTH,
      'Mixer channel name must be between 1 and 80 characters.',
    );
    ensure(mixerChannel.role === 'master' || mixerChannel.role === 'insert', 'Mixer channel role is invalid.');
    ensure(
      Number.isFinite(mixerChannel.volumeDb) && Number(mixerChannel.volumeDb) >= MIXER_MIN_DB && Number(mixerChannel.volumeDb) <= MIXER_MAX_DB,
      `Mixer channel ${String(mixerChannel.name)} volume must be between ${MIXER_MIN_DB} and ${MIXER_MAX_DB} dB.`,
    );
    ensure(
      Number.isFinite(mixerChannel.pan) && Number(mixerChannel.pan) >= -MIXER_PAN_LIMIT && Number(mixerChannel.pan) <= MIXER_PAN_LIMIT,
      `Mixer channel ${String(mixerChannel.name)} pan must be between -1 and 1.`,
    );
    ensure(
      typeof mixerChannel.muted === 'boolean' && typeof mixerChannel.solo === 'boolean',
      `Mixer channel ${String(mixerChannel.name)} mute and solo state must be boolean.`,
    );
    if (mixerChannel.role === 'master') {
      ensure(mixerChannel.outputId === undefined, 'The master bus cannot be routed to another mixer channel.');
    } else {
      ensure(
        typeof mixerChannel.outputId === 'string' && mixerChannel.outputId.trim().length > 0,
        `Mixer channel ${String(mixerChannel.name)} needs a destination mixer channel.`,
      );
    }
    assertValidEffectSlots(mixerChannel.effects, String(mixerChannel.name));
  }
  ensureUniqueIds(value as Array<{ id: string }>, 'Mixer channel');
  ensure(isRecord(value[0]) && value[0].role === 'master', 'The first mixer channel must be the master bus.');
  const masters = (value as Array<Record<string, unknown>>).filter((channel) => channel.role === 'master');
  ensure(masters.length === 1, 'A project must contain exactly one master mixer channel.');
  ensure(
    value.length - 1 <= MAX_MIXER_INSERTS,
    `A project supports at most ${MAX_MIXER_INSERTS} mixer channels besides the master bus.`,
  );

  const records = value as Array<Record<string, unknown>>;
  const names = new Map(records.map((channel) => [String(channel.id), String(channel.name)]));
  const masterId = String(masters[0].id);
  const outputs = new Map<string, string>();
  for (const channel of records) {
    if (channel.role !== 'insert') continue;
    const id = String(channel.id);
    const outputId = String(channel.outputId);
    ensure(names.has(outputId), `Mixer channel ${String(channel.name)} routes to a missing mixer channel.`);
    ensure(outputId !== id, `Mixer channel ${String(channel.name)} cannot route to itself.`);
    outputs.set(id, outputId);
  }
  // Follow every insert upstream; the walk must terminate at the master without revisiting a channel.
  for (const [id] of outputs) {
    const seen = new Set<string>([id]);
    let cursor = outputs.get(id)!;
    while (cursor !== masterId) {
      ensure(!seen.has(cursor), `Mixer channel ${names.get(id)} is part of a routing cycle.`);
      seen.add(cursor);
      const next = outputs.get(cursor);
      ensure(next !== undefined, `Mixer channel ${names.get(id)} does not reach the master bus.`);
      cursor = next;
    }
  }
}

function buildStepRow(length: number, activeSteps: number[] = []): boolean[] {
  return Array.from({ length }, (_, index) => activeSteps.includes(index));
}


function buildVelocityRow(length: number): number[] {
  return Array.from({ length }, () => DEFAULT_STEP_VELOCITY);
}

export function createInitialProject(): Project {
  const channels: Channel[] = [
    { id: 'channel-kick', name: 'Kick', kind: 'drum', color: '#e6a75c', mixerChannelId: 'mixer-insert-1', muted: false, solo: false },
    { id: 'channel-snare', name: 'Snare', kind: 'drum', color: '#e67872', mixerChannelId: 'mixer-insert-2', muted: false, solo: false },
    { id: 'channel-hat', name: 'Closed Hat', kind: 'drum', color: '#79c89b', mixerChannelId: 'mixer-insert-3', muted: false, solo: false },
    { id: 'channel-bass', name: 'Soft Synth', kind: 'instrument', color: '#9992e8', mixerChannelId: 'mixer-insert-4', muted: false, solo: false },
  ];
  const notes: Record<string, Note[]> = Object.fromEntries(channels.map((channel) => [channel.id, []]));
  notes['channel-bass'] = [
    { id: 'note-bass-1', pitch: 60, startTick: 0, durationTicks: 96, velocity: 0.82 },
    { id: 'note-bass-2', pitch: 67, startTick: 96, durationTicks: 48, velocity: 0.72 },
    { id: 'note-bass-3', pitch: 62, startTick: 192, durationTicks: 96, velocity: 0.78 },
    { id: 'note-bass-4', pitch: 65, startTick: 288, durationTicks: 96, velocity: 0.72 },
  ];

  const project: Project = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: 'project-starter',
    name: 'Untitled Session',
    settings: { tempo: 124, timeSignature: { numerator: 4, denominator: 4 }, swing: 0, tempoChanges: [], loop: { enabled: true, startTick: 0, endTick: 128 * TICKS_PER_STEP } },
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
        velocities: {
          'channel-kick': buildVelocityRow(DEFAULT_PATTERN_STEPS),
          'channel-snare': buildVelocityRow(DEFAULT_PATTERN_STEPS),
          'channel-hat': buildVelocityRow(DEFAULT_PATTERN_STEPS),
          'channel-bass': buildVelocityRow(DEFAULT_PATTERN_STEPS),
        },
        notes,
      },
    ],
    // Playlist tracks start unassigned (straight to the master bus); the Mixer routes them to an
    // insert when the user wants a dedicated fader.
    tracks: [
      { id: 'track-main', name: 'Patterns', color: '#9992e8', muted: false, solo: false, mixerChannelId: MASTER_MIXER_CHANNEL_ID },
      { id: 'track-audio', name: 'Audio', color: '#79c8b8', muted: false, solo: false, mixerChannelId: MASTER_MIXER_CHANNEL_ID },
      { id: 'track-layer', name: 'Layers', color: '#e6a75c', muted: false, solo: false, mixerChannelId: MASTER_MIXER_CHANNEL_ID },
    ],
    audioAssets: [],
    playlist: [{ id: 'clip-main-0', kind: 'pattern', trackId: 'track-main', patternId: 'pattern-main', startTick: 0, durationTicks: 64 * TICKS_PER_STEP, sourceOffsetTicks: 0 }],
    mixerChannels: [
      createMasterMixerChannel(MASTER_MIXER_CHANNEL_ID),
      createMixerChannel('mixer-insert-1', 'Kick', MASTER_MIXER_CHANNEL_ID),
      createMixerChannel('mixer-insert-2', 'Snare', MASTER_MIXER_CHANNEL_ID),
      createMixerChannel('mixer-insert-3', 'Closed Hat', MASTER_MIXER_CHANNEL_ID),
      createMixerChannel('mixer-insert-4', 'Soft Synth', MASTER_MIXER_CHANNEL_ID),
    ],
  };
  assertValidProject(project);
  return project;
}
