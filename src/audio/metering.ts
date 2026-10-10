/**
 * Level metering.
 *
 * Meters are analysis, never signal processing: one `AnalyserNode` sits in line with each mixer
 * bus and is polled at a bounded rate. All the behaviour that makes a meter readable — fast attack,
 * slow release, a held peak that falls after a pause, and a latching clip indicator — lives in the
 * pure `MeterBallistics` class so it can be tested without an audio context.
 *
 * `MeterBank` owns the polling side: it reads every attached analyser once per sample tick and
 * keeps the latest reading per channel. The UI decides how often to call `sample()`; nothing here
 * allocates per call beyond the reusable time-domain buffer created when an analyser is attached.
 */

import { dbToLinear, linearToDb } from '../core/mixer/mixerModel';

/** Window the analyser keeps. 1024 samples is ~21 ms at 48 kHz: short enough to follow transients. */
export const METER_FFT_SIZE = 1024;
/** Levels below this are displayed as silence. Matches the mixer fader floor. */
export const METER_FLOOR_DB = -60;
/** Rise time constant: a meter must reach a transient within one or two polls. */
export const METER_ATTACK_SECONDS = 0.004;
/** Fall time constant: the classic PPM-ish decay that makes levels readable. */
export const METER_RELEASE_SECONDS = 0.26;
/** How long the peak marker stays parked before it starts falling. */
export const METER_PEAK_HOLD_SECONDS = 0.8;
export const METER_PEAK_FALL_DB_PER_SECOND = 22;
/** Above this linear level the clip indicator latches (~-0.13 dBFS). */
export const METER_CLIP_THRESHOLD = 0.985;
/**
 * Longest delta treated as one continuous sample. A throttled background tab can leave a multi-second
 * gap; clamping keeps the decay arithmetic finite and the meter visually sane after a stall.
 */
export const METER_MAX_DELTA_SECONDS = 0.5;
/** Below this linear level the smoothed value snaps to zero instead of decaying forever. */
const METER_SILENCE = 1e-4;

export interface MeterSample {
  /** Instantaneous absolute peak of the analyser window, linear (can exceed 1). */
  peak: number;
  /** Instantaneous RMS of the analyser window, linear. */
  rms: number;
}

export interface MeterReading {
  /** Smoothed display level, linear. */
  level: number;
  levelDb: number;
  rms: number;
  /** Held peak, linear. */
  peak: number;
  peakDb: number;
  /** True when the most recent sample crossed the clip threshold. */
  clipped: boolean;
  /** Stays true until the user clears it, so a missed transient is still visible. */
  clipLatched: boolean;
}

export function emptyMeterReading(): MeterReading {
  return { level: 0, levelDb: METER_FLOOR_DB, rms: 0, peak: 0, peakDb: METER_FLOOR_DB, clipped: false, clipLatched: false };
}

function coefficient(deltaSeconds: number, timeConstant: number): number {
  if (deltaSeconds <= 0) return 0;
  return 1 - Math.exp(-deltaSeconds / Math.max(1e-6, timeConstant));
}

function towards(current: number, target: number, deltaSeconds: number, timeConstant: number): number {
  const next = current + (target - current) * coefficient(deltaSeconds, timeConstant);
  return next < METER_SILENCE && target < METER_SILENCE ? 0 : next;
}

/**
 * Peak/RMS ballistics for one meter. Pure: give it a sample, a delta, and the current time, and it
 * returns the reading to display.
 */
export class MeterBallistics {
  private level = 0;
  private rms = 0;
  private peak = 0;
  private peakHoldUntil = Number.NEGATIVE_INFINITY;
  private clipLatched = false;
  private clipped = false;

  get reading(): MeterReading {
    return {
      level: this.level,
      levelDb: linearToDb(this.level),
      rms: this.rms,
      peak: this.peak,
      peakDb: linearToDb(this.peak),
      clipped: this.clipped,
      clipLatched: this.clipLatched,
    };
  }

