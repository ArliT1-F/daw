/**
 * Effect definitions: the pure, audio-free description of every insert effect.
 *
 * Each effect is a type key plus a flat record of parameters in physical units (dB, Hz, ms, s,
 * ratio, or a 0..1 fraction shown as a percentage). This module is the single source of truth for
 * which parameters exist and their bounds, so the project model, the commands, the Web Audio
 * processors, and the editor all validate against the same table and never disagree.
 *
 * Nothing here imports Web Audio or React. Processors and controls are built on top of it.
 */

/** Every effect the rack knows. Adding a type means adding a row to `EFFECT_DEFINITIONS`. */
export const EFFECT_TYPES = ['eq3', 'reverb', 'delay', 'compressor', 'limiter'] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

/** Parameter values keyed by parameter key, in physical units. */
export type EffectParams = Record<string, number>;

/** Maximum effects per mixer channel. Chains are short on purpose: each one costs CPU. */
export const MAX_EFFECTS_PER_CHANNEL = 4;

export type EffectUnit = 'dB' | 'Hz' | 'ms' | 's' | 'ratio' | 'Q' | '%' | '';
export type EffectParamScale = 'linear' | 'log';

export interface EffectParamSpec {
  key: string;
  label: string;
  unit: EffectUnit;
  min: number;
  max: number;
  default: number;
  /** Logarithmic sliders give fine control at low values (frequency, time). Requires `min > 0`. */
  scale: EffectParamScale;
  /** Quantisation step applied by the editor. Stored values are always a whole multiple of it. */
  step: number;
}

export interface EffectDefinition {
  type: EffectType;
  label: string;
  shortLabel: string;
  description: string;
  /** Only the master bus may host this effect (the limiter guards the output level). */
  masterOnly: boolean;
  params: readonly EffectParamSpec[];
}

function param(
  key: string,
  label: string,
  unit: EffectUnit,
  min: number,
  max: number,
  defaultValue: number,
  options: { scale?: EffectParamScale; step: number },
): EffectParamSpec {
  const scale = options.scale ?? 'linear';
  if (scale === 'log' && min <= 0) throw new Error(`Log-scaled parameter ${key} needs a positive minimum.`);
  if (defaultValue < min || defaultValue > max) throw new Error(`Default for ${key} is outside its range.`);
  return { key, label, unit, min, max, default: defaultValue, scale, step: options.step };
}

export const EFFECT_DEFINITIONS: Readonly<Record<EffectType, EffectDefinition>> = {
  eq3: {
    type: 'eq3',
    label: '3-Band EQ',
    shortLabel: 'EQ',
    description: 'Low shelf, sweepable peaking band, and high shelf. Flat at the defaults.',
    masterOnly: false,
    params: [
      param('lowFreqHz', 'Low shelf frequency', 'Hz', 40, 800, 200, { scale: 'log', step: 1 }),
      param('lowGainDb', 'Low shelf gain', 'dB', -15, 15, 0, { step: 0.1 }),
      param('midFreqHz', 'Mid frequency', 'Hz', 200, 8000, 1000, { scale: 'log', step: 1 }),
      param('midGainDb', 'Mid gain', 'dB', -15, 15, 0, { step: 0.1 }),
      param('midQ', 'Mid bandwidth (Q)', 'Q', 0.2, 8, 1, { scale: 'log', step: 0.01 }),
      param('highFreqHz', 'High shelf frequency', 'Hz', 1500, 16000, 6000, { scale: 'log', step: 10 }),
      param('highGainDb', 'High shelf gain', 'dB', -15, 15, 0, { step: 0.1 }),
    ],
  },
  reverb: {
    type: 'reverb',
    label: 'Reverb',
    shortLabel: 'Verb',
    description: 'Convolution reverb with a generated, deterministic room impulse.',
    masterOnly: false,
    params: [
      param('decaySeconds', 'Decay time (RT60)', 's', 0.2, 5, 1.8, { step: 0.01 }),
      param('preDelayMs', 'Pre-delay', 'ms', 0, 200, 15, { step: 1 }),
      param('toneHz', 'Tail tone (lowpass)', 'Hz', 500, 18000, 7000, { scale: 'log', step: 10 }),
      param('mix', 'Wet mix', '%', 0, 1, 0.25, { step: 0.01 }),
    ],
  },
  delay: {
    type: 'delay',
    label: 'Delay',
    shortLabel: 'Dly',
    description: 'Feedback delay with a damped repeat tone. Feedback is capped below unity.',
    masterOnly: false,
    params: [
      param('timeMs', 'Delay time', 'ms', 1, 1500, 375, { step: 0.1 }),
      param('feedback', 'Feedback', '%', 0, 0.95, 0.35, { step: 0.01 }),
      param('toneHz', 'Repeat tone (lowpass)', 'Hz', 500, 18000, 4000, { scale: 'log', step: 10 }),
      param('mix', 'Wet mix', '%', 0, 1, 0.3, { step: 0.01 }),
    ],
  },
  compressor: {
    type: 'compressor',
    label: 'Compressor',
    shortLabel: 'Comp',
    description: 'Feed-forward dynamics compressor with makeup gain. Default settings leave the level unchanged.',
    masterOnly: false,
    params: [
      param('thresholdDb', 'Threshold', 'dB', -60, 0, -18, { step: 0.1 }),
      param('ratio', 'Ratio', 'ratio', 1, 20, 4, { scale: 'log', step: 0.1 }),
      param('kneeDb', 'Knee', 'dB', 0, 40, 6, { step: 0.1 }),
      param('attackMs', 'Attack', 'ms', 0, 200, 10, { step: 0.1 }),
      param('releaseMs', 'Release', 'ms', 10, 1000, 150, { scale: 'log', step: 1 }),
      param('makeupDb', 'Makeup gain', 'dB', 0, 24, 0, { step: 0.1 }),
    ],
  },
  limiter: {
    type: 'limiter',
    label: 'Limiter',
    shortLabel: 'Lim',
    description: 'Master-bus ceiling: fast-acting compression above the ceiling, then a hard clip at the ceiling as a safeguard.',
    masterOnly: true,
    params: [
      param('ceilingDb', 'Ceiling', 'dB', -12, 0, -1, { step: 0.1 }),
      param('releaseMs', 'Release', 'ms', 10, 500, 120, { scale: 'log', step: 1 }),
    ],
  },
};

