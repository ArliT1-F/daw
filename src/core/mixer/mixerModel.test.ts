import { describe, expect, it } from 'vitest';
import {
  createInitialProject,
  createMasterMixerChannel,
  createMixerChannel,
  MAX_MIXER_INSERTS,
  MIXER_MAX_DB,
  MIXER_MIN_DB,
  type MixerChannel,
  type Project,
} from '../project/model';
import { applyProjectCommand, createAddMixerChannelCommand } from '../commands';
import {
  audioSourceId,
  buildMixerState,
  clampPan,
  clampVolumeDb,
  dbToLinear,
  findRoutingIssue,
  formatMixerDb,
  formatPan,
  getInsertChannels,
  getMasterChannel,
  isAnyInsertSoloed,
  linearToDb,
  listMixerSources,
  listRouteTargets,
  listSourcesForChannel,
  meterPercent,
  mixerStateSignature,
  METER_UNITY_PERCENT,
  nextMixerChannelName,
  orderDestinationsFirst,
  resolveEffectiveGain,
  resolveMixerAudibility,
  trackIdFromSourceId,
  validateMixerRouting,
} from './mixerModel';

const MASTER = 'mixer-master';

function starter(): Project {
  return createInitialProject();
}

function insert(project: Project, id: string): MixerChannel {
  const channel = project.mixerChannels.find((item) => item.id === id);
  if (!channel) throw new Error(`missing ${id}`);
  return channel;
}

/** A project whose inserts are chained: 1 → 2 → 3 → 4 → master. */
function chainedProject(): Project {
  let project = starter();
  project = applyProjectCommand(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' });
  project = applyProjectCommand(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-2', outputId: 'mixer-insert-3' });
  project = applyProjectCommand(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-3', outputId: 'mixer-insert-4' });
  return project;
}

describe('mixer level maths', () => {
  it('converts dB fader positions to linear gain and back', () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 12);
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 4);
    expect(dbToLinear(MIXER_MAX_DB)).toBeCloseTo(3.9811, 4);
    // The fader floor is exact silence, not an asymptote.
    expect(dbToLinear(MIXER_MIN_DB)).toBe(0);
    expect(dbToLinear(-Infinity)).toBe(0);
    expect(dbToLinear(Number.NaN)).toBe(0);
    expect(linearToDb(1)).toBeCloseTo(0, 12);
    expect(linearToDb(0)).toBe(MIXER_MIN_DB);
    expect(linearToDb(-1)).toBe(MIXER_MIN_DB);
    for (const db of [-60, -40, -12, -0.5, 0, 6, 12]) {
      expect(linearToDb(dbToLinear(db))).toBeCloseTo(db, 9);
    }
  });

  it('clamps out-of-range values instead of producing unusable gains', () => {
    expect(clampVolumeDb(-90)).toBe(MIXER_MIN_DB);
    expect(clampVolumeDb(40)).toBe(MIXER_MAX_DB);
    expect(clampVolumeDb(Number.NaN)).toBe(MIXER_MIN_DB);
    expect(clampPan(-4)).toBe(-1);
    expect(clampPan(4)).toBe(1);
    expect(clampPan(Number.NaN)).toBe(0);
  });

  it('formats fader and pan readouts', () => {
    expect(formatMixerDb(0)).toBe('0.0 dB');
    expect(formatMixerDb(-6)).toBe('-6.0 dB');
    expect(formatMixerDb(3.25)).toBe('+3.3 dB');
    expect(formatMixerDb(MIXER_MIN_DB)).toBe('-inf dB');
    expect(formatPan(0)).toBe('C');
    expect(formatPan(-1)).toBe('100L');
    expect(formatPan(0.5)).toBe('50R');
  });

  it('maps dB onto a meter scale that gives unity most of the travel', () => {
    expect(meterPercent(MIXER_MIN_DB)).toBe(0);
    expect(meterPercent(-Infinity)).toBe(0);
    expect(meterPercent(0)).toBe(METER_UNITY_PERCENT);
    expect(meterPercent(MIXER_MAX_DB)).toBe(100);
    expect(meterPercent(MIXER_MAX_DB + 20)).toBe(100);
    expect(meterPercent(-30)).toBeCloseTo(METER_UNITY_PERCENT / 2, 9);
    // Strictly increasing across the whole meter, so a bar can never move backwards as level rises.
    let previous = -1;
    for (let db = MIXER_MIN_DB; db <= MIXER_MAX_DB; db += 1) {
      const percent = meterPercent(db);
      expect(percent).toBeGreaterThan(previous);
      previous = percent;
    }
  });
});

