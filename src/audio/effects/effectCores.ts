/**
 * Native Web Audio cores for each effect type.
 *
 * Every effect here is a composition of built-in nodes (BiquadFilter, Convolver, Delay, Compressor,
 * WaveShaper, Gain). No AudioWorklet is used: none of these needs per-sample logic that the native
 * nodes cannot express, and native nodes run on the audio thread without a module load step, which
 * also keeps them usable in an OfflineAudioContext.
 *
 * Constructors take initial values directly (a brand-new node is silent, so nothing is ramped).
 * `update` ramps every later change with `setTargetAtTime`, so parameter moves never click.
 */

import type { EffectType } from '../../core/effects/effectDefinitions';
import {
  EFFECT_PARAM_SMOOTH_SECONDS,
  REVERB_CROSSFADE_SECONDS,
  REVERB_IR_DEBOUNCE_MS,
  REVERB_RETIRE_MS,
  type EffectCore,
  type EffectParamValues,
} from './types';
import { getCachedReverbImpulse, MAX_IMPULSE_SECONDS } from './impulseResponse';

/** Longest pre-delay the reverb supports (the spec's 200 ms, with headroom). */
const MAX_PREDELAY_SECONDS = 0.25;
/** Longest feedback delay line. The UI maximum is 1500 ms. */
const MAX_DELAY_SECONDS = 2;
/** Limiter release is also smoothed; attack is fixed so the ceiling is held quickly. */
const LIMITER_ATTACK_SECONDS = 0.001;
const LIMITER_RATIO = 20;

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** Smooth one AudioParam toward a value. The shared helper for every parameter write. */
export function rampParam(param: AudioParam, value: number, when: number): void {
  param.setTargetAtTime(value, when, EFFECT_PARAM_SMOOTH_SECONDS);
}

type Mapper = (value: number) => number;
interface Binding {
  param: AudioParam;
  map?: Mapper;
  /** Extra work after the AudioParam write (for values that are not AudioParams). */
  after?: (value: number, when: number) => void;
}

/** Route changed parameter keys to their bindings. Keys without a binding are ignored. */
function applyBindings(
  bindings: Readonly<Record<string, Binding>>,
  params: EffectParamValues,
  changed: readonly string[],
  when: number,
): number {
  let writes = 0;
  for (const key of changed) {
    const binding = bindings[key];
    if (!binding) continue;
    const value = binding.map ? binding.map(params[key]) : params[key];
    rampParam(binding.param, value, when);
    binding.after?.(params[key], when);
    writes += 1;
  }
  return writes;
}

/** Disconnect `from → to` only; tolerate a pair that is not connected. */
export function disconnectPair(from: AudioNode, to: AudioNode): void {
  try {
    from.disconnect(to);
  } catch {
    /* not connected */
  }
}

// ---------------------------------------------------------------- 3-band EQ

export function createEq3Core(context: BaseAudioContext, params: EffectParamValues): EffectCore {
  const low = context.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = params.lowFreqHz;
  low.gain.value = params.lowGainDb;

  const mid = context.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = params.midFreqHz;
  mid.gain.value = params.midGainDb;
  mid.Q.value = params.midQ;

  const high = context.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = params.highFreqHz;
  high.gain.value = params.highGainDb;

  low.connect(mid);
  mid.connect(high);

  const bindings: Record<string, Binding> = {
    lowFreqHz: { param: low.frequency },
    lowGainDb: { param: low.gain },
    midFreqHz: { param: mid.frequency },
    midGainDb: { param: mid.gain },
    midQ: { param: mid.Q },
    highFreqHz: { param: high.frequency },
    highGainDb: { param: high.gain },
  };

  return {
    input: low,
    output: high,
    update: (next, changed, when) => applyBindings(bindings, next, changed, when),
    dispose: () => {
      low.disconnect();
      mid.disconnect();
      high.disconnect();
    },
  };
}

// ------------------------------------------------------------------ reverb

interface ConvolverSlot {
  convolver: ConvolverNode;
  fade: GainNode;
}

/**
 * Convolution reverb: `input → dry → output` plus `input → pre-delay → convolver → tone → wet → output`.
 *
 * The room impulse depends on the decay time, which is the one expensive change. Changes are
 * debounced, and a rebuilt impulse is crossfaded in over a new ConvolverNode while the old one fades
 * out and is then disconnected. Pre-delay, tone, and mix are plain AudioParam ramps.
 */
