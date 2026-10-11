import { describe, expect, it } from 'vitest';
import {
  EFFECT_DEFINITIONS,
  EFFECT_TYPES,
  defaultEffectParams,
  effectValueToNormalized,
  fillEffectParams,
  formatEffectValue,
  getEffectParamSpec,
  listEffectTypesFor,
  normalizedToEffectValue,
  quantizeEffectValue,
  validateEffectParams,
  type EffectType,
} from './effectDefinitions';

describe('effect registry', () => {
  it('lists the five Phase 8 effects', () => {
    expect(EFFECT_TYPES).toEqual(['eq3', 'reverb', 'delay', 'compressor', 'limiter']);
  });

  it('gives every type defaults that validate', () => {
    for (const type of EFFECT_TYPES) {
      expect(validateEffectParams(type, defaultEffectParams(type)), type).toBeNull();
    }
  });

  it('keeps the limiter off insert channels', () => {
    expect(EFFECT_DEFINITIONS.limiter.masterOnly).toBe(true);
    expect(listEffectTypesFor('insert')).not.toContain('limiter');
    expect(listEffectTypesFor('master')).toEqual(EFFECT_TYPES);
  });

  it('defaults leave the level unchanged for the compressor and the EQ', () => {
    expect(defaultEffectParams('eq3')).toMatchObject({ lowGainDb: 0, midGainDb: 0, highGainDb: 0 });
    expect(defaultEffectParams('compressor')).toMatchObject({ makeupDb: 0 });
  });

  it('only uses log scales with a positive minimum', () => {
    for (const type of EFFECT_TYPES) {
      for (const spec of EFFECT_DEFINITIONS[type].params) {
        if (spec.scale === 'log') expect(spec.min, `${type}.${spec.key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('effect parameter validation', () => {
  it('reports a missing parameter', () => {
    const params: Record<string, number> = { ...defaultEffectParams('delay') };
    delete params.feedback;
    expect(validateEffectParams('delay', params)).toMatch(/"feedback" is missing/);
  });

  it('reports an unknown key', () => {
    expect(validateEffectParams('delay', { ...defaultEffectParams('delay'), cutoff: 0.5 })).toMatch(/not a Delay parameter/);
  });

  it('rejects NaN, infinity, and out-of-range values with the parameter label', () => {
    expect(validateEffectParams('reverb', { ...defaultEffectParams('reverb'), mix: Number.POSITIVE_INFINITY })).toMatch(/must be a finite number/);
    expect(validateEffectParams('reverb', { ...defaultEffectParams('reverb'), mix: 1.5 })).toMatch(/Wet mix must be between 0 and 1/);
  });

  it('fills only missing keys', () => {
    expect(fillEffectParams('delay', { feedback: 0.5 })).toMatchObject({ feedback: 0.5, timeMs: defaultEffectParams('delay').timeMs });
  });
});

describe('effect parameter mapping', () => {
  it('round-trips a log-scaled value through the slider position', () => {
    const spec = getEffectParamSpec('eq3', 'midFreqHz')!;
    for (const value of [200, 1000, 4000, 8000]) {
      const back = normalizedToEffectValue(spec, effectValueToNormalized(spec, value));
      expect(back).toBeCloseTo(value, 6);
    }
  });

  it('maps the slider ends to the range ends and clamps out-of-range positions', () => {
    const spec = getEffectParamSpec('delay', 'timeMs')!;
    expect(normalizedToEffectValue(spec, 0)).toBe(spec.min);
    expect(normalizedToEffectValue(spec, 1)).toBe(spec.max);
    expect(normalizedToEffectValue(spec, -3)).toBe(spec.min);
    expect(normalizedToEffectValue(spec, Number.NaN)).toBe(spec.min);
  });

  it('quantises to the step and removes float noise', () => {
    const spec = getEffectParamSpec('delay', 'feedback')!;
    expect(quantizeEffectValue(spec, 0.30000000004)).toBe(0.3);
    expect(quantizeEffectValue(spec, 2)).toBe(spec.max);
  });

  it('formats values with units', () => {
    expect(formatEffectValue(getEffectParamSpec('eq3', 'midFreqHz')!, 1000)).toBe('1.00 kHz');
    expect(formatEffectValue(getEffectParamSpec('eq3', 'midGainDb')!, 0)).toBe('0.0 dB');
    expect(formatEffectValue(getEffectParamSpec('eq3', 'midGainDb')!, 3.2)).toBe('+3.2 dB');
  });
});

describe('effect type guard', () => {
  it('accepts only registered types', () => {
    const candidates: unknown[] = ['eq3', 'gain', 'lowpass', '', null, 7];
    const accepted = candidates.filter((value) => EFFECT_TYPES.includes(value as EffectType));
    expect(accepted).toEqual(['eq3']);
  });
});
