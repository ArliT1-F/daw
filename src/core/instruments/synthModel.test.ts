import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNTH_PARAMS,
  SYNTH_PARAM_RANGES,
  SYNTH_PRESET_FORMAT,
  SYNTH_PRESET_VERSION,
  SYNTH_PRESETS,
  SYNTH_STATE_VERSION,
  SynthValidationError,
  assertValidSynthParams,
  clampSynthParam,
  createChannelSynth,
  parseSynthPreset,
  serializeSynthPreset,
  validateSynthParams,
} from './synthModel';

function presetFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: SYNTH_PRESET_FORMAT, version: 1, name: 'Test', params: DEFAULT_SYNTH_PARAMS, ...overrides });
}

describe('built-in presets', () => {
  it('ships a small set of presets with unique stable ids and valid parameters', () => {
    expect(SYNTH_PRESETS.length).toBeGreaterThanOrEqual(3);
    const ids = SYNTH_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of SYNTH_PRESETS) {
      expect(preset.name.trim()).not.toBe('');
      expect(() => assertValidSynthParams(preset.params)).not.toThrow();
    }
  });

  it('a new channel starts with the default patch, named after it', () => {
    const synth = createChannelSynth();
    expect(synth.version).toBe(SYNTH_STATE_VERSION);
    expect(synth.presetName).toBe('Detuned Saw');
    expect(synth.params).toEqual(DEFAULT_SYNTH_PARAMS);
    expect(synth.params).not.toBe(DEFAULT_SYNTH_PARAMS);
  });
});

describe('preset file format', () => {
  it('serializes a stable, versioned document of plain parameters', () => {
    const file = JSON.parse(serializeSynthPreset('  Warm Lead ', DEFAULT_SYNTH_PARAMS)) as Record<string, unknown>;
    expect(file).toEqual({ format: 'gridline-synth-preset', version: 1, name: 'Warm Lead', params: DEFAULT_SYNTH_PARAMS });
    expect(SYNTH_PRESET_VERSION).toBe(1);
  });

  it('round-trips every built-in preset without changing a value', () => {
    for (const preset of SYNTH_PRESETS) {
      const parsed = parseSynthPreset(serializeSynthPreset(preset.name, preset.params));
      expect(parsed.name).toBe(preset.name);
      expect(parsed.params).toEqual(preset.params);
    }
  });

  it('stores no audio nodes or functions, only JSON', () => {
    const text = serializeSynthPreset('Plain', DEFAULT_SYNTH_PARAMS);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(JSON.parse(text))));
    expect(text).not.toMatch(/AudioNode|function|oscillator/i);
  });

  it('refuses to write an invalid preset', () => {
    expect(() => serializeSynthPreset('', DEFAULT_SYNTH_PARAMS)).toThrow(SynthValidationError);
    expect(() => serializeSynthPreset('x'.repeat(81), DEFAULT_SYNTH_PARAMS)).toThrow(SynthValidationError);
    expect(() => serializeSynthPreset('Bad', { ...DEFAULT_SYNTH_PARAMS, level: 2 })).toThrow(SynthValidationError);
  });
});

describe('preset parsing rejects bad files', () => {
  it('accepts a valid file', () => {
    expect(parseSynthPreset(presetFile({ name: '  Padded  ' }))).toEqual({ name: 'Padded', params: DEFAULT_SYNTH_PARAMS });
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseSynthPreset('{not json')).toThrow(/not valid JSON/);
  });

  it('rejects arrays, primitives and null', () => {
    for (const text of ['[]', '42', 'null', '"preset"']) {
      expect(() => parseSynthPreset(text)).toThrow(SynthValidationError);
    }
  });

  it('rejects files that are not Gridline synth presets', () => {
    expect(() => parseSynthPreset(presetFile({ format: 'gridline-sample-pack' }))).toThrow(/not a Gridline synth preset/);
  });

  it('rejects unknown format versions so a future file never loads half-understood', () => {
    expect(() => parseSynthPreset(presetFile({ version: 2 }))).toThrow(/Unsupported synth preset version: 2/);
    expect(() => parseSynthPreset(presetFile({ version: '1' }))).toThrow(SynthValidationError);
  });

  it('rejects empty or overlong names', () => {
    expect(() => parseSynthPreset(presetFile({ name: '   ' }))).toThrow(/between 1 and 80/);
    expect(() => parseSynthPreset(presetFile({ name: 'y'.repeat(81) }))).toThrow(/between 1 and 80/);
    expect(() => parseSynthPreset(presetFile({ name: 42 }))).toThrow(SynthValidationError);
  });

  it('rejects unknown parameters rather than ignoring typos', () => {
    expect(() => parseSynthPreset(presetFile({ params: { ...DEFAULT_SYNTH_PARAMS, cutof: 900 } }))).toThrow(/Unknown synth parameter "cutof"/);
  });

  it('rejects out-of-range and non-finite values', () => {
    expect(() => parseSynthPreset(presetFile({ params: { ...DEFAULT_SYNTH_PARAMS, sustain: 1.5 } }))).toThrow(/between 0 and 1/);
    expect(() => parseSynthPreset(presetFile({ params: { ...DEFAULT_SYNTH_PARAMS, attack: 0 } }))).toThrow(/Attack/);
    expect(() => parseSynthPreset(presetFile({ params: { ...DEFAULT_SYNTH_PARAMS, level: null } }))).toThrow(/finite number/);
    expect(() => parseSynthPreset(presetFile({ params: { ...DEFAULT_SYNTH_PARAMS, tuningHz: 'A440' } }))).toThrow(/finite number/);
  });

  it('rejects an unknown waveform and fractional octaves', () => {
    expect(() => parseSynthPreset(presetFile({ params: { ...DEFAULT_SYNTH_PARAMS, waveform: 'noise' } }))).toThrow(/Waveform must be one of/);
    expect(() => parseSynthPreset(presetFile({ params: { ...DEFAULT_SYNTH_PARAMS, octave: 0.5 } }))).toThrow(/whole number/);
  });

  it('rejects a parameter set with a missing field', () => {
    const { release: _omitted, ...partial } = DEFAULT_SYNTH_PARAMS;
    expect(() => parseSynthPreset(presetFile({ params: partial }))).toThrow(/Release must be a finite number/);
  });
});

describe('parameter validation', () => {
  it('validates every numeric range at its boundaries', () => {
    for (const [key, range] of Object.entries(SYNTH_PARAM_RANGES)) {
      expect(() => validateSynthParams({ ...DEFAULT_SYNTH_PARAMS, [key]: range.min })).not.toThrow();
      expect(() => validateSynthParams({ ...DEFAULT_SYNTH_PARAMS, [key]: range.max })).not.toThrow();
      expect(() => validateSynthParams({ ...DEFAULT_SYNTH_PARAMS, [key]: range.min - 1e-6 })).toThrow(SynthValidationError);
    }
  });

  it('returns a copy, not the input object', () => {
    const copy = validateSynthParams(DEFAULT_SYNTH_PARAMS);
    expect(copy).toEqual(DEFAULT_SYNTH_PARAMS);
    expect(copy).not.toBe(DEFAULT_SYNTH_PARAMS);
  });

  it('clamps UI values into range and falls back on non-finite input', () => {
    expect(clampSynthParam('level', 3, 0.5)).toBe(1);
    expect(clampSynthParam('level', -1, 0.5)).toBe(0);
    expect(clampSynthParam('filterCutoffHz', Number.NaN, 900)).toBe(900);
  });
});
