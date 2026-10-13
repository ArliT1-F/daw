import { describe, expect, it } from 'vitest';
import { applyProjectCommand, type ProjectCommand } from './commands';
import { createInitialProject, MASTER_MIXER_CHANNEL_ID, MIXER_EFFECT_SLOT_COUNT, type Project } from '../project/model';
import { defaultEffectParams } from '../effects/effectDefinitions';

const INSERT = 'mixer-insert-1';
const MASTER = MASTER_MIXER_CHANNEL_ID;

function apply(project: Project, command: ProjectCommand): Project {
  return applyProjectCommand(project, command);
}

function effectIds(project: Project, channelId = INSERT): string[] {
  return project.mixerChannels.find((channel) => channel.id === channelId)!.effects.map((slot) => slot.id);
}

function add(project: Project, effectId: string, effectType: 'eq3' | 'delay' | 'reverb' | 'compressor' | 'limiter' = 'eq3', channelId = INSERT, index?: number): Project {
  return apply(project, { type: 'mixer.effect.add', channelId, effectId, effectType, ...(index === undefined ? {} : { index }) });
}

describe('mixer.effect.add', () => {
  it('appends an effect with its defaults, enabled', () => {
    const project = add(createInitialProject(), 'fx-1', 'delay');
    const slot = project.mixerChannels.find((channel) => channel.id === INSERT)!.effects[0];
    expect(slot).toEqual({ id: 'fx-1', type: 'delay', enabled: true, params: defaultEffectParams('delay') });
  });

  it('inserts at a requested position', () => {
    let project = add(createInitialProject(), 'fx-a');
    project = add(project, 'fx-b');
    project = add(project, 'fx-c', 'eq3', INSERT, 1);
    expect(effectIds(project)).toEqual(['fx-a', 'fx-c', 'fx-b']);
  });

  it('rejects a duplicate id, a position outside the chain, and a full chain', () => {
    let project = add(createInitialProject(), 'fx-1');
    expect(() => add(project, 'fx-1')).toThrow('unique within a channel');
    expect(() => add(project, 'fx-2', 'eq3', INSERT, 5)).toThrow('outside the chain');
    for (let index = project.mixerChannels.find((channel) => channel.id === INSERT)!.effects.length; index < MIXER_EFFECT_SLOT_COUNT; index += 1) {
      project = add(project, `fx-fill-${index}`);
    }
    expect(() => add(project, 'fx-overflow')).toThrow(`at most ${MIXER_EFFECT_SLOT_COUNT} effects`);
  });

  it('rejects the limiter on an insert channel, but allows it on master', () => {
    expect(() => add(createInitialProject(), 'fx-lim', 'limiter')).toThrow('can only be placed on the master bus');
    expect(effectIds(add(createInitialProject(), 'fx-lim', 'limiter', MASTER), MASTER)).toEqual(['fx-lim']);
  });

  it('rejects an unknown effect type and an empty id', () => {
    expect(() => add(createInitialProject(), 'fx-1', 'gain' as 'eq3')).toThrow('Unknown effect type');
    expect(() => add(createInitialProject(), '  ', 'eq3')).toThrow('needs an ID');
  });

  it('is a single undoable edit', () => {
    const before = createInitialProject();
    const after = add(before, 'fx-1');
    expect(after).not.toBe(before);
    expect(before.mixerChannels.find((channel) => channel.id === INSERT)!.effects).toEqual([]);
  });
});

