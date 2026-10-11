/**
 * Built-in synthesizer parameters, presets, and the versioned preset file format.
 *
 * Everything here is plain, serializable data. Presets are parameter definitions, never live
 * audio nodes: the audio layer turns a `SynthParams` into native Web Audio nodes at note-on time.
 */

export const SYNTH_WAVEFORMS = ['sine', 'square', 'sawtooth', 'triangle'] as const;
export type SynthWaveform = (typeof SYNTH_WAVEFORMS)[number];

/** Bumped only when the meaning of stored synth parameters changes. */
export const SYNTH_STATE_VERSION = 1 as const;
export const SYNTH_PRESET_FORMAT = 'gridline-synth-preset' as const;
export const SYNTH_PRESET_VERSION = 1 as const;

export interface SynthParams {
  waveform: SynthWaveform;
  /** Whole octaves, applied on top of the played note. */
  octave: number;
  /** Semitones of transposition. */
  semitone: number;
  /** Fine tuning in cents. */
  fineCents: number;
  /** Reference frequency of A4 (MIDI 69) in Hz. */
  tuningHz: number;
  /** Detune of a second, opposite oscillator in cents; 0 uses a single oscillator. */
  spreadCents: number;
  /** ADSR amplitude envelope, times in seconds and sustain as a 0..1 level. */
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Low-pass filter cutoff in Hz and resonance (Q). */
  filterCutoffHz: number;
  filterQ: number;
  /** Output level, 0..1. */
  level: number;
}

export interface SynthParamRange {
  min: number;
  max: number;
  integer?: boolean;
  label: string;
}

/** Validation limits. The UI, commands, presets, and audio builder all use these same bounds. */
export const SYNTH_PARAM_RANGES: Record<Exclude<keyof SynthParams, 'waveform'>, SynthParamRange> = {
  octave: { min: -2, max: 2, integer: true, label: 'Octave' },
  semitone: { min: -12, max: 12, integer: true, label: 'Semitone' },
  fineCents: { min: -100, max: 100, label: 'Fine tune' },
  tuningHz: { min: 400, max: 480, label: 'Tuning' },
  spreadCents: { min: 0, max: 50, label: 'Spread' },
  attack: { min: 0.001, max: 4, label: 'Attack' },
  decay: { min: 0.001, max: 4, label: 'Decay' },
  sustain: { min: 0, max: 1, label: 'Sustain' },
  release: { min: 0.005, max: 8, label: 'Release' },
  filterCutoffHz: { min: 40, max: 20000, label: 'Filter cutoff' },
  filterQ: { min: 0.1, max: 18, label: 'Resonance' },
  level: { min: 0, max: 1, label: 'Level' },
};

export const DEFAULT_SYNTH_PARAMS: SynthParams = {
  waveform: 'sawtooth',
  octave: 0,
  semitone: 0,
  fineCents: 0,
  tuningHz: 440,
  spreadCents: 7,
  attack: 0.01,
  decay: 0.2,
  sustain: 0.7,
  release: 0.3,
  filterCutoffHz: 3200,
  filterQ: 0.9,
  level: 0.8,
};

const NUMERIC_KEYS = Object.keys(SYNTH_PARAM_RANGES) as Array<keyof typeof SYNTH_PARAM_RANGES>;
const PARAM_KEYS: readonly string[] = ['waveform', ...NUMERIC_KEYS];

export class SynthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynthValidationError';
  }
}

/** Validate a complete parameter set. Unknown keys are rejected so typos never pass silently. */
export function assertValidSynthParams(value: unknown): asserts value is SynthParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SynthValidationError('Synth parameters must be an object.');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PARAM_KEYS.includes(key)) throw new SynthValidationError(`Unknown synth parameter "${key}".`);
  }
  if (!(SYNTH_WAVEFORMS as readonly unknown[]).includes(record.waveform)) {
    throw new SynthValidationError(`Waveform must be one of ${SYNTH_WAVEFORMS.join(', ')}.`);
  }
  for (const key of NUMERIC_KEYS) {
    const range = SYNTH_PARAM_RANGES[key];
    const param = record[key];
    if (typeof param !== 'number' || !Number.isFinite(param)) {
      throw new SynthValidationError(`${range.label} must be a finite number.`);
    }
    if (range.integer && !Number.isInteger(param)) {
      throw new SynthValidationError(`${range.label} must be a whole number.`);
    }
    if (param < range.min || param > range.max) {
      throw new SynthValidationError(`${range.label} must be between ${range.min} and ${range.max}.`);
    }
  }
}

/** Returns a copy of valid parameters, validating first. */
export function validateSynthParams(value: unknown): SynthParams {
  assertValidSynthParams(value);
  return { ...value };
}

/** Clamp a numeric UI value into its legal range; non-finite input falls back to `fallback`. */
export function clampSynthParam<K extends keyof typeof SYNTH_PARAM_RANGES>(key: K, value: number, fallback: number): number {
  const range = SYNTH_PARAM_RANGES[key];
  if (!Number.isFinite(value)) return fallback;
  const bounded = Math.min(range.max, Math.max(range.min, value));
  return range.integer ? Math.round(bounded) : bounded;
}