describe('mixer channel lookups', () => {
  it('keeps the master bus separate from the ordered inserts', () => {
    const project = starter();
    expect(getMasterChannel(project)?.role).toBe('master');
    expect(getMasterChannel(project)?.id).toBe(MASTER);
    expect(getInsertChannels(project).map((channel) => channel.id)).toEqual([
      'mixer-insert-1',
      'mixer-insert-2',
      'mixer-insert-3',
      'mixer-insert-4',
    ]);
  });

  it('preserves channel order after a reorder edit', () => {
    const project = applyProjectCommand(starter(), { type: 'mixer.channel.reorder', channelId: 'mixer-insert-3', toIndex: 0 });
    expect(getInsertChannels(project).map((channel) => channel.id)).toEqual([
      'mixer-insert-3',
      'mixer-insert-1',
      'mixer-insert-2',
      'mixer-insert-4',
    ]);
    expect(project.mixerChannels[0].id).toBe(MASTER);
  });

  it('names a new channel without colliding with an existing one', () => {
    expect(nextMixerChannelName(starter())).toBe('Insert 5');
    const renamed = applyProjectCommand(starter(), { type: 'mixer.channel.rename', channelId: 'mixer-insert-1', name: 'Insert 5' });
    expect(nextMixerChannelName(renamed)).toBe('Insert 6');
  });
});

