import { describe, expect, it } from 'vitest';
import {
  MAX_SAMPLE_BYTES,
  SampleLoadError,
  SampleStore,
  isSupportedAudioFile,
  loadSampleFile,
  type SampleFile,
} from './sampleStore';

function audioFile(overrides: Partial<SampleFile> = {}): SampleFile {
  return {
    name: 'kick.wav',
    size: 1024,
    type: 'audio/wav',
    arrayBuffer: async () => new ArrayBuffer(1024),
    ...overrides,
  };
}

function fakeBuffer(durationSeconds = 0.25) {
  return { length: Math.round(48000 * durationSeconds), duration: durationSeconds } as unknown as AudioBuffer;
}

describe('sample file support checks', () => {
  it('accepts known audio extensions and audio/* mime types', () => {
    expect(isSupportedAudioFile('loop.mp3')).toBe(true);
    expect(isSupportedAudioFile('LOOP.WAV')).toBe(true);
    expect(isSupportedAudioFile('take.flac')).toBe(true);
    expect(isSupportedAudioFile('mystery.bin', 'audio/ogg')).toBe(true);
    expect(isSupportedAudioFile('notes.txt')).toBe(false);
    expect(isSupportedAudioFile('archive.zip', 'application/zip')).toBe(false);
    expect(isSupportedAudioFile('noextension')).toBe(false);
  });
});

describe('loading samples', () => {
  it('decodes a supported file and registers it under a stable id', async () => {
    const store = new SampleStore(async () => fakeBuffer(0.5));
    const sample = await store.add(audioFile());

    expect(sample.id).toMatch(/^sample-/);
    expect(sample.name).toBe('kick.wav');
    expect(sample.durationSeconds).toBeCloseTo(0.5, 6);
    expect(store.get(sample.id)).not.toBeNull();
    expect(store.getSample(sample.id)?.name).toBe('kick.wav');
    expect(store.size()).toBe(1);
  });

  it('rejects unsupported files with a clear message', async () => {
    const store = new SampleStore(async () => fakeBuffer());
    await expect(store.add(audioFile({ name: 'readme.txt', type: 'text/plain' }))).rejects.toThrow(
      /not a supported audio file/,
    );
    expect(store.size()).toBe(0);
  });

  it('rejects empty and oversized files before decoding', async () => {
    const store = new SampleStore(async () => fakeBuffer());
    await expect(store.add(audioFile({ size: 0 }))).rejects.toThrow(SampleLoadError);
    await expect(store.add(audioFile({ size: 0 }))).rejects.toThrow(/is empty/);
    await expect(store.add(audioFile({ size: MAX_SAMPLE_BYTES + 1 }))).rejects.toThrow(/larger than 64 MB/);
    expect(store.size()).toBe(0);
  });

  it('surfaces decode failures as actionable errors', async () => {
    const store = new SampleStore(async () => {
      const error = new Error('EncodingError');
      error.name = 'EncodingError';
      throw error;
    });
    await expect(store.add(audioFile())).rejects.toThrow(/could not be decoded/);
    expect(store.size()).toBe(0);
  });

  it('rejects zero-length reads and empty decode results', async () => {
    const shortRead = new SampleStore(async () => fakeBuffer());
    await expect(
      shortRead.add(
        audioFile({
          arrayBuffer: async () => new ArrayBuffer(0),
        }),
      ),
    ).rejects.toThrow(/is empty/);

    const emptyDecode = new SampleStore(async () => ({ length: 0, duration: 0 }) as unknown as AudioBuffer);
    await expect(emptyDecode.add(audioFile())).rejects.toThrow(/decoded to empty audio/);
  });

  it('reports read failures without crashing the app', async () => {
    const store = new SampleStore(async () => fakeBuffer());
    await expect(
      store.add(
        audioFile({
          arrayBuffer: async () => {
            throw new Error('disk gone');
          },
        }),
      ),
    ).rejects.toThrow(/could not be read/);
  });

  it('resolves unknown ids to null and can be cleared', async () => {
    const store = new SampleStore(async () => fakeBuffer());
    expect(store.get(undefined)).toBeNull();
    expect(store.get('missing')).toBeNull();
    expect(store.has('missing')).toBe(false);
    const sample = await store.add(audioFile());
    expect(store.has(sample.id)).toBe(true);
    store.clear();
    expect(store.get(sample.id)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('loadSampleFile keeps the id it was given', async () => {
    const sample = await loadSampleFile('sample-fixed', audioFile(), async () => fakeBuffer(0.1));
    expect(sample.id).toBe('sample-fixed');
    expect(loadSampleFile).toBeTypeOf('function');
  });
});


describe('Playlist waveform metadata', () => {
  it('builds bounded peaks from all decoded channels without storing PCM samples', async () => {
    const { buildWaveformPeaks } = await import('./sampleStore');
    const buffer = { numberOfChannels: 2, getChannelData: (channel: number) => channel === 0 ? new Float32Array([0, 0.25, -0.5, 0]) : new Float32Array([0.75, 0, 0, -1]) } as AudioBuffer;
    expect(buildWaveformPeaks(buffer, 2)).toEqual([0.75, 1]);
    expect(buildWaveformPeaks(buffer, 1000)).toHaveLength(256);
    expect(buildWaveformPeaks(buffer, NaN)).toHaveLength(96);
  });
});
