import { describe, expect, it } from 'vitest';
import { linearToDb } from '../core/mixer/mixerModel';
import {
  METER_CLIP_THRESHOLD,
  METER_FLOOR_DB,
  METER_PEAK_HOLD_SECONDS,
  METER_RELEASE_SECONDS,
  MeterBallistics,
  MeterBank,
  emptyMeterReading,
  type TimeDomainSource,
} from './metering';

/** A deterministic sine whose absolute peak equals `amplitude` and whose RMS is amplitude / √2. */
function tone(amplitude: number): TimeDomainSource {
  return {
    fftSize: 1024,
    getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void {
      for (let index = 0; index < array.length; index += 1) {
        array[index] = amplitude * Math.sin((2 * Math.PI * index) / 32);
      }
    },
  };
}

function loud(peak: number, rms = peak / Math.SQRT2) {
  return { peak, rms };
}

describe('meter ballistics', () => {
  it('starts at the floor and snaps up to a transient on the first poll', () => {
    const ballistics = new MeterBallistics();
    expect(ballistics.reading).toEqual(emptyMeterReading());

    const reading = ballistics.update(loud(0.8), 0.1, 0.1);
    expect(reading.level).toBeCloseTo(0.8, 6);
    expect(reading.levelDb).toBeCloseTo(linearToDb(0.8), 6);
    expect(reading.rms).toBeCloseTo(0.8 / Math.SQRT2, 6);
    expect(reading.peak).toBeCloseTo(0.8, 6);
    expect(reading.clipped).toBe(false);
  });

  it('rises quickly but falls slowly, so levels are readable', () => {
    const ballistics = new MeterBallistics();
    ballistics.update(loud(0.9), 0.1, 0.1);
    const falling = ballistics.update(loud(0.1), 0.03, 0.13);
    expect(falling.level).toBeLessThan(0.9);
    expect(falling.level).toBeGreaterThan(0.1);
    // One release step removes the expected fraction of the gap, not an instantaneous drop.
    const expected = 0.9 + (0.1 - 0.9) * (1 - Math.exp(-0.03 / METER_RELEASE_SECONDS));
    expect(falling.level).toBeCloseTo(expected, 6);
  });

  it('holds the peak for a pause, then lets it fall in dB', () => {
    const ballistics = new MeterBallistics();
    ballistics.update(loud(0.8), 0.1, 0.1);

    const held = ballistics.update(loud(0.05), 0.02, 0.1 + METER_PEAK_HOLD_SECONDS / 2);
    expect(held.peak).toBeCloseTo(0.8, 6);

    const fallen = ballistics.update(loud(0.05), 0.05, 0.1 + METER_PEAK_HOLD_SECONDS);
    expect(fallen.peak).toBeLessThan(0.8);
    expect(fallen.peak).toBeGreaterThan(0.05);
  });

  it('latches the clip indicator past the threshold until it is cleared', () => {
    const ballistics = new MeterBallistics();
    const clipping = ballistics.update(loud(METER_CLIP_THRESHOLD + 0.01), 0.1, 0.1);
    expect(clipping.clipped).toBe(true);
    expect(clipping.clipLatched).toBe(true);

    ballistics.update(loud(0.1), 0.02, 0.12);
    expect(ballistics.reading.clipLatched).toBe(true);

    ballistics.clearClip();
    expect(ballistics.reading.clipLatched).toBe(false);
    ballistics.update(loud(0.1), 0.02, 0.14);
    expect(ballistics.reading.clipLatched).toBe(false);
  });

  it('reports clip state at exactly the threshold boundary', () => {
    const ballistics = new MeterBallistics();
    expect(ballistics.update(loud(METER_CLIP_THRESHOLD - 0.001), 0.1, 0.1).clipped).toBe(false);
    expect(ballistics.update(loud(METER_CLIP_THRESHOLD), 0.02, 0.12).clipped).toBe(true);
  });

  it('keeps readings finite for zero, negative, and non-finite samples', () => {
    const ballistics = new MeterBallistics();
    for (const sample of [{ peak: 0, rms: 0 }, { peak: -1, rms: Number.NaN }, { peak: Number.POSITIVE_INFINITY, rms: 0 }]) {
      const reading = ballistics.update(sample, 0.1, 0.1);
      expect(Number.isFinite(reading.level)).toBe(true);
      expect(Number.isFinite(reading.levelDb)).toBe(true);
      expect(reading.level).toBeGreaterThanOrEqual(0);
    }
  });

  it('resets to the floor without losing the attachment', () => {
    const ballistics = new MeterBallistics();
    ballistics.update(loud(0.9), 0.1, 0.1);
    ballistics.reset();
    expect(ballistics.reading.level).toBe(0);
    expect(ballistics.reading.peak).toBe(0);
    expect(ballistics.reading.levelDb).toBe(METER_FLOOR_DB);
  });
});

