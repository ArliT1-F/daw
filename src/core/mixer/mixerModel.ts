/**
 * Mixer model: the pure, audio-free half of the mixer.
 *
 * Everything here is derived from serializable project data, so it can be used by commands
 * (validation before an edit is committed), by the audio graph (what to build and connect), and by
 * the Mixer panel (what to draw) without any of them importing each other's concerns.
 *
 * Signal-flow rules enforced across the model, the commands, and the graph:
 *  - a source (Channel Rack channel or Playlist audio track) feeds exactly one mixer channel;
 *  - a mixer channel feeds exactly one destination: another insert, or the master bus;
 *  - the master bus feeds the safety limiter and the hardware output, and has no destination;
 *  - routing is acyclic and every insert reaches the master, so no path can bypass the master or
 *    duplicate signal into it.
 */

import {
  MAX_MIXER_INSERTS,
  MAX_MIXER_NAME_LENGTH,
  MIXER_MAX_DB,
  MIXER_MIN_DB,
  MIXER_PAN_LIMIT,
  type MixerChannel,
  type MixerChannelRole,
  type MixerEffectSlot,
  type Project,
} from '../project/model';

export class MixerModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MixerModelError';
  }
}

/** Prefix that turns a Playlist track id into the event `channelId` its audio clips use. */
export const AUDIO_SOURCE_PREFIX = 'audio:';

/** Where unity gain (0 dB) sits on a level meter, in percent of the meter height. */
export const METER_UNITY_PERCENT = 82;

export type MixerSourceKind = 'channel' | 'track';

/** A routed signal source: a Channel Rack channel, or a Playlist track carrying audio clips. */
export interface MixerSourceState {
  /** Event `channelId` the voices use: the rack channel id, or `audio:<trackId>`. */
  id: string;
  kind: MixerSourceKind;
  mixerChannelId: string;
}

/** Audio-facing description of one mixer channel. Names and colours never reach the graph. */
export interface MixerChannelState {
  id: string;
  role: MixerChannelRole;
  volumeDb: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  /** `null` for the master bus, which always feeds the limiter and the hardware output. */
  outputId: string | null;
  /** Prepared effect slots, in signal order. Empty slots are unity bypasses. */
  effects: readonly MixerEffectSlot[];
}

/** Everything the audio runtime needs to build and diff the mixer graph. */
export interface MixerState {
  masterChannelId: string;
  /** All mixer channels in project order: the master bus first, then the inserts. */
  channels: readonly MixerChannelState[];
  sources: readonly MixerSourceState[];
}

// --------------------------------------------------------------------- levels

export function clampVolumeDb(db: number): number {
  if (!Number.isFinite(db)) return MIXER_MIN_DB;
  return Math.min(MIXER_MAX_DB, Math.max(MIXER_MIN_DB, db));
}

export function clampPan(pan: number): number {
  if (!Number.isFinite(pan)) return 0;
  return Math.min(MIXER_PAN_LIMIT, Math.max(-MIXER_PAN_LIMIT, pan));
}

/**
 * Convert a fader position to a linear gain. The fader floor maps to exact silence so a fully
 * pulled-down fader is truly silent rather than asymptotically close.
 */
export function dbToLinear(db: number): number {
  if (!Number.isFinite(db) || db <= MIXER_MIN_DB) return 0;
  return 10 ** (Math.min(MIXER_MAX_DB, db) / 20);
}

/** Inverse of `dbToLinear`, clamped into the fader range. */
export function linearToDb(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0) return MIXER_MIN_DB;
  return clampVolumeDb(20 * Math.log10(gain));
}

