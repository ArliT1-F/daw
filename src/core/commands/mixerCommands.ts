import {
  assertValidProject,
  createMixerEffectSlot,
  MASTER_MIXER_CHANNEL_ID,
  MAX_MIXER_INSERTS,
  MIXER_EFFECT_SLOT_COUNT,
  MIXER_MAX_DB,
  MIXER_MIN_DB,
  MIXER_PAN_LIMIT,
  type MixerChannel,
  type MixerEffectSlot,
  type Project,
} from '../project/model';
import {
  findRoutingIssue,
  getInsertChannels,
  isValidMixerName,
  requireMasterMixerChannel,
  requireMixerChannel,
  trackIdFromSourceId,
  validateMixerRouting,
} from '../mixer/mixerModel';
import { ProjectCommandError } from './commandError';

/**
 * Mixer edits.
 *
 * Every command is immutable, rejects invalid values instead of coercing them, and revalidates the
 * whole document before returning it — so a routing cycle, a dangling destination, or an
 * out-of-range fader can never enter project state, undo history, or the audio graph.
 */
export type MixerCommand =
  | { type: 'mixer.channel.add'; channel: MixerChannel }
  | { type: 'mixer.channel.rename'; channelId: string; name: string }
  | { type: 'mixer.channel.remove'; channelId: string }
  /** `toIndex` is the position within the insert list; the master bus always stays first. */
  | { type: 'mixer.channel.reorder'; channelId: string; toIndex: number }
  | { type: 'mixer.channel.volume.set'; channelId: string; volumeDb: number }
  | { type: 'mixer.channel.pan.set'; channelId: string; pan: number }
  | { type: 'mixer.channel.mute.set'; channelId: string; muted: boolean }
  | { type: 'mixer.channel.solo.set'; channelId: string; solo: boolean }
  | { type: 'mixer.channel.route'; channelId: string; outputId: string }
  /** Phase 7 hook: place, replace, or clear (`effect: null`) one prepared effect slot. */
  | { type: 'mixer.channel.effect.set'; channelId: string; slot: number; effect: MixerEffectSlot | null }
  | { type: 'mixer.solo.clear' }
  /** Route a Channel Rack channel or a Playlist track (`audio:<trackId>`) to a mixer channel. */
  | { type: 'mixer.source.assign'; sourceId: string; mixerChannelId: string };

/** Deterministic id for a built-in empty effect slot, so undo/redo replays identically. */
export function mixerEffectSlotId(channelId: string, slot: number): string {
  return `${channelId}-slot-${slot}`;
}

/** Command that adds a new insert bus with a fresh, caller-owned stable id. */
export function createAddMixerChannelCommand(project: Project, id: string, name?: string): MixerCommand {
  const inserts = getInsertChannels(project);
  if (inserts.length >= MAX_MIXER_INSERTS) {
    throw new ProjectCommandError(`A project supports at most ${MAX_MIXER_INSERTS} mixer channels besides the master bus.`);
  }
  const master = requireMasterMixerChannel(project);
  const used = new Set(project.mixerChannels.map((channel) => channel.name.toLowerCase()));
  const resolvedName = (name?.trim() || `Insert ${inserts.length + 1}`);
  let finalName = resolvedName;
  for (let suffix = 2; used.has(finalName.toLowerCase()); suffix += 1) finalName = `${resolvedName} ${suffix}`;
  return {
    type: 'mixer.channel.add',
    channel: {
      id,
      name: finalName,
      role: 'insert',
      volumeDb: 0,
      pan: 0,
      muted: false,
      solo: false,
      outputId: master.id,
      effects: [],
    },
  };
}

function updateMixerChannel(project: Project, channelId: string, update: (channel: MixerChannel) => MixerChannel): Project {
  let changed = false;
  const mixerChannels = project.mixerChannels.map((channel) => {
    if (channel.id !== channelId) return channel;
    changed = true;
    return update(channel);
  });
  if (!changed) throw new ProjectCommandError(`Mixer channel "${channelId}" does not exist.`);
  return { ...project, mixerChannels };
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ProjectCommandError(`${label} must be a boolean.`);
  return value;
}

/** Drop trailing empty effect slots so an unused chain stays out of the saved document. */
function trimEffectSlots(effects: MixerEffectSlot[]): MixerEffectSlot[] {
  const trimmed = [...effects];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (last.type !== null || last.enabled) break;
    trimmed.pop();
  }
  return trimmed;
}

