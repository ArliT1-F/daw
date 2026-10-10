import { describe, expect, it } from 'vitest';
import { applyProjectCommand, type ProjectCommand } from '../core/commands';
import { buildMixerState, audioSourceId, type MixerState } from '../core/mixer/mixerModel';
import { createInitialProject, type Project } from '../core/project/model';
import { AudioGraph } from './AudioGraph';
import type { AudioEffectProcessor } from './mixerNodes';
import {
  createFakeAudioContext,
  type FakeAudioContext,
  type FakeAudioNode,
  type FakeGainNode,
} from './__fixtures__/fakeAudioContext';

const MASTER = 'mixer-master';

/** Casts: the graph is typed against the real Web Audio API, but these tests run on the double. */
const node = (value: AudioNode | null | undefined): FakeAudioNode => value as unknown as FakeAudioNode;
const gain = (value: GainNode): FakeGainNode => value as unknown as FakeGainNode;

function makeGraph(options: ConstructorParameters<typeof AudioGraph>[1] = {}) {
  const { context, fake } = createFakeAudioContext({ startRunning: true });
  const graph = new AudioGraph(context, options);
  return { graph, fake };
}

function starter(): Project {
  return createInitialProject();
}

function edit(project: Project, command: ProjectCommand): Project {
  return applyProjectCommand(project, command);
}

function sync(graph: AudioGraph, project: Project, canPruneStrips = false): void {
  graph.syncMixer(buildMixerState(project), { canPruneStrips });
}

/** A trivial node pair standing in for a Phase 7 effect processor. */
function makeProcessor(fake: FakeAudioContext, id: string) {
  const input = fake.createGain();
  const output = fake.createGain();
  input.connect(output);
  return { id, input, output, dispose: () => {} };
}

