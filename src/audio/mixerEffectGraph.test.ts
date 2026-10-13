import { describe, expect, it } from 'vitest';
import { applyProjectCommand, type ProjectCommand } from '../core/commands';
import { defaultEffectParams } from '../core/effects/effectDefinitions';
import { buildMixerState, type MixerState } from '../core/mixer/mixerModel';
import { createInitialProject, MASTER_MIXER_CHANNEL_ID, type MixerEffectSlot, type Project } from '../core/project/model';
import { AudioGraph } from './AudioGraph';
import type { EffectProcessor } from './effects/effectProcessor';
import { createFakeAudioContext, type FakeAudioNode } from './__fixtures__/fakeAudioContext';

const MASTER = MASTER_MIXER_CHANNEL_ID;
const INSERT = 'mixer-insert-1';

const node = (value: AudioNode): FakeAudioNode => value as unknown as FakeAudioNode;
/** Connection checks read the double's bookkeeping; live nodes are typed as real Web Audio nodes. */
const links = (value: AudioNode): FakeAudioNode => value as unknown as FakeAudioNode;

function makeGraph() {
  const { context, fake } = createFakeAudioContext({ startRunning: true });
  const graph = new AudioGraph(context, { metering: false });
  return { graph, fake };
}

function edit(project: Project, command: ProjectCommand): Project {
  return applyProjectCommand(project, command);
}

function sync(graph: AudioGraph, project: Project): void {
  graph.syncMixer(buildMixerState(project), { canPruneStrips: true });
}

function processor(graph: AudioGraph, channelId: string, effectId: string): EffectProcessor {
  const live = graph.getEffectProcessor(channelId, effectId);
  if (!live) throw new Error(`no live processor for ${effectId}`);
  return live as EffectProcessor;
}

function withChain(project: Project, channelId: string, effects: Array<[string, 'eq3' | 'delay' | 'reverb' | 'compressor' | 'limiter']>): Project {
  let next = project;
  for (const [effectId, effectType] of effects) {
    next = edit(next, { type: 'mixer.effect.add', channelId, effectId, effectType });
  }
  return next;
}

describe('mixer effect graph: chain construction', () => {
  it('builds one processor per effect and connects them in signal order', () => {
    const { graph } = makeGraph();
    const project = withChain(createInitialProject(), INSERT, [['fx-eq', 'eq3'], ['fx-dly', 'delay']]);
    sync(graph, project);

    const eq = processor(graph, INSERT, 'fx-eq');
    const dly = processor(graph, INSERT, 'fx-dly');
    expect(graph.getMixerStats().effectsCreated).toBe(2);
    // Signal order: the first effect feeds the second, never the reverse.
    expect(node(eq.output as unknown as AudioNode).reaches(node(dly.input as unknown as AudioNode))).toBe(true);
    expect(node(dly.output as unknown as AudioNode).reaches(node(eq.input as unknown as AudioNode))).toBe(false);
    expect(graph.getEffectWarnings()).toEqual([]);
  });

  it('places master effects on the master bus, after the inserts and before the safety limiter', () => {
    const { graph, fake } = makeGraph();
    const project = withChain(createInitialProject(), MASTER, [['fx-lim', 'limiter']]);
    sync(graph, project);

    const limiter = processor(graph, MASTER, 'fx-lim');
    expect(graph.getMixerStats().effectsCreated).toBe(1);
    expect(node(graph.masterInput as unknown as AudioNode).reaches(node(limiter.input as unknown as AudioNode))).toBe(true);
    expect(node(limiter.output as unknown as AudioNode).reaches(node(graph.limiter as unknown as AudioNode))).toBe(true);
    expect(node(graph.masterInput as unknown as AudioNode).reaches(fake.destination)).toBe(true);
  });

  it('skips placeholder slots without building anything for them', () => {
    const { graph } = makeGraph();
    const project = createInitialProject();
    const placeholder: MixerEffectSlot = { id: 'fx-empty', type: null, enabled: false, params: {} };
    const state: MixerState = {
      ...buildMixerState(project),
      channels: buildMixerState(project).channels.map((channel) =>
        channel.id === INSERT ? { ...channel, effects: [placeholder] } : channel),
    };
    graph.syncMixer(state);
    expect(graph.getMixerStats().effectsCreated).toBe(0);
    expect(graph.getEffectWarnings()).toEqual([]);
  });
});

