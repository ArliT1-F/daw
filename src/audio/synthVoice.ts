import { SYNTH_PARAM_RANGES, type SynthParams } from '../core/instruments/synthModel';

/**
 * Built-in synthesizer voice, built only from native Web Audio nodes:
 *
 *   oscillator (×1, or ×2 detuned ±spread) → low-pass BiquadFilter → ADSR GainNode → destination
 *
 * No custom DSP is involved. The envelope is precomputed as breakpoints, so note-off timing is
 * exact and a note can be cut or released without reading back live automation.
 */

export interface EnvelopePoint {
  /** Seconds after note-on. */
  time: number;
  /** Linear gain. */
  value: number;
}

export interface SynthNoteParts {
  sources: AudioScheduledSourceNode[];
  gains: GainNode[];
  /** When the voice stops sounding, including the release tail and a small guard. */
  endTime: number;
}

/** Quiet guard added after the release so the oscillators outlive their fade. */
const RELEASE_GUARD_SECONDS = 0.02;

/** MIDI note to Hz, relative to the instrument's A4 tuning. */
export function synthFrequency(pitch: number, tuningHz: number): number {
  return tuningHz * 2 ** ((pitch - 69) / 12);
}

/** Total pitch offset applied through oscillator detune, in cents. */
export function synthDetuneCents(params: SynthParams): number {
  return params.octave * 1200 + params.semitone * 100 + params.fineCents;
}

/**
 * The ADSR amplitude curve for a note held for `holdSeconds`, as breakpoints relative to note-on.
 *
 * - A note released during the attack is ramped to the level it had reached, so it never jumps.
 * - A note released during the decay is ramped to the decay level at that moment.
 * - Otherwise the sustain level is held until note-off, then ramped linearly to silence over
 *   `release` seconds.
 */
export function buildEnvelopePoints(params: SynthParams, holdSeconds: number, peak: number): EnvelopePoint[] {
  const hold = Math.max(0.0001, holdSeconds);
  const attack = Math.max(SYNTH_PARAM_RANGES.attack.min, params.attack);
  const decay = Math.max(SYNTH_PARAM_RANGES.decay.min, params.decay);
  const sustainLevel = peak * params.sustain;
  const points: EnvelopePoint[] = [{ time: 0, value: 0 }];
  if (hold <= attack) {
    points.push({ time: hold, value: peak * (hold / attack) });
  } else {
    points.push({ time: attack, value: peak });
    if (hold <= attack + decay) {
      const progress = (hold - attack) / decay;
      points.push({ time: hold, value: peak + (sustainLevel - peak) * progress });
    } else {
      points.push({ time: attack + decay, value: sustainLevel });
      points.push({ time: hold, value: sustainLevel });
    }
  }
  points.push({ time: hold + Math.max(SYNTH_PARAM_RANGES.release.min, params.release), value: 0 });
  return points;
}

/** Oscillator detune offsets in cents: one centred oscillator, or two opposite ones for spread. */
export function oscillatorDetuneOffsets(spreadCents: number): number[] {
  return spreadCents > 0 ? [-spreadCents, spreadCents] : [0];
}

/**
 * Build and schedule one note. The caller starts/stops the returned sources and wires any cut
 * behaviour; this function only creates nodes and automation.
 */
export function buildSynthNote(
  context: AudioContext,
  params: SynthParams,
  pitch: number,
  time: number,
  holdSeconds: number,
  velocity: number,
  destination: AudioNode,
): SynthNoteParts {
  const hold = Math.max(0.0001, holdSeconds);
  const detunes = oscillatorDetuneOffsets(params.spreadCents);
  // Two detuned oscillators sum louder than one; scale them down so spread does not change loudness much.
  const oscillatorScale = detunes.length > 1 ? 0.7 : 1;
  const peak = Math.min(1, Math.max(0, velocity)) * params.level * 0.6 * oscillatorScale;
  const points = buildEnvelopePoints(params, hold, peak);
  const releaseEnd = time + points[points.length - 1].time;

  const gain = context.createGain();
  gain.gain.setValueAtTime(0, time);
  for (const point of points.slice(1)) {
    gain.gain.linearRampToValueAtTime(point.value, time + point.time);
  }

  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = params.filterCutoffHz;
  filter.Q.value = params.filterQ;

  const frequency = synthFrequency(pitch, params.tuningHz);
  const sources: OscillatorNode[] = detunes.map((offset) => {
    const oscillator = context.createOscillator();
    oscillator.type = params.waveform;
    oscillator.frequency.value = frequency;
    oscillator.detune.value = synthDetuneCents(params) + offset;
    oscillator.connect(filter);
    return oscillator;
  });

  filter.connect(gain);
  gain.connect(destination);
  return { sources, gains: [gain], endTime: releaseEnd + RELEASE_GUARD_SECONDS };
}