describe('meter bank polling', () => {
  it('reads every attached analyser once per sample and reports peak and RMS', () => {
    const bank = new MeterBank();
    bank.attach('mix-1', tone(0.5));
    bank.attach('mix-2', tone(0.25));

    bank.sample(0.05);
    expect(bank.sampleCount).toBe(1);
    expect(bank.ids.sort()).toEqual(['mix-1', 'mix-2']);

    const one = bank.reading('mix-1');
    expect(one?.peak).toBeCloseTo(0.5, 6);
    expect(one?.rms).toBeCloseTo(0.5 / Math.SQRT2, 6);
    expect(bank.reading('mix-2')?.peak).toBeCloseTo(0.25, 6);
    expect(bank.reading('missing')).toBeNull();

    const snapshot = bank.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual(['mix-1', 'mix-2']);
  });

  it('samples the analysers exactly once per call, no matter how many readings are read', () => {
    const source: TimeDomainSource = {
      fftSize: 1024,
      getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void {
        (source as { reads?: number }).reads = ((source as { reads?: number }).reads ?? 0) + 1;
        array.fill(0.4);
      },
    };
    const bank = new MeterBank();
    bank.attach('mix-1', source);
    bank.sample(0.1);
    bank.reading('mix-1');
    bank.reading('mix-1');
    bank.sample(0.15);
    expect((source as { reads?: number }).reads).toBe(2);
  });

  it('stops reporting a meter once it is detached', () => {
    const bank = new MeterBank();
    bank.attach('mix-1', tone(0.5));
    bank.sample(0.05);
    expect(bank.reading('mix-1')).not.toBeNull();
    bank.detach('mix-1');
    expect(bank.reading('mix-1')).toBeNull();
    expect(bank.has('mix-1')).toBe(false);
    expect(bank.sampleCount).toBe(1);
  });

  it('stays finite after a long stall between polls', () => {
    const bank = new MeterBank();
    bank.attach('mix-1', tone(0.6));
    bank.sample(0.1);
    bank.sample(0.1 + 60); // a throttled background tab returning a minute later
    const reading = bank.reading('mix-1');
    expect(Number.isFinite(reading?.level)).toBe(true);
    expect(Number.isFinite(reading?.peakDb)).toBe(true);
    expect(reading?.peak).toBeGreaterThan(0);
  });

  it('re-attaching an id replaces the previous meter cleanly', () => {
    const bank = new MeterBank();
    bank.attach('mix-1', tone(0.9));
    bank.sample(0.05);
    bank.attach('mix-1', tone(0.1));
    bank.sample(0.1);
    expect(bank.ids).toEqual(['mix-1']);
    expect(bank.reading('mix-1')?.peak).toBeLessThanOrEqual(0.9);
  });

  it('clears every meter for a transport stop', () => {
    const bank = new MeterBank();
    bank.attach('mix-1', tone(0.7));
    bank.sample(0.05);
    bank.reset();
    expect(bank.reading('mix-1')).toEqual(emptyMeterReading());
    expect(bank.sampleCount).toBe(0);
    expect(bank.has('mix-1')).toBe(true);
  });
});