export interface SynthPreset {
  /** Stable identifier, never shown to the user and never changed once released. */
  id: string;
  name: string;
  params: SynthParams;
}

/** Built-in presets. Loading one copies its parameters into a channel; nothing links back. */
export const SYNTH_PRESETS: readonly SynthPreset[] = [
  { id: 'detuned-saw', name: 'Detuned Saw', params: { ...DEFAULT_SYNTH_PARAMS } },
  {
    id: 'sub-bass',
    name: 'Sub Bass',
    params: {
      waveform: 'sine', octave: -1, semitone: 0, fineCents: 0, tuningHz: 440, spreadCents: 0,
      attack: 0.004, decay: 0.3, sustain: 0.8, release: 0.12, filterCutoffHz: 900, filterQ: 0.5, level: 0.9,
    },
  },
  {
    id: 'pluck',
    name: 'Saw Pluck',
    params: {
      waveform: 'sawtooth', octave: 0, semitone: 0, fineCents: 0, tuningHz: 440, spreadCents: 5,
      attack: 0.002, decay: 0.35, sustain: 0.0, release: 0.15, filterCutoffHz: 1800, filterQ: 1.2, level: 0.75,
    },
  },
  {
    id: 'square-lead',
    name: 'Square Lead',
    params: {
      waveform: 'square', octave: 0, semitone: 0, fineCents: 0, tuningHz: 440, spreadCents: 0,
      attack: 0.01, decay: 0.12, sustain: 0.75, release: 0.18, filterCutoffHz: 4200, filterQ: 0.7, level: 0.55,
    },
  },
  {
    id: 'soft-pad',
    name: 'Soft Pad',
    params: {
      waveform: 'triangle', octave: 0, semitone: 0, fineCents: 0, tuningHz: 440, spreadCents: 12,
      attack: 0.6, decay: 0.8, sustain: 0.65, release: 1.4, filterCutoffHz: 2200, filterQ: 0.6, level: 0.7,
    },
  },
  {
    id: 'sine-bell',
    name: 'Sine Bell',
    params: {
      waveform: 'sine', octave: 1, semitone: 0, fineCents: 0, tuningHz: 440, spreadCents: 0,
      attack: 0.003, decay: 0.9, sustain: 0.0, release: 0.9, filterCutoffHz: 8000, filterQ: 0.5, level: 0.7,
    },
  },
];

export function findSynthPreset(id: string): SynthPreset | undefined {
  return SYNTH_PRESETS.find((preset) => preset.id === id);
}

/** A channel's stored instrument: the preset name it was loaded from plus its live parameters. */
export interface ChannelSynth {
  version: typeof SYNTH_STATE_VERSION;
  /** Name shown in the UI; `null` once the parameters were edited by hand. */
  presetName: string | null;
  params: SynthParams;
}

export function createChannelSynth(params: SynthParams = DEFAULT_SYNTH_PARAMS, presetName: string | null = 'Detuned Saw'): ChannelSynth {
  return { version: SYNTH_STATE_VERSION, presetName, params: { ...params } };
}

export function assertValidChannelSynth(value: unknown): asserts value is ChannelSynth {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SynthValidationError('Channel synth state must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SYNTH_STATE_VERSION) {
    throw new SynthValidationError(`Unsupported synth state version: ${String(record.version)}.`);
  }
  if (record.presetName !== null && (typeof record.presetName !== 'string' || record.presetName.trim().length === 0 || record.presetName.length > 80)) {
    throw new SynthValidationError('Preset name must be empty or 1 to 80 characters.');
  }
  assertValidSynthParams(record.params);
}

/** Serialize one preset to the stable, versioned JSON file format. */
export function serializeSynthPreset(name: string, params: SynthParams): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new SynthValidationError('Preset name must be between 1 and 80 characters.');
  assertValidSynthParams(params);
  const file = { format: SYNTH_PRESET_FORMAT, version: SYNTH_PRESET_VERSION, name: trimmed, params: { ...params } };
  return JSON.stringify(file, null, 2);
}

/**
 * Parse a preset file. Version 1 is the only format; unknown formats, versions, and parameters
 * are rejected with an actionable message. Future versions add a migration here, not new readers.
 */
export function parseSynthPreset(text: string): { name: string; params: SynthParams } {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (error) {
    throw new SynthValidationError(`The preset file is not valid JSON. ${error instanceof Error ? error.message : ''}`.trim());
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new SynthValidationError('The preset file must contain an object.');
  }
  const record = data as Record<string, unknown>;
  if (record.format !== SYNTH_PRESET_FORMAT) throw new SynthValidationError('This file is not a Gridline synth preset.');
  if (record.version !== SYNTH_PRESET_VERSION) {
    throw new SynthValidationError(`Unsupported synth preset version: ${String(record.version)}.`);
  }
  if (typeof record.name !== 'string' || record.name.trim().length === 0 || record.name.length > 80) {
    throw new SynthValidationError('Preset name must be between 1 and 80 characters.');
  }
  assertValidSynthParams(record.params);
  return { name: record.name.trim(), params: { ...record.params } };
}