export function isEffectType(value: unknown): value is EffectType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EFFECT_DEFINITIONS, value);
}

export function getEffectDefinition(type: EffectType): EffectDefinition {
  return EFFECT_DEFINITIONS[type];
}

export function getEffectParamSpec(type: EffectType, key: string): EffectParamSpec | undefined {
  return EFFECT_DEFINITIONS[type].params.find((spec) => spec.key === key);
}

export function defaultEffectParams(type: EffectType): EffectParams {
  return Object.fromEntries(EFFECT_DEFINITIONS[type].params.map((spec) => [spec.key, spec.default]));
}

/** Effect types a mixer channel may host: the master bus takes everything, inserts skip master-only effects. */
export function listEffectTypesFor(role: 'master' | 'insert'): EffectType[] {
  return EFFECT_TYPES.filter((type) => role === 'master' || !EFFECT_DEFINITIONS[type].masterOnly);
}

/** Whether a single parameter value is a finite number inside its spec's range. */
export function isEffectValueInRange(spec: EffectParamSpec, value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= spec.min && value <= spec.max;
}

/**
 * Fill any missing parameters with their defaults. Unknown keys and wrong values are left alone so
 * that `validateEffectParams` can report them; this only completes a partial record.
 */
export function fillEffectParams(type: EffectType, params: Record<string, unknown>): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...params };
  for (const spec of EFFECT_DEFINITIONS[type].params) {
    if (filled[spec.key] === undefined) filled[spec.key] = spec.default;
  }
  return filled;
}

/**
 * Check a complete parameter record. Returns the first problem as a message, or `null` when the
 * record has exactly the type's parameters, each finite and inside its range.
 */
export function validateEffectParams(type: EffectType, params: Record<string, unknown>): string | null {
  const known = new Set(EFFECT_DEFINITIONS[type].params.map((spec) => spec.key));
  for (const key of Object.keys(params)) {
    if (!known.has(key)) return `Effect parameter "${key}" is not a ${EFFECT_DEFINITIONS[type].label} parameter.`;
  }
  for (const spec of EFFECT_DEFINITIONS[type].params) {
    const value = params[spec.key];
    if (value === undefined) return `Effect parameter "${spec.key}" is missing.`;
    if (!Number.isFinite(value)) return `Effect parameter "${spec.key}" must be a finite number.`;
    if (!isEffectValueInRange(spec, value)) {
      return `${EFFECT_DEFINITIONS[type].label} ${spec.label} must be between ${spec.min} and ${spec.max}${spec.unit ? ` ${spec.unit}` : ''}.`;
    }
  }
  return null;
}

/** Map a parameter value onto a 0..1 slider position, honouring its scale. */
export function effectValueToNormalized(spec: EffectParamSpec, value: number): number {
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  const position = spec.scale === 'log'
    ? Math.log(clamped / spec.min) / Math.log(spec.max / spec.min)
    : (clamped - spec.min) / (spec.max - spec.min);
  return Math.min(1, Math.max(0, position));
}

/** Inverse of `effectValueToNormalized`. The result is clamped into the parameter's range. */
export function normalizedToEffectValue(spec: EffectParamSpec, position: number): number {
  const t = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0));
  const value = spec.scale === 'log'
    ? spec.min * (spec.max / spec.min) ** t
    : spec.min + t * (spec.max - spec.min);
  return Math.min(spec.max, Math.max(spec.min, value));
}

/** Round a value to its spec's step and range, removing float noise such as 0.30000000004. */
export function quantizeEffectValue(spec: EffectParamSpec, value: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(spec.step)));
  const stepped = Math.round(value / spec.step) * spec.step;
  const clamped = Math.min(spec.max, Math.max(spec.min, stepped));
  return Number(clamped.toFixed(decimals));
}

/** Human-readable value, for readouts and tooltips. */
export function formatEffectValue(spec: EffectParamSpec, value: number): string {
  if (!Number.isFinite(value)) return '—';
  switch (spec.unit) {
    case 'dB': {
      const rounded = Math.abs(value) < 0.05 ? 0 : value;
      return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
    }
    case 'Hz':
      return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz` : `${Math.round(value)} Hz`;
    case 'ms':
      return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
    case 's':
      return `${value.toFixed(2)} s`;
    case 'ratio':
      return `${value.toFixed(1)}:1`;
    case 'Q':
      return value.toFixed(2);
    case '%':
      return `${Math.round(value * 100)}%`;
    default:
      return value.toFixed(2);
  }
}