describe('mixer.effect.remove, move, and enabled', () => {
  function chain(): Project {
    let project = add(createInitialProject(), 'fx-a', 'eq3');
    project = add(project, 'fx-b', 'delay');
    project = add(project, 'fx-c', 'reverb');
    return project;
  }

  it('removes one effect and keeps the others in order', () => {
    const project = apply(chain(), { type: 'mixer.effect.remove', channelId: INSERT, effectId: 'fx-b' });
    expect(effectIds(project)).toEqual(['fx-a', 'fx-c']);
  });

  it('moves an effect to a new position', () => {
    expect(effectIds(apply(chain(), { type: 'mixer.effect.move', channelId: INSERT, effectId: 'fx-c', toIndex: 0 }))).toEqual(['fx-c', 'fx-a', 'fx-b']);
    expect(effectIds(apply(chain(), { type: 'mixer.effect.move', channelId: INSERT, effectId: 'fx-a', toIndex: 2 }))).toEqual(['fx-b', 'fx-c', 'fx-a']);
  });

  it('does nothing when a move keeps the position', () => {
    const project = chain();
    expect(apply(project, { type: 'mixer.effect.move', channelId: INSERT, effectId: 'fx-b', toIndex: 1 })).toBe(project);
  });

  it('rejects a move outside the chain and an unknown effect', () => {
    expect(() => apply(chain(), { type: 'mixer.effect.move', channelId: INSERT, effectId: 'fx-a', toIndex: 3 })).toThrow('outside the chain');
    expect(() => apply(chain(), { type: 'mixer.effect.remove', channelId: INSERT, effectId: 'fx-missing' })).toThrow('is not on mixer channel');
  });

  it('bypasses and re-enables without changing the chain order or settings', () => {
    const bypassed = apply(chain(), { type: 'mixer.effect.enabled.set', channelId: INSERT, effectId: 'fx-b', enabled: false });
    const slot = bypassed.mixerChannels.find((channel) => channel.id === INSERT)!.effects[1];
    expect(slot).toMatchObject({ id: 'fx-b', enabled: false, params: defaultEffectParams('delay') });
    expect(effectIds(bypassed)).toEqual(['fx-a', 'fx-b', 'fx-c']);
    const restored = apply(bypassed, { type: 'mixer.effect.enabled.set', channelId: INSERT, effectId: 'fx-b', enabled: true });
    expect(restored.mixerChannels.find((channel) => channel.id === INSERT)!.effects[1].enabled).toBe(true);
  });
});

describe('mixer.effect.param.set', () => {
  it('sets one parameter and leaves the rest untouched', () => {
    const project = apply(add(createInitialProject(), 'fx-d', 'delay'), { type: 'mixer.effect.param.set', channelId: INSERT, effectId: 'fx-d', key: 'feedback', value: 0.6 });
    const params = project.mixerChannels.find((channel) => channel.id === INSERT)!.effects[0].params;
    expect(params).toEqual({ ...defaultEffectParams('delay'), feedback: 0.6 });
  });

  it('rejects an unknown key, an out-of-range value, and a NaN', () => {
    const base = add(createInitialProject(), 'fx-d', 'delay');
    expect(() => apply(base, { type: 'mixer.effect.param.set', channelId: INSERT, effectId: 'fx-d', key: 'cutoff', value: 0.5 })).toThrow('has no parameter "cutoff"');
    expect(() => apply(base, { type: 'mixer.effect.param.set', channelId: INSERT, effectId: 'fx-d', key: 'feedback', value: 2 })).toThrow('must be between 0 and 0.95');
    expect(() => apply(base, { type: 'mixer.effect.param.set', channelId: INSERT, effectId: 'fx-d', key: 'feedback', value: Number.NaN })).toThrow('must be between');
  });

  it('returns the same project when the value is already set', () => {
    const base = add(createInitialProject(), 'fx-d', 'delay');
    expect(apply(base, { type: 'mixer.effect.param.set', channelId: INSERT, effectId: 'fx-d', key: 'mix', value: defaultEffectParams('delay').mix })).toBe(base);
  });
});

describe('legacy mixer.channel.effect.set validation', () => {
  it('rejects an unknown type and an invalid parameter record', () => {
    const base = createInitialProject();
    expect(() => apply(base, { type: 'mixer.channel.effect.set', channelId: INSERT, slot: 0, effect: { id: 'fx', type: 'gain' as 'eq3', enabled: true, params: {} } })).toThrow();
    expect(() => apply(base, { type: 'mixer.channel.effect.set', channelId: INSERT, slot: 0, effect: { id: 'fx', type: 'delay', enabled: true, params: { time: 1 } } })).toThrow();
  });
});