describe('mixer effect graph: edits', () => {
  it('a parameter edit reuses the live processor and creates no nodes', () => {
    const { graph, fake } = makeGraph();
    let project = withChain(createInitialProject(), INSERT, [['fx-dly', 'delay']]);
    sync(graph, project);
    const before = processor(graph, INSERT, 'fx-dly');
    const stats = { ...graph.getMixerStats() };
    const nodes = fake.nodeCount;

    project = edit(project, { type: 'mixer.effect.param.set', channelId: INSERT, effectId: 'fx-dly', key: 'timeMs', value: 500 });
    sync(graph, project);

    expect(processor(graph, INSERT, 'fx-dly')).toBe(before);
    expect(before.params.timeMs).toBe(500);
    expect(fake.nodeCount).toBe(nodes);
    expect(graph.getMixerStats().effectsCreated).toBe(stats.effectsCreated);
    expect(graph.getMixerStats().effectsDisposed).toBe(stats.effectsDisposed);
    expect(graph.getMixerStats().effectParamUpdates).toBeGreaterThan(stats.effectParamUpdates);
  });

  it('bypass is a gate change: the processor and its nodes stay', () => {
    const { graph, fake } = makeGraph();
    let project = withChain(createInitialProject(), INSERT, [['fx-cmp', 'compressor']]);
    sync(graph, project);
    const live = processor(graph, INSERT, 'fx-cmp');
    const nodes = fake.nodeCount;
    project = edit(project, { type: 'mixer.effect.enabled.set', channelId: INSERT, effectId: 'fx-cmp', enabled: false });
    sync(graph, project);
    expect(processor(graph, INSERT, 'fx-cmp')).toBe(live);
    expect(live.enabled).toBe(false);
    expect(fake.nodeCount).toBe(nodes);
  });

  it('an unchanged state does no work at all', () => {
    const { graph } = makeGraph();
    const project = withChain(createInitialProject(), INSERT, [['fx-eq', 'eq3']]);
    sync(graph, project);
    const first = { ...graph.getMixerStats() };
    sync(graph, project);
    const second = graph.getMixerStats();
    expect(second.effectsCreated).toBe(first.effectsCreated);
    expect(second.effectRewires).toBe(first.effectRewires);
    expect(second.effectParamUpdates).toBe(first.effectParamUpdates);
  });

  it('reordering rewires the chain but keeps every processor', () => {
    const { graph } = makeGraph();
    let project = withChain(createInitialProject(), INSERT, [['fx-eq', 'eq3'], ['fx-dly', 'delay']]);
    sync(graph, project);
    const eq = processor(graph, INSERT, 'fx-eq');
    const dly = processor(graph, INSERT, 'fx-dly');
    const created = graph.getMixerStats().effectsCreated;
    const rewires = graph.getMixerStats().effectRewires;

    project = edit(project, { type: 'mixer.effect.move', channelId: INSERT, effectId: 'fx-dly', toIndex: 0 });
    sync(graph, project);

    expect(processor(graph, INSERT, 'fx-eq')).toBe(eq);
    expect(processor(graph, INSERT, 'fx-dly')).toBe(dly);
    expect(graph.getMixerStats().effectsCreated).toBe(created);
    expect(graph.getMixerStats().effectRewires).toBe(rewires + 1);
    expect(node(dly.output as unknown as AudioNode).reaches(node(eq.input as unknown as AudioNode))).toBe(true);
    expect(node(eq.output as unknown as AudioNode).reaches(node(dly.input as unknown as AudioNode))).toBe(false);
  });

  it('removing one effect disposes only that processor and leaves no connections behind', () => {
    const { graph } = makeGraph();
    let project = withChain(createInitialProject(), INSERT, [['fx-eq', 'eq3'], ['fx-dly', 'delay']]);
    sync(graph, project);
    const eq = processor(graph, INSERT, 'fx-eq');
    const dly = processor(graph, INSERT, 'fx-dly');

    project = edit(project, { type: 'mixer.effect.remove', channelId: INSERT, effectId: 'fx-eq' });
    sync(graph, project);

    expect(graph.getEffectProcessor(INSERT, 'fx-eq')).toBeUndefined();
    expect(processor(graph, INSERT, 'fx-dly')).toBe(dly);
    expect(graph.getMixerStats().effectsDisposed).toBe(1);
    expect(links(eq.input).connectionCount).toBe(0);
    expect(links(eq.output).connectionCount).toBe(0);
    expect(node(graph.getBus(INSERT)!.input as unknown as AudioNode).reaches(node(eq.input as unknown as AudioNode))).toBe(false);
  });

  it('changing an effect type under one slot builds a fresh processor and disposes the old one', () => {
    const { graph } = makeGraph();
    let project = withChain(createInitialProject(), INSERT, [['fx-x', 'eq3']]);
    sync(graph, project);
    const old = processor(graph, INSERT, 'fx-x');

    project = edit(project, {
      type: 'mixer.channel.effect.set',
      channelId: INSERT,
      slot: 0,
      effect: { id: 'fx-x', type: 'delay', enabled: true, params: { timeMs: 200, feedback: 0.2, toneHz: 4000, mix: 0.3 } },
    });
    sync(graph, project);

    const replacement = processor(graph, INSERT, 'fx-x');
    expect(replacement).not.toBe(old);
    expect(replacement.type).toBe('delay');
    expect(links(old.input).connectionCount).toBe(0);
    expect(graph.getMixerStats().effectsCreated).toBe(2);
    expect(graph.getMixerStats().effectsDisposed).toBe(1);
  });

  it('removing a channel disposes every effect on it', () => {
    const { graph } = makeGraph();
    let project = withChain(createInitialProject(), INSERT, [['fx-eq', 'eq3'], ['fx-dly', 'delay']]);
    sync(graph, project);
    const eq = processor(graph, INSERT, 'fx-eq');
    project = edit(project, { type: 'mixer.channel.remove', channelId: INSERT });
    sync(graph, project);
    expect(graph.getBus(INSERT)).toBeUndefined();
    expect(graph.getMixerStats().effectsDisposed).toBe(2);
    expect(links(eq.input).connectionCount).toBe(0);
  });
});