export function createReverbCore(context: BaseAudioContext, params: EffectParamValues): EffectCore {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  dry.gain.value = 1 - params.mix;
  const predelay = context.createDelay(MAX_PREDELAY_SECONDS);
  predelay.delayTime.value = params.preDelayMs / 1000;
  const tone = context.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = params.toneHz;
  tone.Q.value = 0.5;
  const wet = context.createGain();
  wet.gain.value = params.mix;

  input.connect(dry);
  dry.connect(output);
  input.connect(predelay);
  tone.connect(wet);
  wet.connect(output);

  const buildSlot = (decaySeconds: number, initialFade: number): ConvolverSlot => {
    const impulse = getCachedReverbImpulse(decaySeconds, context.sampleRate);
    const buffer = context.createBuffer(2, impulse.length, impulse.sampleRate);
    buffer.getChannelData(0).set(impulse.channels[0]);
    buffer.getChannelData(1).set(impulse.channels[1]);
    const convolver = context.createConvolver();
    convolver.buffer = buffer;
    const fade = context.createGain();
    fade.gain.value = initialFade;
    predelay.connect(convolver);
    convolver.connect(fade);
    fade.connect(tone);
    return { convolver, fade };
  };

  let active = buildSlot(params.decaySeconds, 1);
  let pendingDecay: number | null = null;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  const retiring = new Map<ReturnType<typeof setTimeout>, ConvolverSlot>();
  let disposed = false;

  const disconnectSlot = (slot: ConvolverSlot): void => {
    disconnectPair(predelay, slot.convolver);
    slot.convolver.disconnect();
    slot.fade.disconnect();
  };

  const rebuildImpulse = (): void => {
    rebuildTimer = null;
    if (disposed || pendingDecay === null) return;
    const decaySeconds = pendingDecay;
    pendingDecay = null;
    const when = context.currentTime;
    const previous = active;
    const fresh = buildSlot(decaySeconds, 0);
    fresh.fade.gain.setTargetAtTime(1, when, REVERB_CROSSFADE_SECONDS);
    previous.fade.gain.setTargetAtTime(0, when, REVERB_CROSSFADE_SECONDS);
    active = fresh;
    const timer = setTimeout(() => {
      retiring.delete(timer);
      disconnectSlot(previous);
    }, REVERB_RETIRE_MS);
    retiring.set(timer, previous);
  };

  return {
    input,
    output,
    update: (next, changed, when) => {
      let writes = 0;
      for (const key of changed) {
        switch (key) {
          case 'decaySeconds':
            // Not a parameter write: the impulse is rebuilt once the value stops moving.
            pendingDecay = Math.min(MAX_IMPULSE_SECONDS, next.decaySeconds);
            if (rebuildTimer !== null) clearTimeout(rebuildTimer);
            rebuildTimer = setTimeout(rebuildImpulse, REVERB_IR_DEBOUNCE_MS);
            break;
          case 'preDelayMs':
            rampParam(predelay.delayTime, next.preDelayMs / 1000, when);
            break;
          case 'toneHz':
            rampParam(tone.frequency, next.toneHz, when);
            break;
          case 'mix':
            rampParam(wet.gain, next.mix, when);
            rampParam(dry.gain, 1 - next.mix, when);
            break;
          default:
            continue;
        }
        writes += 1;
      }
      return writes;
    },
    dispose: () => {
      disposed = true;
      if (rebuildTimer !== null) clearTimeout(rebuildTimer);
      rebuildTimer = null;
      for (const [timer, slot] of retiring) {
        clearTimeout(timer);
        disconnectSlot(slot);
      }
      retiring.clear();
      disconnectSlot(active);
      input.disconnect();
      dry.disconnect();
      predelay.disconnect();
      tone.disconnect();
      wet.disconnect();
      output.disconnect();
    },
  };
}

// ------------------------------------------------------------------- delay

/**
 * Feedback delay: `input → dry → output` plus `input → line → wet → output`, with the repeat path
 * `line → tone (lowpass) → feedback gain → line`. Feedback never exceeds 0.95, so every repeat decays
 * and the loop cannot run away.
 */
export function createDelayCore(context: BaseAudioContext, params: EffectParamValues): EffectCore {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  dry.gain.value = 1 - params.mix;
  const line = context.createDelay(MAX_DELAY_SECONDS);
  line.delayTime.value = params.timeMs / 1000;
  const tone = context.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = params.toneHz;
  tone.Q.value = 0.5;
  const feedback = context.createGain();
  feedback.gain.value = params.feedback;
  const wet = context.createGain();
  wet.gain.value = params.mix;

  input.connect(dry);
  dry.connect(output);
  input.connect(line);
  line.connect(tone);
  tone.connect(feedback);
  feedback.connect(line);
  line.connect(wet);
  wet.connect(output);

  const bindings: Record<string, Binding> = {
    timeMs: { param: line.delayTime, map: (ms) => ms / 1000 },
    feedback: { param: feedback.gain },
    toneHz: { param: tone.frequency },
    mix: { param: wet.gain, after: (value, when) => rampParam(dry.gain, 1 - value, when) },
  };

  return {
    input,
    output,
    update: (next, changed, when) => applyBindings(bindings, next, changed, when),
    dispose: () => {
      input.disconnect();
      dry.disconnect();
      line.disconnect();
      tone.disconnect();
      feedback.disconnect();
      wet.disconnect();
      output.disconnect();
    },
  };
}

