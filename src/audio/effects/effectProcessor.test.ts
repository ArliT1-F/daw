import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAudioContext, type FakeAudioContext, type FakeAudioNode } from '../__fixtures__/fakeAudioContext';

const links = (value: AudioNode): FakeAudioNode => value as unknown as FakeAudioNode;
import { defaultEffectParams, type EffectType } from '../../core/effects/effectDefinitions';
import { createEffectProcessor, resolveEffectParams, type EffectProcessor } from './effectProcessor';
import { EFFECT_DISCONNECT_DELAY_MS, REVERB_IR_DEBOUNCE_MS } from './types';

let fake: FakeAudioContext;
let context: AudioContext;

beforeEach(() => {
  vi.useFakeTimers();
  const bundle = createFakeAudioContext();
  fake = bundle.fake;
  context = bundle.context;
});

afterEach(() => {
  vi.useRealTimers();
});

function build(type: EffectType, enabled = true, overrides: Record<string, number> = {}): EffectProcessor {
  return createEffectProcessor(context, {
    id: `fx-${type}`,
    type,
    enabled,
    params: { ...defaultEffectParams(type), ...overrides },
  });
}

describe('effect parameter validation', () => {
  it('fills missing keys from defaults and accepts a complete record', () => {
    expect(resolveEffectParams('delay', {})).toEqual(defaultEffectParams('delay'));
  });

  it('rejects out-of-range, non-finite, and unknown parameters with a message', () => {
    expect(() => resolveEffectParams('delay', { feedback: 2 })).toThrow(/between 0 and 0.95/);
    expect(() => resolveEffectParams('delay', { timeMs: Number.NaN })).toThrow(/finite number/);
    expect(() => resolveEffectParams('delay', { rate: 1 })).toThrow(/not a Delay parameter/);
  });

  it('refuses to build a processor from invalid parameters', () => {
    expect(() => build('compressor', true, { ratio: 0.5 })).toThrow(/between 1 and 20/);
  });
});

describe('effect processor gating', () => {
  it('builds engaged or bypassed with the path set to match', () => {
    const on = build('delay', true);
    expect(links(on.input).connectionCount).toBe(2);
    expect(on.enabled).toBe(true);
    const off = build('delay', false);
    expect(links(off.input).connectionCount).toBe(1);
    expect(off.enabled).toBe(false);
  });

  it('disconnects the processing path only after the bypass ramp has settled', () => {
    const processor = build('reverb', true);
    expect(links(processor.input).connectionCount).toBe(2);

    expect(processor.setEnabled(false, context.currentTime)).toBe(1);
    expect(links(processor.input).connectionCount).toBe(2);
    vi.advanceTimersByTime(EFFECT_DISCONNECT_DELAY_MS + 1);
    expect(links(processor.input).connectionCount).toBe(1);
  });

  it('re-engages the path immediately when re-enabled before the disconnect fires', () => {
    const processor = build('delay', true);
    processor.setEnabled(false, 0);
    processor.setEnabled(true, 0.01);
    vi.advanceTimersByTime(EFFECT_DISCONNECT_DELAY_MS + 1);
    expect(links(processor.input).connectionCount).toBe(2);
  });

  it('ramps dry and wet gains to their new targets at the requested time', () => {
    const processor = build('delay', true);
    const callsBefore = fake.gains.map((node) => node.gain.calls.length);
    processor.setEnabled(false, 1);
    // Only the dry and wet gains are automated by a gate change; both move, and both start at time 1.
    const moved = fake.gains.filter((_, index) => fake.gains[index].gain.calls.length > callsBefore[index]);
    expect(moved).toHaveLength(2);
    for (const node of moved) {
      const call = node.gain.calls[node.gain.calls.length - 1];
      expect(call.method).toBe('setTargetAtTime');
      expect(call.time).toBe(1);
    }
    expect(moved.map((node) => node.gain.value).sort()).toEqual([0, 1]);
  });

  it('ignores a repeated enable or disable', () => {
    const processor = build('eq3', true);
    expect(processor.setEnabled(true, 0)).toBe(0);
  });
});

describe('effect parameter updates', () => {
  it('applies changed values in place without creating nodes', () => {
    const processor = build('delay', true);
    const nodes = fake.nodeCount;
    const writes = processor.update({ timeMs: 250 }, 0);
    expect(writes).toBe(1);
    expect(processor.params.timeMs).toBe(250);
    expect(fake.nodeCount).toBe(nodes);
  });

  it('does nothing for an unchanged value', () => {
    const processor = build('delay', true);
    expect(processor.update({ timeMs: defaultEffectParams('delay').timeMs }, 0)).toBe(0);
  });

  it('rejects an out-of-range update without changing the applied value', () => {
    const processor = build('delay', true);
    expect(() => processor.update({ feedback: 3 }, 0)).toThrow();
    expect(processor.params.feedback).toBe(defaultEffectParams('delay').feedback);
  });

  it('debounces reverb decay changes into one impulse rebuild', () => {
    const processor = build('reverb', true);
    const convolversBefore = fake.convolvers.length;
    processor.update({ decaySeconds: 2 }, 0);
    processor.update({ decaySeconds: 2.5 }, 0);
    processor.update({ decaySeconds: 3 }, 0);
    expect(fake.convolvers.length).toBe(convolversBefore);
    vi.advanceTimersByTime(REVERB_IR_DEBOUNCE_MS + 1);
    expect(fake.convolvers.length).toBe(convolversBefore + 1);
  });
});

describe('effect processor lifecycle', () => {
  it('builds a native node chain for every effect type', () => {
    const types: EffectType[] = ['eq3', 'reverb', 'delay', 'compressor', 'limiter'];
    for (const type of types) {
      const before = fake.nodeCount;
      build(type, true);
      expect(fake.nodeCount, type).toBeGreaterThan(before);
    }
  });

  it('removes its connections on dispose and is idempotent', () => {
    const processor = build('reverb', true);
    processor.output.connect(fake.destination as unknown as AudioNode);
    processor.dispose();
    expect(links(processor.input).connectionCount).toBe(0);
    expect(links(processor.output).connectionCount).toBe(0);
    expect(links(processor.output).reaches(fake.destination)).toBe(false);
    expect(() => processor.dispose()).not.toThrow();
    expect(processor.update({ mix: 0.5 }, 0)).toBe(0);
    expect(processor.setEnabled(false, 0)).toBe(0);
  });

  it('cancels a pending idle disconnect when disposed', () => {
    const processor = build('delay', true);
    processor.setEnabled(false, 0);
    processor.dispose();
    // The timer must not run against a disposed processor.
    expect(() => vi.advanceTimersByTime(EFFECT_DISCONNECT_DELAY_MS + 1)).not.toThrow();
  });
});