describe('mixer graph topology', () => {
  it('routes every source strip through its assigned bus into the master bus and the limiter', () => {
    const { graph, fake } = makeGraph();
    sync(graph, starter());

    for (const channel of starter().channels) {
      const strip = graph.getStrip(channel.id)!;
      const bus = graph.getBus(channel.mixerChannelId)!;
      expect(strip.destinationNode).toBe(bus.input);
      // Exactly one send target: a source can never reach the master through two paths.
      expect(node(strip.send).connectionCount).toBe(1);
      expect(node(strip.input).reaches(fake.destination)).toBe(true);
      expect(node(strip.input).reaches(node(bus.input))).toBe(true);
    }

    for (const bus of [graph.getBus('mixer-insert-1')!, graph.getBus('mixer-insert-4')!, graph.masterBus]) {
      expect(node(bus.input).reaches(fake.destination)).toBe(true);
      // A bus's output must never feed back into its own input.
      expect(node(bus.tail).reaches(node(bus.input))).toBe(false);
    }
    // The master path itself: master tail → limiter → destination, and nothing ever reroutes it.
    expect(node(graph.masterBus.tail).reaches(node(graph.limiter))).toBe(true);
    expect(node(graph.limiter).reaches(fake.destination)).toBe(true);
    expect(graph.masterBus.destinationNode).toBe(graph.limiter);
  });

  it('keeps a single signal path per source even after syncing the same state twice', () => {
    const { graph } = makeGraph();
    sync(graph, starter());
    sync(graph, starter());
    const strip = graph.getStrip('channel-kick')!;
    expect(node(strip.send).connectionCount).toBe(1);
    expect(node(graph.getBus('mixer-insert-1')!.tail).connectionCount).toBe(1);
    expect(graph.getStripIds().sort()).toEqual(
      ['audio:track-audio', 'audio:track-layer', 'audio:track-main', 'channel-bass', 'channel-hat', 'channel-kick', 'channel-snare'].sort(),
    );
  });

  it('supports nested sub-buses without creating a feedback path', () => {
    const { graph } = makeGraph();
    let project = starter();
    project = edit(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' });
    project = edit(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-2', outputId: 'mixer-insert-3' });
    sync(graph, project);

    const bus1 = graph.getBus('mixer-insert-1')!;
    const bus2 = graph.getBus('mixer-insert-2')!;
    const bus3 = graph.getBus('mixer-insert-3')!;
    expect(node(bus1.tail).reaches(node(bus2.input))).toBe(true);
    expect(node(bus2.tail).reaches(node(bus3.input))).toBe(true);
    expect(node(bus3.tail).reaches(node(graph.masterBus.input))).toBe(true);
    expect(node(bus1.input).reaches(fakeOf(graph).destination)).toBe(true);
    for (const bus of [bus1, bus2, bus3]) expect(node(bus.tail).reaches(node(bus.input))).toBe(false);
  });

  it('routes Playlist audio tracks through their own source strip by track id', () => {
    const { graph } = makeGraph();
    const project = edit(starter(), { type: 'mixer.source.assign', sourceId: audioSourceId('track-audio'), mixerChannelId: 'mixer-insert-2' });
    sync(graph, project);

    const strip = graph.getStrip(audioSourceId('track-audio'))!;
    expect(strip.destinationNode).toBe(graph.getBus('mixer-insert-2')!.input);
    expect(node(strip.input).reaches(fakeOf(graph).destination)).toBe(true);
  });

  it('routes an unknown source (such as an audition) to the master bus instead of silencing it', () => {
    const { graph } = makeGraph();
    sync(graph, starter());
    const input = graph.getChannelBus('audition');
    expect(input).toBe(graph.getStrip('audition')!.input);
    expect(graph.getStrip('audition')!.destinationNode).toBe(graph.masterBus.input);
    expect(node(input).reaches(fakeOf(graph).destination)).toBe(true);
  });

  it('falls back to the master bus and reports it when a destination cannot be resolved', () => {
    const { graph } = makeGraph();
    const project = starter();
    const state: MixerState = {
      ...buildMixerState(project),
      sources: buildMixerState(project).sources.map((source) =>
        source.id === 'channel-kick' ? { ...source, mixerChannelId: 'mixer-ghost' } : source,
      ),
    };
    graph.syncMixer(state);
    expect(graph.getStrip('channel-kick')!.destinationNode).toBe(graph.masterBus.input);
    expect(graph.getRoutingWarnings().join(' ')).toMatch(/mixer-ghost/);
    // Warnings are deduplicated across repeated syncs.
    graph.syncMixer(state);
    expect(graph.getRoutingWarnings()).toHaveLength(1);
  });
});

describe('mixer graph diffing', () => {
  it('changes one fader with one smoothed parameter write and no node work', () => {
    const { graph, fake } = makeGraph();
    sync(graph, starter());
    const before = graph.getMixerStats();
    const nodeCount = fake.nodeCount;

    sync(graph, edit(starter(), { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -6 }));
    const after = graph.getMixerStats();

    expect(after.syncs - before.syncs).toBe(1);
    expect(after.paramUpdates - before.paramUpdates).toBe(1);
    expect(after.busesCreated - before.busesCreated).toBe(0);
    expect(after.stripsCreated - before.stripsCreated).toBe(0);
    expect(after.routeChanges - before.routeChanges).toBe(0);
    expect(fake.nodeCount).toBe(nodeCount);

    const calls = gain(graph.getBus('mixer-insert-1')!.volume).gain.calls;
    expect(calls.at(-1)).toMatchObject({ method: 'setTargetAtTime', value: expect.closeTo(0.5012, 3) });
  });

  it('does nothing at all for an identical mixer state', () => {
    const { graph } = makeGraph();
    sync(graph, starter());
    const before = graph.getMixerStats();
    sync(graph, starter());
    const after = graph.getMixerStats();
    expect(after.syncs - before.syncs).toBe(1);
    expect(after.paramUpdates).toBe(before.paramUpdates);
    expect(after.routeChanges).toBe(before.routeChanges);
    expect(after.busesCreated).toBe(before.busesCreated);
    expect(after.busesDisposed).toBe(before.busesDisposed);
    expect(after.stripsCreated).toBe(before.stripsCreated);
  });

  it('re-routes a single connection when a channel output changes, without touching the faders', () => {
    const { graph } = makeGraph();
    sync(graph, starter());
    const before = graph.getMixerStats();

    sync(graph, edit(starter(), { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' }));
    const after = graph.getMixerStats();

    expect(after.routeChanges - before.routeChanges).toBe(1);
    expect(after.paramUpdates - before.paramUpdates).toBe(0);
    expect(after.busesCreated - before.busesCreated).toBe(0);
    const bus1 = graph.getBus('mixer-insert-1')!;
    // Exactly one, re-targeted connection: insert-1 now feeds insert-2, not the master directly.
    expect(node(bus1.tail).connectionCount).toBe(1);
    expect(bus1.destinationNode).toBe(graph.getBus('mixer-insert-2')!.input);
    expect(bus1.destinationNode).not.toBe(graph.masterBus.input);
    expect(node(bus1.tail).reaches(node(graph.getBus('mixer-insert-2')!.input))).toBe(true);
  });

  it('gates muted and soloed-out channels with a smooth ramp, never a disconnect', () => {
    const { graph } = makeGraph();
    sync(graph, starter());
    sync(graph, edit(starter(), { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-1', muted: true }));
    const mutedBus = graph.getBus('mixer-insert-1')!;
    expect(mutedBus.volume.gain.value).toBe(0);
    expect(gain(mutedBus.volume).gain.calls.at(-1)).toMatchObject({ method: 'setTargetAtTime', value: 0 });
    // The muted bus is still wired through the master: muting gates the gain, not the path.
    expect(node(mutedBus.tail).reaches(node(graph.masterBus.input))).toBe(true);

    const soloed = edit(starter(), { type: 'mixer.channel.solo.set', channelId: 'mixer-insert-2', solo: true });
    sync(graph, soloed);
    expect(graph.getBus('mixer-insert-2')!.volume.gain.value).toBeCloseTo(1, 6);
    for (const id of ['mixer-insert-1', 'mixer-insert-3', 'mixer-insert-4']) {
      expect(graph.getBus(id)!.volume.gain.value).toBe(0);
      expect(node(graph.getBus(id)!.tail).reaches(node(graph.masterBus.input))).toBe(true);
    }
    // The master bus keeps its own fader and is never gated by an insert solo.
    expect(graph.masterBus.volume.gain.value).toBeGreaterThan(0);
  });

  it('mutes everything when the master bus is muted, and restores it without a rebuild', () => {
    const { graph } = makeGraph();
    sync(graph, starter());
    const before = graph.getMixerStats();
    const master = {
      ...starter(),
      mixerChannels: starter().mixerChannels.map((channel) => (channel.role === 'master' ? { ...channel, muted: true } : channel)),
    };
    sync(graph, master);
    expect(graph.masterBus.volume.gain.value).toBe(0);
    // Insert faders are untouched by a master mute.
    expect(graph.getBus('mixer-insert-1')!.volume.gain.value).toBeCloseTo(1, 6);
    expect(graph.getMixerStats().busesCreated - before.busesCreated).toBe(0);
  });

  it('creates exactly one bus per new channel and disposes removed ones, repointing their feeders', () => {
    const { graph } = makeGraph();
    let project = starter();
    project = edit(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' });
    sync(graph, project);
    expect(graph.getBusIds().sort()).toEqual(['mixer-insert-1', 'mixer-insert-2', 'mixer-insert-3', 'mixer-insert-4']);

    // Remove the bus that insert-1 feeds: insert-1 must move onto the removed bus's own destination.
    project = edit(project, { type: 'mixer.channel.remove', channelId: 'mixer-insert-2' });
    sync(graph, project);
    expect(graph.getBusIds().sort()).toEqual(['mixer-insert-1', 'mixer-insert-3', 'mixer-insert-4']);
    expect(graph.getBus('mixer-insert-2')).toBeUndefined();
    expect(node(graph.getBus('mixer-insert-1')!.tail).reaches(node(graph.masterBus.input))).toBe(true);
    expect(graph.getMeterChannelIds()).not.toContain('mixer-insert-2');
    expect(graph.getMeterChannelIds()).toContain('mixer-insert-1');
  });
});

describe('mixer graph panning and metering', () => {
  it('uses a StereoPannerNode when the context provides one', () => {
    const { graph, fake } = makeGraph();
    sync(graph, starter());
    expect(fake.stereoPanners.length).toBeGreaterThan(0);
    expect(fake.mergers).toHaveLength(0);

    const before = graph.getMixerStats();
    sync(graph, edit(starter(), { type: 'mixer.channel.pan.set', channelId: 'mixer-insert-1', pan: -0.5 }));
    expect(graph.getMixerStats().paramUpdates - before.paramUpdates).toBe(1);
    expect(fake.stereoPanners.find((panner) => panner.pan.calls.at(-1)?.value === -0.5)).toBeDefined();
  });

  it('falls back to an equal-power gain pair when StereoPannerNode is unavailable', () => {
    const { context, fake } = createFakeAudioContext({ startRunning: true, supportsStereoPanner: false });
    const graph = new AudioGraph(context);
    sync(graph, starter());
    expect(fake.stereoPanners).toHaveLength(0);
    expect(fake.mergers.length).toBeGreaterThan(0);
    // The fallback still connects the channel signal to the destination.
    expect(node(graph.getBus('mixer-insert-1')!.input).reaches(fake.destination)).toBe(true);
  });

  it('attaches one analyser per bus and samples them on demand', () => {
    const { graph, fake } = makeGraph();
    sync(graph, starter());
    const busCount = graph.getBusIds().length + 1; // inserts plus the master bus
    expect(fake.analysers).toHaveLength(busCount);

    // Nothing is read until someone asks for a sample.
    expect(fake.analysers[0].readCount).toBe(0);
    fake.analysers.forEach((analyser) => (analyser.amplitude = 0.4));
    graph.sampleMeters(0.1);
    expect(fake.analysers.every((analyser) => analyser.readCount === 1)).toBe(true);

    const masterReading = graph.getMeterReading(MASTER);
    expect(masterReading?.peak).toBeCloseTo(0.4, 6);
    expect(graph.getMeterChannelIds()).toContain(MASTER);
    graph.clearMeterClip(MASTER);
    expect(graph.getMeterReading(MASTER)?.clipLatched).toBe(false);
  });

  it('omits analysers entirely when metering is disabled', () => {
    const { graph, fake } = makeGraph({ metering: false });
    sync(graph, starter());
    expect(fake.analysers).toHaveLength(0);
    expect(graph.getMeterChannelIds()).toHaveLength(0);
    // The signal path is unaffected by the missing analysers.
    expect(node(graph.getBus('mixer-insert-1')!.input).reaches(fake.destination)).toBe(true);
  });

  it('re-keys the master meter when the project master bus uses a different id', () => {
    const { graph } = makeGraph();
    sync(graph, starter());
    expect(graph.masterChannelId).toBe(MASTER);

    const base = buildMixerState(starter());
    const remap = (id: string | null): string | null => (id === MASTER ? 'custom-master' : id);
    graph.syncMixer({
      masterChannelId: 'custom-master',
      channels: base.channels.map((channel) => ({
        ...channel,
        id: channel.role === 'master' ? 'custom-master' : channel.id,
        outputId: remap(channel.outputId),
      })),
      sources: base.sources.map((source) => ({ ...source, mixerChannelId: remap(source.mixerChannelId) as string })),
    });
    expect(graph.masterChannelId).toBe('custom-master');
    expect(graph.getMeterChannelIds()).toContain('custom-master');
    expect(graph.getMeterChannelIds()).not.toContain(MASTER);
    expect(graph.getRoutingWarnings()).toHaveLength(0);
    // The inserts still reach the renamed master bus.
    expect(node(graph.getBus('mixer-insert-1')!.tail).reaches(node(graph.masterBus.input))).toBe(true);
  });
});

describe('mixer graph effect-slot interface', () => {
  it('ships a unity bypass between the chain input and output', () => {
    const { graph } = makeGraph();
    sync(graph, starter());
    const bus = graph.getBus('mixer-insert-1')!;
    expect(bus.effectInput).toBe(bus.input);
    expect(node(bus.effectInput).connections).toContain(bus.effectOutput);
    expect(bus.effectChain).toEqual([]);
    // Signal crosses the empty chain unchanged: input reaches the fader through effectOutput.
    expect(node(bus.input).reaches(node(bus.volume))).toBe(true);
  });

  it('inserts and removes a processor without touching the fader, pan, or routing', () => {
    const { graph, fake } = makeGraph();
    sync(graph, starter());
    const bus = graph.getBus('mixer-insert-1')!;
    const before = graph.getMixerStats();
    const processor = makeProcessor(fake, 'test-processor');

    expect(graph.setEffectChain('mixer-insert-1', [processor as unknown as AudioEffectProcessor])).toBe(true);
    expect(bus.effectChain).toEqual([processor]);
    expect(node(bus.effectInput).connections).toContain(processor.input);
    expect(processor.output.reaches(node(bus.effectOutput))).toBe(true);
    // The fader and pan were not automated by the insert, and routing was untouched.
    expect(graph.getMixerStats().paramUpdates).toBe(before.paramUpdates);
    expect(graph.getMixerStats().routeChanges).toBe(before.routeChanges);

    expect(graph.setEffectChain('mixer-insert-1', [processor as unknown as AudioEffectProcessor])).toBe(false);
    expect(graph.setEffectChain('mixer-insert-1', [])).toBe(true);
    expect(bus.effectChain).toEqual([]);
    expect(node(bus.effectInput).connections).toContain(bus.effectOutput);
    expect(processor.output.reaches(node(bus.effectOutput))).toBe(false);
    expect(graph.setEffectChain('ghost', [processor as unknown as AudioEffectProcessor])).toBe(false);
  });
});

describe('mixer graph construction and cleanup', () => {
  it('initializes every mixer-created node directly, with no automation ramps, so it starts click-free', () => {
    const { graph, fake } = makeGraph();
    sync(graph, starter());
    // Brand-new buses and strips are silent, so their first values are assigned, not ramped.
    for (const id of graph.getBusIds()) {
      expect(gain(graph.getBus(id)!.volume).gain.calls).toHaveLength(0);
      expect(gain(graph.getBus(id)!.input).gain.calls).toHaveLength(0);
    }
    for (const id of graph.getStripIds()) {
      expect(gain(graph.getStrip(id)!.send).gain.calls).toHaveLength(0);
      expect(gain(graph.getStrip(id)!.input).gain.calls).toHaveLength(0);
    }
    expect(fake.oscillators).toHaveLength(0);
    expect(graph.getNoiseBuffer().length).toBeGreaterThan(0);
    expect(graph.getNoiseBuffer()).toBe(graph.getNoiseBuffer());
  });

  it('detaches every node and forgets every attachment on dispose', () => {
    const { graph } = makeGraph();
    sync(graph, starter());
    const strip = graph.getStrip('channel-kick')!;
    const bus = graph.getBus('mixer-insert-1')!;

    graph.dispose();
    expect(graph.isDisposed).toBe(true);
    expect(graph.getStripIds()).toHaveLength(0);
    expect(graph.getBusIds()).toHaveLength(0);
    expect(graph.getMeterChannelIds()).toHaveLength(0);
    expect(strip.isDisposed).toBe(true);
    expect(bus.isDisposed).toBe(true);
    expect(node(bus.tail).connectionCount).toBe(0);
    expect(node(strip.send).connectionCount).toBe(0);
    expect(node(graph.limiter).connections).toHaveLength(0);
  });

  it('treats a sync after dispose as a no-op', () => {
    const { graph } = makeGraph();
    sync(graph, starter());
    graph.dispose();
    const stats = graph.getMixerStats();
    graph.syncMixer(buildMixerState(starter()));
    expect(graph.getMixerStats().syncs).toBe(stats.syncs);
  });

  it('reuses the graph when the engine attaches a pending mixer state before playback', () => {
    // Covered end-to-end in mixerPlayback.test.ts; here we assert the API tolerates the ordering.
    const { graph } = makeGraph();
    sync(graph, starter());
    sync(graph, edit(starter(), { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -12 }));
    expect(graph.getBus('mixer-insert-1')!.volume.gain.value).toBeCloseTo(0.2512, 3);
  });
});

/** The fake context a graph was built on. */
function fakeOf(graph: AudioGraph): FakeAudioContext {
  return graph.context as unknown as FakeAudioContext;
}
