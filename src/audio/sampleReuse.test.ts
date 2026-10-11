import { describe, expect, it, vi } from 'vitest';
import { SampleStore, type SampleFile } from './sampleStore';

function fileWith(name: string, text: string): SampleFile {
  const data = new TextEncoder().encode(text);
  return {
    name,
    size: data.byteLength,
    type: 'audio/wav',
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  };
}

/** Fake decoder that records every call, so tests can count real decodes. */
function makeStore() {
  const decode = vi.fn(async (data: ArrayBuffer) => {
    const length = Math.max(1, new Uint8Array(data).length * 10);
    return { length, duration: length / 48000, numberOfChannels: 1, sampleRate: 48000 } as unknown as AudioBuffer;
  });
  const hashes = new Map<string, string>();
  // Deterministic content hash: identical text gives an identical hash, so reuse is observable.
  const hasher = vi.fn(async (data: ArrayBuffer) => {
    const text = new TextDecoder().decode(data);
    const hash = `test:${text}`;
    hashes.set(text, hash);
    return hash;
  });
  return { store: new SampleStore(decode, hasher), decode, hasher };
}

describe('sample identity and reuse', () => {
  it('decodes identical bytes once and returns the same buffer for every reuse', async () => {
    const { store, decode } = makeStore();
    const first = await store.import(fileWith('kick.wav', 'same-bytes'));
    const second = await store.import(fileWith('kick copy.wav', 'same-bytes'));

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.sample.id).toBe(first.sample.id);
    expect(second.sample.buffer).toBe(first.sample.buffer);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(store.size()).toBe(1);
  });

  it('keeps distinct content as distinct assets', async () => {
    const { store, decode } = makeStore();
    const a = await store.import(fileWith('a.wav', 'alpha'));
    const b = await store.import(fileWith('b.wav', 'beta'));
    expect(a.sample.id).not.toBe(b.sample.id);
    expect(a.sample.buffer).not.toBe(b.sample.buffer);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('records the content hash, format, size, and channel metadata used by the library', async () => {
    const { store } = makeStore();
    const { sample } = await store.import(fileWith('Snare.WAV', 'snare-bytes'));
    expect(sample.contentHash).toBe('test:snare-bytes');
    expect(sample.format).toBe('wav');
    expect(sample.bytes).toBe('snare-bytes'.length);
    expect(sample.name).toBe('Snare.WAV');
    expect(store.findByHash('test:snare-bytes')?.id).toBe(sample.id);
  });

  it('relinks a missing asset: the same bytes come back under the original asset id', async () => {
    const { store, decode } = makeStore();
    const original = await store.import(fileWith('loop.wav', 'loop-bytes'));
    // The session is reset (a reload): the project still references the asset id, but the buffer is gone.
    store.clear();
    expect(store.has(original.sample.id)).toBe(false);

    const relinked = await store.import(fileWith('loop.wav', 'loop-bytes'), {
      assetIdForHash: (hash) => (hash === 'test:loop-bytes' ? original.sample.id : undefined),
    });
    expect(relinked.sample.id).toBe(original.sample.id);
    expect(relinked.reused).toBe(false);
    expect(store.has(original.sample.id)).toBe(true);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('does not let a relink request overwrite a different loaded asset', async () => {
    const { store } = makeStore();
    const live = await store.import(fileWith('live.wav', 'live'));
    const other = await store.import(fileWith('other.wav', 'other'), {
      // A stale project reference points at the live asset's id.
      assetIdForHash: () => live.sample.id,
    });
    expect(other.sample.id).not.toBe(live.sample.id);
    expect(store.get(live.sample.id)).toBe(live.sample.buffer);
  });

  it('a missing id resolves to null, so callers can show a missing-file state', async () => {
    const { store } = makeStore();
    expect(store.get('asset-that-was-never-imported')).toBeNull();
    expect(store.has('asset-that-was-never-imported')).toBe(false);
  });

  it('a failed decode leaves nothing registered, so the file can be retried', async () => {
    const decode = vi
      .fn<(data: ArrayBuffer) => Promise<AudioBuffer>>()
      .mockRejectedValueOnce(new Error('bad data'))
      .mockImplementationOnce(async () => ({ length: 100, duration: 0.01, numberOfChannels: 1, sampleRate: 48000 }) as unknown as AudioBuffer);
    const store = new SampleStore(decode, async () => 'test:retry');
    await expect(store.import(fileWith('retry.wav', 'retry'))).rejects.toThrow();
    expect(store.size()).toBe(0);
    const result = await store.import(fileWith('retry.wav', 'retry'));
    expect(result.reused).toBe(false);
    expect(store.size()).toBe(1);
  });

  it('clear() releases every decoded buffer', async () => {
    const { store } = makeStore();
    await store.import(fileWith('a.wav', 'a'));
    await store.import(fileWith('b.wav', 'b'));
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.totalDecodedBytes()).toBe(0);
  });
});