  update(sample: MeterSample, deltaSeconds: number, nowSeconds: number): MeterReading {
    const delta = Number.isFinite(deltaSeconds) ? Math.min(METER_MAX_DELTA_SECONDS, Math.max(0, deltaSeconds)) : 0;
    const instant = Number.isFinite(sample.peak) ? Math.max(0, sample.peak) : 0;
    const instantRms = Number.isFinite(sample.rms) ? Math.max(0, sample.rms) : 0;

    // Asymmetric smoothing: the meter must jump onto a transient and fall off it slowly.
    this.level = instant > this.level
      ? towards(this.level, instant, delta, METER_ATTACK_SECONDS)
      : towards(this.level, instant, delta, METER_RELEASE_SECONDS);
    this.rms = instantRms > this.rms
      ? towards(this.rms, instantRms, delta, METER_ATTACK_SECONDS)
      : towards(this.rms, instantRms, delta, METER_RELEASE_SECONDS);

    if (instant >= this.peak) {
      this.peak = instant;
      this.peakHoldUntil = nowSeconds + METER_PEAK_HOLD_SECONDS;
    } else if (nowSeconds >= this.peakHoldUntil) {
      // Peak markers fall in dB so the descent looks constant across the whole meter scale.
      const fallen = dbToLinear(Math.max(METER_FLOOR_DB, linearToDb(this.peak) - METER_PEAK_FALL_DB_PER_SECOND * delta));
      this.peak = Math.max(instant, fallen);
      if (this.peak <= instant) this.peakHoldUntil = nowSeconds + METER_PEAK_HOLD_SECONDS;
    }

    this.clipped = instant >= METER_CLIP_THRESHOLD;
    if (this.clipped) this.clipLatched = true;
    return this.reading;
  }

  /** Clear the latched clip indicator without touching the current level. */
  clearClip(): void {
    this.clipLatched = false;
    this.clipped = false;
  }

  reset(): void {
    this.level = 0;
    this.rms = 0;
    this.peak = 0;
    this.peakHoldUntil = Number.NEGATIVE_INFINITY;
    this.clipped = false;
    this.clipLatched = false;
  }
}

/** Anything that can hand over its current time-domain window. */
export interface TimeDomainSource {
  readonly fftSize: number;
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void;
}

interface MeterBankEntry {
  analyser: TimeDomainSource;
  buffer: Float32Array<ArrayBuffer>;
  ballistics: MeterBallistics;
}

/**
 * Polls every attached analyser once per sample tick and keeps the latest reading per channel id.
 *
 * Reading an analyser is the only cost, and it happens at the caller's throttled rate rather than
 * per animation frame per strip, so meter updates cannot flood the UI thread.
 */
export class MeterBank {
  private readonly entries = new Map<string, MeterBankEntry>();
  private readonly readings = new Map<string, MeterReading>();
  private lastSampleAt = -1;
  private samples = 0;

  attach(id: string, analyser: TimeDomainSource): void {
    if (this.entries.has(id)) this.detach(id);
    const fftSize = Number.isFinite(analyser.fftSize) && analyser.fftSize > 0 ? analyser.fftSize : METER_FFT_SIZE;
    this.entries.set(id, { analyser, buffer: new Float32Array(fftSize), ballistics: new MeterBallistics() });
    this.readings.set(id, emptyMeterReading());
  }

  detach(id: string): void {
    this.entries.delete(id);
    this.readings.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Number of completed sample passes; tests use it to prove the poll rate is bounded. */
  get sampleCount(): number {
    return this.samples;
  }

  /** Read every attached analyser once and advance its ballistics. */
  sample(nowSeconds: number): void {
    const now = Number.isFinite(nowSeconds) ? Math.max(0, nowSeconds) : 0;
    // The first pass snaps to the current signal instead of easing up from silence.
    const delta = this.lastSampleAt < 0 ? METER_MAX_DELTA_SECONDS : now - this.lastSampleAt;
    this.lastSampleAt = now;
    this.samples += 1;
    for (const [id, entry] of this.entries) {
      this.readings.set(id, entry.ballistics.update(readSample(entry), delta, now));
    }
  }

  reading(id: string): MeterReading | null {
    return this.readings.get(id) ?? null;
  }

  /** Every current reading, keyed by mixer channel id. */
  snapshot(): Record<string, MeterReading> {
    return Object.fromEntries(this.readings);
  }

  clearClip(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.ballistics.clearClip();
    this.readings.set(id, entry.ballistics.reading);
  }

  /** Reset every meter's ballistics, keeping the attachments (used after a transport stop). */
  reset(): void {
    for (const [id, entry] of this.entries) {
      entry.ballistics.reset();
      this.readings.set(id, emptyMeterReading());
    }
    this.lastSampleAt = -1;
    this.samples = 0;
  }

  /** Detach everything; used when the graph that owns the analysers is disposed. */
  clear(): void {
    this.entries.clear();
    this.readings.clear();
    this.lastSampleAt = -1;
    this.samples = 0;
  }
}

function readSample(entry: MeterBankEntry): MeterSample {
  const { analyser, buffer } = entry;
  if (typeof analyser.getFloatTimeDomainData !== 'function') return { peak: 0, rms: 0 };
  try {
    analyser.getFloatTimeDomainData(buffer);
  } catch {
    return { peak: 0, rms: 0 };
  }
  let peak = 0;
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const value = buffer[index];
    const magnitude = value < 0 ? -value : value;
    if (magnitude > peak) peak = magnitude;
    sum += value * value;
  }
  return { peak, rms: buffer.length > 0 ? Math.sqrt(sum / buffer.length) : 0 };
}