export function formatMixerDb(db: number): string {
  if (!Number.isFinite(db) || db <= MIXER_MIN_DB) return '-inf dB';
  const rounded = Math.round(db * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
}

export function formatPan(pan: number): string {
  const value = clampPan(pan);
  if (Math.abs(value) < 0.005) return 'C';
  const percent = Math.round(Math.abs(value) * 100);
  return `${percent}${value < 0 ? 'L' : 'R'}`;
}

/**
 * Map a dB level onto 0..100 percent of a meter's height.
 *
 * The scale is linear in dB with a taper around unity: `MIXER_MIN_DB..0 dB` fills the lower
 * `METER_UNITY_PERCENT` of the meter and `0..MIXER_MAX_DB` fills the headroom above it, so the
 * region users actually mix in gets most of the travel.
 */
export function meterPercent(db: number): number {
  if (!Number.isFinite(db) || db <= MIXER_MIN_DB) return 0;
  if (db >= 0) return Math.min(100, METER_UNITY_PERCENT + (Math.min(db, MIXER_MAX_DB) / MIXER_MAX_DB) * (100 - METER_UNITY_PERCENT));
  // Linear in dB between the meter floor and unity: -60 dB sits at 0% and 0 dB at METER_UNITY_PERCENT.
  return METER_UNITY_PERCENT * ((db - MIXER_MIN_DB) / -MIXER_MIN_DB);
}

// ------------------------------------------------------------------- lookups

export function getMasterChannel(project: Project): MixerChannel | undefined {
  return project.mixerChannels.find((channel) => channel.role === 'master');
}

/** Insert (non-master) mixer channels, in project display order. */
export function getInsertChannels(project: Project): MixerChannel[] {
  return project.mixerChannels.filter((channel) => channel.role === 'insert');
}

export function getMixerChannel(project: Project, id: string): MixerChannel | undefined {
  return project.mixerChannels.find((channel) => channel.id === id);
}

export function requireMixerChannel(project: Project, id: string): MixerChannel {
  const channel = getMixerChannel(project, id);
  if (!channel) throw new MixerModelError(`Mixer channel "${id}" does not exist.`);
  return channel;
}

export function requireMasterMixerChannel(project: Project): MixerChannel {
  const master = getMasterChannel(project);
  if (!master) throw new MixerModelError('The project has no master mixer bus.');
  return master;
}

/** Event `channelId` used by the audio clips of a Playlist track. */
export function audioSourceId(trackId: string): string {
  return `${AUDIO_SOURCE_PREFIX}${trackId}`;
}

export function trackIdFromSourceId(sourceId: string): string | null {
  return sourceId.startsWith(AUDIO_SOURCE_PREFIX) ? sourceId.slice(AUDIO_SOURCE_PREFIX.length) : null;
}

/** Every routed source, in a stable order: rack channels first, then Playlist tracks. */
export function listMixerSources(project: Project): MixerSourceState[] {
  return [
    ...project.channels.map((channel) => ({ id: channel.id, kind: 'channel' as const, mixerChannelId: channel.mixerChannelId })),
    ...project.tracks.map((track) => ({ id: audioSourceId(track.id), kind: 'track' as const, mixerChannelId: track.mixerChannelId })),
  ];
}

/** Sources assigned to one mixer channel, with display names taken from the project. */
export function listSourcesForChannel(project: Project, mixerChannelId: string): Array<MixerSourceState & { name: string }> {
  const names = new Map<string, string>([
    ...project.channels.map((channel): [string, string] => [channel.id, channel.name]),
    ...project.tracks.map((track): [string, string] => [audioSourceId(track.id), track.name]),
  ]);
  return listMixerSources(project)
    .filter((source) => source.mixerChannelId === mixerChannelId)
    .map((source) => ({ ...source, name: names.get(source.id) ?? source.id }));
}

// --------------------------------------------------------------- mute / solo

export function isAnyInsertSoloed(project: Project): boolean {
  return getInsertChannels(project).some((channel) => channel.solo);
}

export type MixerSilenceReason = 'audible' | 'muted' | 'soloed-out';

/**
 * Resolve one channel's own gate. Mute always wins over solo, matching the Channel Rack and
 * Playlist rules; solo on the master bus is ignored because the master sums every insert.
 *
 * This resolves a channel's *own* gate only. A channel feeding a gated destination is silenced by
 * that destination, which is what keeps solo from bypassing the master bus.
 */
export function resolveMixerAudibility(channel: MixerChannel, project: Project): { audible: boolean; reason: MixerSilenceReason } {
  if (channel.muted) return { audible: false, reason: 'muted' };
  if (channel.role === 'insert' && isAnyInsertSoloed(project) && !channel.solo) return { audible: false, reason: 'soloed-out' };
  return { audible: true, reason: 'audible' };
}

/** Linear gain the graph should apply to a channel: its fader, or exact silence when gated. */
export function resolveEffectiveGain(channel: MixerChannel, project: Project): number {
  return resolveMixerAudibility(channel, project).audible ? dbToLinear(channel.volumeDb) : 0;
}

// ------------------------------------------------------------------- routing

export type MixerRoutingIssueCode = 'missing-channel' | 'self-route' | 'master-output' | 'cycle' | 'bypasses-master' | 'too-many-inserts';

export interface MixerRoutingIssue {
  code: MixerRoutingIssueCode;
  message: string;
  /** Channel ids involved, from the edited channel to the one that closes the problem. */
  path: string[];
}

function label(channels: readonly MixerChannel[], id: string): string {
  return channels.find((channel) => channel.id === id)?.name ?? id;
}

/**
 * Check a proposed `fromId -> toId` destination change against the rest of the routing graph.
 * Returns `null` when the route is legal.
 */
export function findRoutingIssue(
  channels: readonly MixerChannel[],
  fromId: string,
  toId: string,
): MixerRoutingIssue | null {
  const from = channels.find((channel) => channel.id === fromId);
  if (!from) return { code: 'missing-channel', message: `Mixer channel "${fromId}" does not exist.`, path: [fromId] };
  if (from.role === 'master') {
    return { code: 'master-output', message: 'The master bus always feeds the output and cannot be rerouted.', path: [fromId] };
  }
  const to = channels.find((channel) => channel.id === toId);
  if (!to) return { code: 'missing-channel', message: `Mixer channel "${toId}" does not exist.`, path: [fromId, toId] };
  if (toId === fromId) {
    return { code: 'self-route', message: `${from.name} cannot route to itself.`, path: [fromId] };
  }
  // Walk upstream from the proposed destination: reaching `fromId` again would close a loop.
  const path = [fromId, toId];
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  let cursor = to;
  while (cursor.role === 'insert') {
    const nextId = cursor.outputId;
    if (!nextId) break;
    if (nextId === fromId) {
      return { code: 'cycle', message: `Routing ${from.name} to ${to.name} would create a cycle (${path.map((id) => label(channels, id)).join(' → ')} → ${from.name}).`, path: [...path, fromId] };
    }
    const next = byId.get(nextId);
    if (!next) break;
    path.push(nextId);
    cursor = next;
  }
  return null;
}

/** Validate a whole channel list's routing. Returns the first problem found, or `null`. */
export function validateMixerRouting(channels: readonly MixerChannel[]): MixerRoutingIssue | null {
  const master = channels.find((channel) => channel.role === 'master');
  if (!master) return { code: 'missing-channel', message: 'The mixer has no master bus.', path: [] };
  const inserts = channels.filter((channel) => channel.role === 'insert');
  if (inserts.length > MAX_MIXER_INSERTS) {
    return { code: 'too-many-inserts', message: `A project supports at most ${MAX_MIXER_INSERTS} mixer channels besides the master bus.`, path: [] };
  }
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  for (const channel of inserts) {
    const outputId = channel.outputId;
    if (!outputId || !byId.has(outputId)) {
      return { code: 'missing-channel', message: `Mixer channel ${channel.name} routes to a missing mixer channel.`, path: [channel.id, outputId ?? ''] };
    }
    if (outputId === channel.id) {
      return { code: 'self-route', message: `Mixer channel ${channel.name} cannot route to itself.`, path: [channel.id] };
    }
    const seen = new Set<string>([channel.id]);
    let cursor = byId.get(outputId)!;
    while (cursor.role === 'insert') {
      if (seen.has(cursor.id)) {
        return { code: 'cycle', message: `Mixer channel ${channel.name} is part of a routing cycle.`, path: [...seen] };
      }
      seen.add(cursor.id);
      const nextId = cursor.outputId;
      if (!nextId) {
        return { code: 'bypasses-master', message: `Mixer channel ${channel.name} has no destination, so it bypasses the master bus.`, path: [channel.id] };
      }
      const next = byId.get(nextId);
      if (!next) {
        return { code: 'missing-channel', message: `Mixer channel ${cursor.name} routes to a missing mixer channel.`, path: [cursor.id, nextId] };
      }
      cursor = next;
    }
    if (cursor.id !== master.id) {
      return { code: 'bypasses-master', message: `Mixer channel ${channel.name} does not reach the master bus.`, path: [channel.id] };
    }
  }
  return null;
}

/**
 * Order mixer channels so every destination precedes the channels that feed it.
 *
 * The graph creates and connects buses in this order, so a destination node always exists before
 * something is connected into it. A (validated-away) cycle simply stops the recursion, and the
 * graph falls back to the master bus for the unresolved link instead of creating a feedback loop.
 */
export function orderDestinationsFirst<T extends { id: string; outputId: string | null }>(channels: readonly T[]): T[] {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const ordered: T[] = [];
  const placed = new Set<string>();
  const place = (channel: T, stack: Set<string>): void => {
    if (placed.has(channel.id) || stack.has(channel.id)) return;
    stack.add(channel.id);
    const destination = channel.outputId === null ? undefined : byId.get(channel.outputId);
    if (destination) place(destination, stack);
    stack.delete(channel.id);
    placed.add(channel.id);
    ordered.push(channel);
  };
  for (const channel of channels) place(channel, new Set());
  return ordered;
}

/** Legal destinations for one channel's output selector: the master bus plus every other insert. */
export function listRouteTargets(channels: readonly MixerChannel[], fromId: string): MixerChannel[] {
  const issueFree = (target: MixerChannel): boolean => findRoutingIssue(channels, fromId, target.id) === null;
  return channels.filter((channel) => channel.id !== fromId && issueFree(channel));
}

// -------------------------------------------------------------- state build

function toChannelState(channel: MixerChannel, masterChannelId: string): MixerChannelState {
  return {
    id: channel.id,
    role: channel.role,
    volumeDb: clampVolumeDb(channel.volumeDb),
    pan: clampPan(channel.pan),
    muted: channel.muted,
    solo: channel.solo,
    // An insert with a missing destination falls back to the master instead of going silent or
    // bypassing it. `assertValidProject` rejects such a document, so this only guards runtime data.
    outputId: channel.role === 'master' ? null : channel.outputId ?? masterChannelId,
    effects: channel.effects ?? [],
  };
}

/** Project mixer settings plus source routing, reduced to what the audio runtime needs. */
export function buildMixerState(project: Project): MixerState {
  const masterChannelId = getMasterChannel(project)?.id ?? '';
  return {
    masterChannelId,
    channels: project.mixerChannels.map((channel) => toChannelState(channel, masterChannelId)),
    sources: listMixerSources(project),
  };
}

/**
 * Identity of the mixer-relevant part of a project.
 *
 * Two projects with the same signature need the same audio graph, so the app can skip a sync — and,
 * more importantly, an arrangement-only signature can stay stable while the mixer changes. Display
 * names are deliberately excluded: renaming a channel must not touch audio.
 */
export function mixerStateSignature(project: Project): string {
  return JSON.stringify([
    project.mixerChannels.map((channel) => [
      channel.id,
      channel.role,
      channel.volumeDb,
      channel.pan,
      channel.muted,
      channel.solo,
      channel.outputId ?? null,
      channel.effects.map((slot) => [slot.id, slot.type, slot.enabled]),
    ]),
    project.channels.map((channel) => [channel.id, channel.mixerChannelId]),
    project.tracks.map((track) => [track.id, track.mixerChannelId]),
  ]);
}

/** First unused insert name, so a new channel never collides with an existing one. */
export function nextMixerChannelName(project: Project): string {
  const used = new Set(project.mixerChannels.map((channel) => channel.name.toLowerCase()));
  for (let index = project.mixerChannels.length; index <= MAX_MIXER_INSERTS + project.mixerChannels.length; index += 1) {
    const candidate = `Insert ${index}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `Insert ${project.mixerChannels.length}`;
}

export function isValidMixerName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_MIXER_NAME_LENGTH;
}