describe('mixer effect graph: failures are reported, not hidden', () => {
  function brokenState(project: Project): MixerState {
    const base = buildMixerState(project);
    return {
      ...base,
      channels: base.channels.map((channel) =>
        channel.id === INSERT
          ? { ...channel, effects: [{ id: 'fx-bad', type: 'delay', enabled: true, params: { ...defaultEffectParams('delay'), feedback: 5 } }] }
          : channel),
    };
  }

  it('records a warning for an effect that cannot be built, and the rest of the chain still runs', () => {
    const { graph } = makeGraph();
    const project = withChain(createInitialProject(), INSERT, [['fx-ok', 'eq3']]);
    const state = brokenState(project);
    const withOk: MixerState = {
      ...state,
      channels: state.channels.map((channel) =>
        channel.id === INSERT ? { ...channel, effects: [...channel.effects, { id: 'fx-ok', type: 'eq3', enabled: true, params: { lowFreqHz: 200, lowGainDb: 0, midFreqHz: 1000, midGainDb: 0, midQ: 1, highFreqHz: 6000, highGainDb: 0 } }] } : channel),
    };
    graph.syncMixer(withOk);
    expect(graph.getEffectWarnings()).toHaveLength(1);
    expect(graph.getEffectWarnings()[0]).toMatch(/fx-bad.*could not be created/);
    expect(graph.getEffectProcessor(INSERT, 'fx-bad')).toBeUndefined();
    expect(graph.getEffectProcessor(INSERT, 'fx-ok')).toBeDefined();
  });

  it('dedupes repeated warnings and clears them once the chain is valid again', () => {
    const { graph } = makeGraph();
    const broken = brokenState(createInitialProject());
    graph.syncMixer(broken);
    graph.syncMixer(broken);
    expect(graph.getEffectWarnings()).toHaveLength(1);
    graph.syncMixer(buildMixerState(createInitialProject()));
    expect(graph.getEffectWarnings()).toEqual([]);
  });

  it('releases every effect processor on graph disposal', () => {
    const { graph } = makeGraph();
    const project = withChain(withChain(createInitialProject(), INSERT, [['fx-eq', 'eq3']]), MASTER, [['fx-lim', 'limiter']]);
    sync(graph, project);
    const eq = processor(graph, INSERT, 'fx-eq');
    const lim = processor(graph, MASTER, 'fx-lim');
    graph.dispose();
    expect(links(eq.input).connectionCount).toBe(0);
    expect(links(lim.input).connectionCount).toBe(0);
    expect(graph.getEffectWarnings()).toEqual([]);
  });
});