export function applyMixerCommand(project: Project, command: MixerCommand): Project {
  let next: Project;
  switch (command.type) {
    case 'mixer.channel.add': {
      const { channel } = command;
      if (!channel.id.trim()) throw new ProjectCommandError('A new mixer channel needs an ID.');
      if (project.mixerChannels.some((item) => item.id === channel.id)) {
        throw new ProjectCommandError(`Mixer channel ID "${channel.id}" is already in use.`);
      }
      if (!isValidMixerName(channel.name)) throw new ProjectCommandError('Mixer channel name must be between 1 and 80 characters.');
      if (channel.role !== 'insert') throw new ProjectCommandError('A project can only contain one master bus.');
      if (getInsertChannels(project).length >= MAX_MIXER_INSERTS) {
        throw new ProjectCommandError(`A project supports at most ${MAX_MIXER_INSERTS} mixer channels besides the master bus.`);
      }
      const master = requireMasterMixerChannel(project);
      const added: MixerChannel = { ...channel, outputId: channel.outputId ?? master.id, effects: channel.effects.map((slot) => ({ ...slot, params: { ...slot.params } })) };
      const issue = findRoutingIssue([...project.mixerChannels, added], added.id, added.outputId!);
      if (issue) throw new ProjectCommandError(issue.message);
      next = { ...project, mixerChannels: [...project.mixerChannels, added] };
      break;
    }

    case 'mixer.channel.rename': {
      if (!isValidMixerName(command.name)) throw new ProjectCommandError('Mixer channel name must be between 1 and 80 characters.');
      const name = command.name.trim();
      const channel = requireMixerChannel(project, command.channelId);
      if (channel.name === name) return project;
      next = updateMixerChannel(project, command.channelId, (current) => ({ ...current, name }));
      break;
    }

    case 'mixer.channel.remove': {
      const channel = requireMixerChannel(project, command.channelId);
      if (channel.role === 'master') throw new ProjectCommandError('The master bus cannot be removed.');
      const master = requireMasterMixerChannel(project);
      // Splice the channel out of the signal flow: whatever fed it now feeds its own destination,
      // so removing a bus can never orphan a path or bypass the master.
      const fallback = channel.outputId ?? master.id;
      const mixerChannels = project.mixerChannels
        .filter((item) => item.id !== channel.id)
        .map((item) => (item.role === 'insert' && item.outputId === channel.id ? { ...item, outputId: fallback } : item));
      const reroute = <T extends { mixerChannelId: string }>(items: T[]): T[] =>
        items.map((item) => (item.mixerChannelId === channel.id ? { ...item, mixerChannelId: fallback } : item));
      next = {
        ...project,
        mixerChannels,
        channels: reroute(project.channels),
        tracks: reroute(project.tracks),
      };
      break;
    }

    case 'mixer.channel.reorder': {
      const channel = requireMixerChannel(project, command.channelId);
      if (channel.role === 'master') throw new ProjectCommandError('The master bus stays at the end of the mixer.');
      const [head, ...inserts] = project.mixerChannels;
      const from = inserts.findIndex((item) => item.id === channel.id);
      if (!Number.isInteger(command.toIndex) || command.toIndex < 0 || command.toIndex >= inserts.length) {
        throw new ProjectCommandError('Mixer channel order is outside the mixer.');
      }
      if (from === command.toIndex) return project;
      const reordered = inserts.filter((item) => item.id !== channel.id);
      reordered.splice(command.toIndex, 0, channel);
      next = { ...project, mixerChannels: [head, ...reordered] };
      break;
    }

    case 'mixer.channel.volume.set': {
      const channel = requireMixerChannel(project, command.channelId);
      if (!Number.isFinite(command.volumeDb) || command.volumeDb < MIXER_MIN_DB || command.volumeDb > MIXER_MAX_DB) {
        throw new ProjectCommandError(`Mixer volume must be between ${MIXER_MIN_DB} and ${MIXER_MAX_DB} dB.`);
      }
      if (channel.volumeDb === command.volumeDb) return project;
      next = updateMixerChannel(project, command.channelId, (current) => ({ ...current, volumeDb: command.volumeDb }));
      break;
    }

    case 'mixer.channel.pan.set': {
      const channel = requireMixerChannel(project, command.channelId);
      if (!Number.isFinite(command.pan) || command.pan < -MIXER_PAN_LIMIT || command.pan > MIXER_PAN_LIMIT) {
        throw new ProjectCommandError(`Mixer pan must be between -${MIXER_PAN_LIMIT} and ${MIXER_PAN_LIMIT}.`);
      }
      if (channel.pan === command.pan) return project;
      next = updateMixerChannel(project, command.channelId, (current) => ({ ...current, pan: command.pan }));
      break;
    }

    case 'mixer.channel.mute.set':
    case 'mixer.channel.solo.set': {
      const channel = requireMixerChannel(project, command.channelId);
      const muted = command.type === 'mixer.channel.mute.set' ? requireBoolean(command.muted, 'Mute state') : channel.muted;
      const solo = command.type === 'mixer.channel.solo.set' ? requireBoolean(command.solo, 'Solo state') : channel.solo;
      if (channel.muted === muted && channel.solo === solo) return project;
      next = updateMixerChannel(project, command.channelId, (current) => ({ ...current, muted, solo }));
      break;
    }

    case 'mixer.channel.route': {
      const channel = requireMixerChannel(project, command.channelId);
      const issue = findRoutingIssue(project.mixerChannels, command.channelId, command.outputId);
      if (issue) throw new ProjectCommandError(issue.message);
      if (channel.outputId === command.outputId) return project;
      next = updateMixerChannel(project, command.channelId, (current) => ({ ...current, outputId: command.outputId }));
      break;
    }

    case 'mixer.channel.effect.set': {
      const channel = requireMixerChannel(project, command.channelId);
      if (!Number.isInteger(command.slot) || command.slot < 0 || command.slot >= MIXER_EFFECT_SLOT_COUNT) {
        throw new ProjectCommandError(`Mixer effect slot must be between 0 and ${MIXER_EFFECT_SLOT_COUNT - 1}.`);
      }
      const effects: MixerEffectSlot[] = channel.effects.map((slot) => ({ ...slot, params: { ...slot.params } }));
      while (effects.length <= command.slot) {
        effects.push(createMixerEffectSlot(mixerEffectSlotId(channel.id, effects.length)));
      }
      if (command.effect === null) {
        effects[command.slot] = createMixerEffectSlot(mixerEffectSlotId(channel.id, command.slot));
      } else {
        const { effect } = command;
        if (!effect.id.trim()) throw new ProjectCommandError('A mixer effect slot needs an ID.');
        if (effects.some((slot, index) => index !== command.slot && slot.id === effect.id)) {
          throw new ProjectCommandError('Mixer effect slot IDs must be unique within a channel.');
        }
        effects[command.slot] = { ...effect, params: { ...effect.params } };
      }
      const trimmed = trimEffectSlots(effects);
      if (JSON.stringify(trimmed) === JSON.stringify(channel.effects)) return project;
      next = updateMixerChannel(project, command.channelId, (current) => ({ ...current, effects: trimmed }));
      break;
    }

    case 'mixer.solo.clear': {
      if (!getInsertChannels(project).some((channel) => channel.solo)) return project;
      next = { ...project, mixerChannels: project.mixerChannels.map((channel) => (channel.solo ? { ...channel, solo: false } : channel)) };
      break;
    }

    case 'mixer.source.assign': {
      const destination = requireMixerChannel(project, command.mixerChannelId);
      const trackId = trackIdFromSourceId(command.sourceId);
      if (trackId !== null) {
        const track = project.tracks.find((item) => item.id === trackId);
        if (!track) throw new ProjectCommandError(`Playlist track "${trackId}" does not exist.`);
        if (track.mixerChannelId === destination.id) return project;
        next = { ...project, tracks: project.tracks.map((item) => (item.id === track.id ? { ...item, mixerChannelId: destination.id } : item)) };
        break;
      }
      const channel = project.channels.find((item) => item.id === command.sourceId);
      if (!channel) throw new ProjectCommandError(`Mixer source "${command.sourceId}" does not exist.`);
      if (channel.mixerChannelId === destination.id) return project;
      next = { ...project, channels: project.channels.map((item) => (item.id === channel.id ? { ...item, mixerChannelId: destination.id } : item)) };
      break;
    }

    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }

  const issue = validateMixerRouting(next.mixerChannels);
  if (issue) throw new ProjectCommandError(issue.message);
  try {
    assertValidProject(next);
  } catch (error) {
    throw new ProjectCommandError(error instanceof Error ? error.message : 'Invalid mixer edit.');
  }
  return next;
}

/** Mixer channel a brand-new source should be routed to: the first insert, else the master bus. */
export function defaultMixerDestination(project: Project): string {
  return getInsertChannels(project)[0]?.id ?? getMasterChannelId(project);
}

function getMasterChannelId(project: Project): string {
  return project.mixerChannels.find((channel) => channel.role === 'master')?.id ?? MASTER_MIXER_CHANNEL_ID;
}