// -------------------------------------------------------------- compressor

/** Feed-forward compressor followed by makeup gain. Default makeup is unity, so it is transparent. */
export function createCompressorCore(context: BaseAudioContext, params: EffectParamValues): EffectCore {
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = params.thresholdDb;
  compressor.knee.value = params.kneeDb;
  compressor.ratio.value = params.ratio;
  compressor.attack.value = params.attackMs / 1000;
  compressor.release.value = params.releaseMs / 1000;
  const makeup = context.createGain();
  makeup.gain.value = dbToGain(params.makeupDb);
  compressor.connect(makeup);

  const bindings: Record<string, Binding> = {
    thresholdDb: { param: compressor.threshold },
    kneeDb: { param: compressor.knee },
    ratio: { param: compressor.ratio },
    attackMs: { param: compressor.attack, map: (ms) => ms / 1000 },
    releaseMs: { param: compressor.release, map: (ms) => ms / 1000 },
    makeupDb: { param: makeup.gain, map: dbToGain },
  };

  return {
    input: compressor,
    output: makeup,
    update: (next, changed, when) => applyBindings(bindings, next, changed, when),
    dispose: () => {
      compressor.disconnect();
      makeup.disconnect();
    },
  };
}

// ----------------------------------------------------------------- limiter

/**
 * Hard ceiling as a transfer curve: `y = clamp(x, -ceiling, ceiling)` over the WaveShaper's [-1, 1]
 * input range. Linear interpolation between points cannot overshoot the ceiling, because both
 * neighbours are already at or below it.
 */
export function ceilingCurve(ceilingLinear: number, points = 2048): Float32Array<ArrayBuffer> {
  const ceiling = Math.min(1, Math.max(1e-6, ceilingLinear));
  const curve = new Float32Array(new ArrayBuffer(points * Float32Array.BYTES_PER_ELEMENT));
  for (let index = 0; index < points; index += 1) {
    const x = -1 + (2 * index) / (points - 1);
    curve[index] = Math.min(ceiling, Math.max(-ceiling, x));
  }
  return curve;
}

/**
 * Master-bus limiter: a fast ratio-20 compressor whose threshold is the ceiling, then a hard clip at
 * the same ceiling. The compressor does the musical work; the clip is the safeguard for the
 * transients the compressor's attack lets through.
 *
 * Native compressors have no lookahead, so the first milliseconds of a sharp transient can still
 * exceed the ceiling before the clip catches them. That is the documented limit of this design.
 */
export function createLimiterCore(context: BaseAudioContext, params: EffectParamValues): EffectCore {
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = params.ceilingDb;
  compressor.knee.value = 0;
  compressor.ratio.value = LIMITER_RATIO;
  compressor.attack.value = LIMITER_ATTACK_SECONDS;
  compressor.release.value = params.releaseMs / 1000;
  const clip = context.createWaveShaper();
  clip.oversample = 'none';
  clip.curve = ceilingCurve(dbToGain(params.ceilingDb));
  compressor.connect(clip);

  const bindings: Record<string, Binding> = {
    ceilingDb: {
      param: compressor.threshold,
      after: (value) => {
        // A curve cannot be ramped; the new ceiling takes effect at the next render quantum.
        clip.curve = ceilingCurve(dbToGain(value));
      },
    },
    releaseMs: { param: compressor.release, map: (ms) => ms / 1000 },
  };

  return {
    input: compressor,
    output: clip,
    update: (next, changed, when) => applyBindings(bindings, next, changed, when),
    dispose: () => {
      compressor.disconnect();
      clip.disconnect();
    },
  };
}

// ------------------------------------------------------------------ factory

export function createEffectCore(context: BaseAudioContext, type: EffectType, params: EffectParamValues): EffectCore {
  switch (type) {
    case 'eq3':
      return createEq3Core(context, params);
    case 'reverb':
      return createReverbCore(context, params);
    case 'delay':
      return createDelayCore(context, params);
    case 'compressor':
      return createCompressorCore(context, params);
    case 'limiter':
      return createLimiterCore(context, params);
    default: {
      const exhaustive: never = type;
      throw new Error(`No audio core for effect type ${String(exhaustive)}.`);
    }
  }
}