describe('mute and solo resolution', () => {
  it('gates a muted channel and lets mute win over solo', () => {
    const project = applyProjectCommand(starter(), { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-1', muted: true });
    expect(resolveMixerAudibility(insert(project, 'mixer-insert-1'), project)).toEqual({ audible: false, reason: 'muted' });
    expect(resolveEffectiveGain(insert(project, 'mixer-insert-1'), project)).toBe(0);

    const mutedAndSoloed = applyProjectCommand(project, { type: 'mixer.channel.solo.set', channelId: 'mixer-insert-1', solo: true });
    expect(resolveMixerAudibility(insert(mutedAndSoloed, 'mixer-insert-1'), mutedAndSoloed)).toEqual({ audible: false, reason: 'muted' });
  });

  it('gates every unsoloed insert while any insert is soloed', () => {
    const project = applyProjectCommand(starter(), { type: 'mixer.channel.solo.set', channelId: 'mixer-insert-2', solo: true });
    expect(isAnyInsertSoloed(project)).toBe(true);
    expect(resolveMixerAudibility(insert(project, 'mixer-insert-2'), project).audible).toBe(true);
    for (const id of ['mixer-insert-1', 'mixer-insert-3', 'mixer-insert-4']) {
      expect(resolveMixerAudibility(insert(project, id), project)).toEqual({ audible: false, reason: 'soloed-out' });
    }
  });

  it('applies the fader gain only to an audible channel', () => {
    let project = applyProjectCommand(starter(), { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -6 });
    expect(resolveEffectiveGain(insert(project, 'mixer-insert-1'), project)).toBeCloseTo(dbToLinear(-6), 12);
    project = applyProjectCommand(project, { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-1', muted: true });
    expect(resolveEffectiveGain(insert(project, 'mixer-insert-1'), project)).toBe(0);
  });

  it('ignores solo on the master bus but honours its mute', () => {
    const master = getMasterChannel(starter())!;
    const soloedMaster = { ...master, solo: true };
    expect(resolveMixerAudibility(soloedMaster, starter())).toEqual({ audible: true, reason: 'audible' });
    expect(resolveMixerAudibility({ ...master, muted: true }, starter())).toEqual({ audible: false, reason: 'muted' });
  });
});

describe('mixer routing rules', () => {
  it('accepts the starter routing and a chain of sub-buses', () => {
    expect(validateMixerRouting(starter().mixerChannels)).toBeNull();
    expect(validateMixerRouting(chainedProject().mixerChannels)).toBeNull();
  });

  it('rejects routing a channel to itself', () => {
    const issue = findRoutingIssue(starter().mixerChannels, 'mixer-insert-1', 'mixer-insert-1');
    expect(issue?.code).toBe('self-route');
  });

  it('rejects a destination that does not exist', () => {
    expect(findRoutingIssue(starter().mixerChannels, 'mixer-insert-1', 'mixer-nope')?.code).toBe('missing-channel');
    expect(findRoutingIssue(starter().mixerChannels, 'mixer-nope', MASTER)?.code).toBe('missing-channel');
  });

  it('refuses to reroute the master bus', () => {
    expect(findRoutingIssue(starter().mixerChannels, MASTER, 'mixer-insert-1')?.code).toBe('master-output');
    expect(listRouteTargets(starter().mixerChannels, MASTER)).toEqual([]);
  });

  it('rejects a two-channel cycle and names the channels involved', () => {
    const project = applyProjectCommand(starter(), { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' });
    const issue = findRoutingIssue(project.mixerChannels, 'mixer-insert-2', 'mixer-insert-1');
    expect(issue?.code).toBe('cycle');
    expect(issue?.message).toMatch(/Kick/);
    expect(issue?.message).toMatch(/Snare/);
    expect(issue?.path).toEqual(['mixer-insert-2', 'mixer-insert-1', 'mixer-insert-2']);
  });

  it('rejects a longer cycle several channels upstream', () => {
    const project = chainedProject();
    expect(findRoutingIssue(project.mixerChannels, 'mixer-insert-4', 'mixer-insert-1')?.code).toBe('cycle');
    // A chain that ends at the master stays legal.
    expect(findRoutingIssue(project.mixerChannels, 'mixer-insert-4', MASTER)).toBeNull();
  });

  it('offers only legal destinations to the output selector', () => {
    const project = applyProjectCommand(starter(), { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' });
    const targets = listRouteTargets(project.mixerChannels, 'mixer-insert-2').map((channel) => channel.id);
    expect(targets).not.toContain('mixer-insert-2');
    expect(targets).not.toContain('mixer-insert-1');
    expect(targets).toContain(MASTER);
    expect(targets).toContain('mixer-insert-3');
  });

  it('detects a whole-graph cycle, a missing destination, and a path that bypasses the master', () => {
    const cyclic: MixerChannel[] = [
      createMasterMixerChannel(MASTER),
      createMixerChannel('a', 'A', 'b'),
      createMixerChannel('b', 'B', 'a'),
    ];
    expect(validateMixerRouting(cyclic)?.code).toBe('cycle');

    const dangling: MixerChannel[] = [createMasterMixerChannel(MASTER), createMixerChannel('a', 'A', 'ghost')];
    expect(validateMixerRouting(dangling)?.code).toBe('missing-channel');

    const noDestination: MixerChannel[] = [createMasterMixerChannel(MASTER), { ...createMixerChannel('a', 'A', MASTER), outputId: undefined }];
    expect(validateMixerRouting(noDestination)?.code).toBe('missing-channel');

    // A chain that terminates somewhere other than the master bus would bypass the output.
    const bypassing: MixerChannel[] = [
      createMasterMixerChannel(MASTER),
      createMasterMixerChannel('second-master', 'Sub Master'),
      createMixerChannel('a', 'A', 'second-master'),
    ];
    expect(validateMixerRouting(bypassing)?.code).toBe('bypasses-master');

    expect(validateMixerRouting([createMixerChannel('a', 'A', 'a')])?.code).toBe('missing-channel');
  });

  it('orders destinations before the channels that feed them', () => {
    const state = buildMixerState(chainedProject());
    const ordered = orderDestinationsFirst(state.channels).map((channel) => channel.id);
    expect(ordered.indexOf(MASTER)).toBeLessThan(ordered.indexOf('mixer-insert-4'));
    expect(ordered.indexOf('mixer-insert-4')).toBeLessThan(ordered.indexOf('mixer-insert-3'));
    expect(ordered.indexOf('mixer-insert-3')).toBeLessThan(ordered.indexOf('mixer-insert-2'));
    expect(ordered.indexOf('mixer-insert-2')).toBeLessThan(ordered.indexOf('mixer-insert-1'));
  });

  it('terminates instead of looping when handed an impossible cyclic state', () => {
    const cyclic = [
      { id: 'a', outputId: 'b' },
      { id: 'b', outputId: 'a' },
      { id: MASTER, outputId: null },
    ];
    expect(orderDestinationsFirst(cyclic).map((channel) => channel.id)).toHaveLength(3);
  });

  it('bounds the number of inserts a project can hold', () => {
    let project = starter();
    while (getInsertChannels(project).length < MAX_MIXER_INSERTS) {
      project = applyProjectCommand(project, createAddMixerChannelCommand(project, `mixer-extra-${getInsertChannels(project).length}`));
    }
    expect(getInsertChannels(project)).toHaveLength(MAX_MIXER_INSERTS);
    const overflowing = [...project.mixerChannels, createMixerChannel('one-too-many', 'Too many', MASTER)];
    expect(validateMixerRouting(overflowing)?.code).toBe('too-many-inserts');
  });
});

describe('mixer state for the audio runtime', () => {
  it('routes rack channels and Playlist tracks by their own source ids', () => {
    const project = starter();
    const state = buildMixerState(project);
    expect(state.masterChannelId).toBe(MASTER);
    expect(state.channels[0]).toMatchObject({ id: MASTER, role: 'master', outputId: null });
    expect(state.sources).toContainEqual({ id: 'channel-kick', kind: 'channel', mixerChannelId: 'mixer-insert-1' });
    expect(state.sources).toContainEqual({ id: audioSourceId('track-audio'), kind: 'track', mixerChannelId: MASTER });
    expect(trackIdFromSourceId(audioSourceId('track-audio'))).toBe('track-audio');
    expect(trackIdFromSourceId('channel-kick')).toBeNull();
  });

  it('stays total for unusable destinations, leaving the master fallback to the graph', () => {
    const project = starter();
    // `buildMixerState` never throws and never invents routing: an unusable destination is passed
    // through, and the audio graph resolves it to the master bus (and reports it) instead.
    const danglingBus = buildMixerState({
      ...project,
      mixerChannels: project.mixerChannels.map((channel) =>
        channel.id === 'mixer-insert-1' ? { ...channel, outputId: 'ghost' } : channel,
      ),
    });
    expect(danglingBus.channels.find((channel) => channel.id === 'mixer-insert-1')?.outputId).toBe('ghost');

    const orphanSource = buildMixerState({
      ...project,
      channels: project.channels.map((channel) => ({ ...channel, mixerChannelId: 'ghost' })),
    });
    expect(orphanSource.sources.filter((source) => source.kind === 'channel').every((source) => source.mixerChannelId === 'ghost')).toBe(true);
    expect(orphanSource.sources.filter((source) => source.kind === 'track').every((source) => source.mixerChannelId === MASTER)).toBe(true);

    // A missing master still produces a usable state rather than throwing.
    expect(buildMixerState({ ...project, mixerChannels: [] }).masterChannelId).toBe('');
  });

  it('lists the sources assigned to a channel with their display names', () => {
    let project = starter();
    project = applyProjectCommand(project, { type: 'mixer.source.assign', sourceId: audioSourceId('track-audio'), mixerChannelId: 'mixer-insert-1' });
    const sources = listSourcesForChannel(project, 'mixer-insert-1');
    expect(sources.map((source) => source.name)).toEqual(['Kick', 'Audio']);
    expect(listSourcesForChannel(project, 'mixer-insert-2').map((source) => source.name)).toEqual(['Snare']);
    expect(listMixerSources(project)).toHaveLength(project.channels.length + project.tracks.length);
  });

  it('changes the mixer signature for mixer edits only', () => {
    const project = starter();
    const before = mixerStateSignature(project);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -3 }))).not.toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'mixer.channel.pan.set', channelId: 'mixer-insert-1', pan: -0.4 }))).not.toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-1', muted: true }))).not.toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'mixer.channel.solo.set', channelId: 'mixer-insert-1', solo: true }))).not.toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' }))).not.toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'mixer.channel.reorder', channelId: 'mixer-insert-1', toIndex: 3 }))).not.toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'mixer.source.assign', sourceId: 'channel-kick', mixerChannelId: MASTER }))).not.toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 0, effect: { id: 'slot-0', type: 'gain', enabled: true, params: { amount: 0.5 } } }))).not.toBe(before);
  });

  it('keeps the mixer signature stable for edits that cannot affect the mix', () => {
    const project = starter();
    const before = mixerStateSignature(project);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'mixer.channel.rename', channelId: 'mixer-insert-1', name: 'Thump' }))).toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'channel.rename', channelId: 'channel-kick', name: 'Thump' }))).toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'pattern.step.toggle', patternId: 'pattern-main', channelId: 'channel-kick', step: 3 }))).toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'project.tempo.set', tempo: 90 }))).toBe(before);
    expect(mixerStateSignature(applyProjectCommand(project, { type: 'playlist.track.mute.set', trackId: 'track-main', muted: true }))).toBe(before);
  });
});
