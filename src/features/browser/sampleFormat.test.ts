import { describe, expect, it } from 'vitest';
import { describeAsset, formatBytes, formatChannels, formatDuration, formatGain, formatSampleRate, parseSeconds } from './sampleFormat';
import { cutoffFromSlider, sliderFromCutoff } from '../instrument/SynthEditor';

describe('sample metadata labels', () => {
  it('formats duration with three decimals and a dash for invalid values', () => {
    expect(formatDuration(0.25)).toBe('0.250 s');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });

  it('formats sizes, sample rates, and channel layouts, omitting unknown values', () => {
    expect(formatBytes(22096)).toBe('22 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(undefined)).toBeNull();
    expect(formatSampleRate(44100)).toBe('44.1 kHz');
    expect(formatSampleRate(48000)).toBe('48 kHz');
    expect(formatSampleRate(0)).toBeNull();
    expect(formatChannels(1)).toBe('mono');
    expect(formatChannels(2)).toBe('stereo');
    expect(formatChannels(6)).toBe('6 ch');
  });

  it('joins known metadata into one line', () => {
    expect(describeAsset({ durationSeconds: 0.25, sampleRate: 48000, channels: 1, bytes: 22096, format: 'wav' })).toBe('0.250 s · 48 kHz · mono · 22 KB · WAV');
    expect(describeAsset({ durationSeconds: 1 })).toBe('1.000 s');
  });

  it('shows gain as a percentage and decibels, and zero as silent', () => {
    expect(formatGain(1)).toBe('100% · +0.0 dB');
    expect(formatGain(0.5)).toBe('50% · -6.0 dB');
    expect(formatGain(0)).toBe('0% · silent');
  });

  it('parses typed seconds strictly', () => {
    expect(parseSeconds(' 0.5 ')).toBe(0.5);
    expect(parseSeconds('')).toBeNull();
    expect(parseSeconds('abc')).toBeNull();
    expect(parseSeconds('Infinity')).toBeNull();
  });
});

describe('filter cutoff slider', () => {
  it('maps the slider logarithmically across 40 Hz to 20 kHz and round-trips', () => {
    expect(cutoffFromSlider(0)).toBeCloseTo(40, 6);
    expect(cutoffFromSlider(1000)).toBeCloseTo(20000, 3);
    // Each slider step is the same ratio, so an octave takes the same travel anywhere in the range.
    const low = sliderFromCutoff(80) - sliderFromCutoff(40);
    const high = sliderFromCutoff(10240) - sliderFromCutoff(5120);
    expect(Math.abs(low - high)).toBeLessThanOrEqual(1);
    expect(Math.abs(cutoffFromSlider(sliderFromCutoff(3200)) - 3200)).toBeLessThan(5);
  });
});
