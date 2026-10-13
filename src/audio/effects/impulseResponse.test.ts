import { describe, expect, it } from 'vitest';
import { createSeededRandom, generateReverbImpulse, getCachedReverbImpulse, MAX_IMPULSE_SECONDS } from './impulseResponse';

function rms(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / Math.max(1, to - from));
}

describe('reverb impulse response', () => {
  it('is deterministic for the same decay and sample rate', () => {
    const first = generateReverbImpulse(1.8, 48000);
    const second = generateReverbImpulse(1.8, 48000);
    expect(Array.from(first.channels[0])).toEqual(Array.from(second.channels[0]));
    expect(Array.from(first.channels[1])).toEqual(Array.from(second.channels[1]));
  });

  it('has a length that matches the decay and a stereo pair of channels', () => {
    const impulse = generateReverbImpulse(2, 44100);
    expect(impulse.length).toBe(88200);
    expect(impulse.channels[0].length).toBe(88200);
    expect(impulse.channels[1].length).toBe(88200);
    expect(impulse.sampleRate).toBe(44100);
  });

  it('decorrelates the two channels so the reverb is stereo', () => {
    const impulse = generateReverbImpulse(1, 48000);
    const [left, right] = impulse.channels;
    let same = 0;
    for (let index = 0; index < left.length; index += 1) if (left[index] === right[index]) same += 1;
    expect(same / left.length).toBeLessThan(0.01);
  });

  it('decays: the tail is quieter than the start', () => {
    const impulse = generateReverbImpulse(2, 48000);
    const start = rms(impulse.channels[0], 0, 4800);
    const end = rms(impulse.channels[0], impulse.length - 4800, impulse.length);
    expect(end).toBeLessThan(start * 0.1);
  });

  it('clamps the decay to the supported maximum and minimum', () => {
    expect(generateReverbImpulse(60, 8000).length).toBe(Math.round(MAX_IMPULSE_SECONDS * 8000));
    expect(generateReverbImpulse(0, 8000).length).toBe(Math.round(0.05 * 8000));
    expect(generateReverbImpulse(Number.NaN, 8000).length).toBe(8000);
  });

  it('rejects a non-positive sample rate', () => {
    expect(() => generateReverbImpulse(1, 0)).toThrow(/sample rate/);
    expect(() => generateReverbImpulse(1, Number.NaN)).toThrow(/sample rate/);
  });

  it('keeps every sample finite and within the unit range', () => {
    const impulse = generateReverbImpulse(3, 48000);
    for (const channel of impulse.channels) {
      for (let index = 0; index < channel.length; index += 7) {
        expect(Number.isFinite(channel[index])).toBe(true);
        expect(Math.abs(channel[index])).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('seeded random', () => {
  it('produces the same sequence for the same seed and values in [-1, 1)', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const first = Array.from({ length: 16 }, () => a());
    expect(first).toEqual(Array.from({ length: 16 }, () => b()));
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('cached reverb impulse', () => {
  it('returns the same impulse for the same decay and rate, and a new one for a new rate', () => {
    const a = getCachedReverbImpulse(1.5, 48000);
    expect(getCachedReverbImpulse(1.5, 48000)).toBe(a);
    expect(getCachedReverbImpulse(1.5, 44100)).not.toBe(a);
  });

  it('matches a fresh generation, so caching cannot change the sound', () => {
    const cached = getCachedReverbImpulse(0.8, 48000);
    const fresh = generateReverbImpulse(0.8, 48000);
    expect(Array.from(cached.channels[0])).toEqual(Array.from(fresh.channels[0]));
  });
});
