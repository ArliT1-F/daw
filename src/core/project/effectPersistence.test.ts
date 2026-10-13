import { describe, expect, it } from 'vitest';
import { defaultEffectParams } from '../effects/effectDefinitions';
import { applyProjectCommand } from '../commands';
import { createInitialProject, MASTER_MIXER_CHANNEL_ID, type Project } from './model';
import { deserializeProject, serializeProject } from './serialization';

const INSERT = 'mixer-insert-1';

function withEffects(): Project {
  let project = createInitialProject();
  project = applyProjectCommand(project, { type: 'mixer.effect.add', channelId: INSERT, effectId: 'fx-eq', effectType: 'eq3' });
  project = applyProjectCommand(project, { type: 'mixer.effect.param.set', channelId: INSERT, effectId: 'fx-eq', key: 'midGainDb', value: 4.5 });
  project = applyProjectCommand(project, { type: 'mixer.effect.enabled.set', channelId: INSERT, effectId: 'fx-eq', enabled: false });
  project = applyProjectCommand(project, { type: 'mixer.effect.add', channelId: INSERT, effectId: 'fx-dly', effectType: 'delay' });
  project = applyProjectCommand(project, { type: 'mixer.effect.add', channelId: MASTER_MIXER_CHANNEL_ID, effectId: 'fx-lim', effectType: 'limiter' });
  return project;
}

function documentOf(project: Project): Record<string, unknown> {
  return JSON.parse(serializeProject(project)) as Record<string, unknown>;
}

describe('effect chains in the project document', () => {
  it('round-trips effect types, order, bypass state, and settings', () => {
    const project = withEffects();
    const reloaded = deserializeProject(serializeProject(project));
    expect(reloaded.mixerChannels).toEqual(project.mixerChannels);
    const effects = reloaded.mixerChannels.find((channel) => channel.id === INSERT)!.effects;
    expect(effects.map((slot) => slot.type)).toEqual(['eq3', 'delay']);
    expect(effects[0]).toMatchObject({ id: 'fx-eq', enabled: false });
    expect(effects[0].params).toMatchObject({ midGainDb: 4.5 });
    expect(reloaded.mixerChannels.find((channel) => channel.id === MASTER_MIXER_CHANNEL_ID)!.effects[0]).toMatchObject({ type: 'limiter' });
  });

  it('fills missing parameters from defaults on load', () => {
    const document = documentOf(withEffects());
    const channels = document.mixerChannels as Array<{ id: string; effects: Array<{ params: Record<string, number> }> }>;
    const insert = channels.find((channel) => channel.id === INSERT)!;
    insert.effects[1].params = { timeMs: 250 };
    const reloaded = deserializeProject(JSON.stringify(document));
    const delay = reloaded.mixerChannels.find((channel) => channel.id === INSERT)!.effects[1];
    expect(delay.params).toEqual({ ...defaultEffectParams('delay'), timeMs: 250 });
  });

  it('rejects a document whose effect type is unknown', () => {
    const document = documentOf(withEffects());
    const channels = document.mixerChannels as Array<{ id: string; effects: Array<{ type: string }> }>;
    channels.find((channel) => channel.id === INSERT)!.effects[0].type = 'gain';
    expect(() => deserializeProject(JSON.stringify(document))).toThrow();
  });

  it('rejects a document with an out-of-range effect parameter', () => {
    const document = documentOf(withEffects());
    const channels = document.mixerChannels as Array<{ id: string; effects: Array<{ params: Record<string, number> }> }>;
    channels.find((channel) => channel.id === INSERT)!.effects[1].params.feedback = 3;
    expect(() => deserializeProject(JSON.stringify(document))).toThrow(/between 0 and 0.95/);
  });

  it('rejects a limiter placed on an insert channel', () => {
    const document = documentOf(withEffects());
    const channels = document.mixerChannels as Array<{ id: string; effects: Array<{ id: string; type: string; enabled: boolean; params: Record<string, number> }> }>;
    channels.find((channel) => channel.id === INSERT)!.effects[0] = { id: 'fx-bad', type: 'limiter', enabled: true, params: defaultEffectParams('limiter') };
    expect(() => deserializeProject(JSON.stringify(document))).toThrow(/only be placed on the master bus/);
  });

  it('keeps an emptied chain empty after a round trip', () => {
    let project = withEffects();
    project = applyProjectCommand(project, { type: 'mixer.channel.effect.set', channelId: INSERT, slot: 0, effect: null });
    project = applyProjectCommand(project, { type: 'mixer.channel.effect.set', channelId: INSERT, slot: 1, effect: null });
    const reloaded = deserializeProject(serializeProject(project));
    expect(reloaded.mixerChannels.find((channel) => channel.id === INSERT)!.effects).toEqual([]);
  });
});
