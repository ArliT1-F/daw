import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  SamplePackError,
  isSafePackPath,
  loadSamplePack,
  parseSamplePackManifest,
  samplePackFileUrl,
  sha256Hex,
  verifyPackSample,
  type SamplePackManifest,
} from './samplePack';
import type { LoadedSample } from './sampleStore';

const HEX = 'a'.repeat(64);

function validManifest(overrides: Record<string, unknown> = {}, sampleOverrides: Record<string, unknown> = {}) {
  return {
    format: 'gridline-sample-pack',
    version: 1,
    id: 'test-pack',
    name: 'Test Pack',
    description: 'Fixture',
    license: {
      id: 'CC0-1.0',
      name: 'CC0',
      url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      file: 'LICENSE.txt',
      sha256: HEX,
      attributionRequired: false,
    },
    attribution: 'Test author',
    source: { name: 'Upstream', url: 'https://example.com/repo', commit: 'abc123', retrieved: '2026-10-10' },
    samples: [
      {
        id: 'kick',
        name: 'Kick',
        category: 'kick',
        file: 'kick.wav',
        bytes: 4,
        sha256: HEX,
        upstream: 'bd/KICK.WAV',
        ...sampleOverrides,
      },
    ],
    ...overrides,
  };
}

function manifestText(overrides?: Record<string, unknown>, sampleOverrides?: Record<string, unknown>): string {
  return JSON.stringify(validManifest(overrides, sampleOverrides));
}

function bytes(text: string): ArrayBuffer {
  const data = new TextEncoder().encode(text);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

describe('manifest parsing', () => {
  it('accepts a complete manifest', () => {
    const parsed = parseSamplePackManifest(manifestText());
    expect(parsed.id).toBe('test-pack');
    expect(parsed.samples).toEqual([
      { id: 'kick', name: 'Kick', category: 'kick', file: 'kick.wav', bytes: 4, sha256: HEX, upstream: 'bd/KICK.WAV' },
    ]);
    expect(parsed.license.attributionRequired).toBe(false);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseSamplePackManifest('{oops')).toThrow(/not valid JSON/);
  });

  it('rejects other formats and unsupported versions', () => {
    expect(() => parseSamplePackManifest(manifestText({ format: 'gridline-synth-preset' }))).toThrow(/not a Gridline sample pack/);
    expect(() => parseSamplePackManifest(manifestText({ version: 2 }))).toThrow(/Unsupported sample pack version: 2/);
  });

  it('rejects missing identity, attribution, and source fields by name', () => {
    expect(() => parseSamplePackManifest(manifestText({ id: '' }))).toThrow(/Pack ID is missing/);
    expect(() => parseSamplePackManifest(manifestText({ attribution: undefined }))).toThrow(/Pack attribution is missing/);
    expect(() => parseSamplePackManifest(manifestText({ source: undefined }))).toThrow(/pack source is missing/);
    expect(() => parseSamplePackManifest(manifestText({ source: { name: 'x', url: 'y' } }))).toThrow(/Source commit is missing/);
  });

  it('rejects a missing or incomplete license', () => {
    expect(() => parseSamplePackManifest(manifestText({ license: undefined }))).toThrow(/license is missing/);
    expect(() => parseSamplePackManifest(manifestText({ license: { ...validManifest().license, url: '' } }))).toThrow(/License URL is missing/);
    expect(() => parseSamplePackManifest(manifestText({ license: { ...validManifest().license, sha256: 'not-hex' } }))).toThrow(/checksum is invalid/);
    expect(() => parseSamplePackManifest(manifestText({ license: { ...validManifest().license, attributionRequired: 'no' } }))).toThrow(/must be a boolean/);
  });

  it('rejects a pack with no samples or duplicate sample ids', () => {
    expect(() => parseSamplePackManifest(manifestText({ samples: [] }))).toThrow(/no samples/);
    const sample = validManifest().samples[0];
    expect(() => parseSamplePackManifest(manifestText({ samples: [sample, sample] }))).toThrow(/appears more than once/);
  });

  it('rejects unsafe file paths for samples and the license', () => {
    for (const file of ['/etc/passwd', '../secret.wav', 'a/../b.wav', 'C:evil.wav', 'sub\\x.wav', '', './x.wav']) {
      expect(() => parseSamplePackManifest(manifestText({}, { file }))).toThrow(SamplePackError);
    }
    expect(() => parseSamplePackManifest(manifestText({ license: { ...validManifest().license, file: '../LICENSE' } }))).toThrow(/license file path is not allowed/);
  });

  it('rejects invalid sizes and checksums for samples', () => {
    expect(() => parseSamplePackManifest(manifestText({}, { bytes: 0 }))).toThrow(/size is invalid/);
    expect(() => parseSamplePackManifest(manifestText({}, { bytes: 1.5 }))).toThrow(/size is invalid/);
    expect(() => parseSamplePackManifest(manifestText({}, { sha256: 'ABC' }))).toThrow(/checksum is invalid/);
  });

  it('requires upstream provenance for every sample', () => {
    expect(() => parseSamplePackManifest(manifestText({}, { upstream: '' }))).toThrow(/upstream path is missing/);
  });

  it('accepts only relative, normal paths', () => {
    expect(isSafePackPath('808/kick.wav')).toBe(true);
    expect(isSafePackPath('kick-short.wav')).toBe(true);
    expect(isSafePackPath('../x')).toBe(false);
    expect(isSafePackPath('/abs')).toBe(false);
    expect(isSafePackPath('https://evil/x')).toBe(false);
    expect(isSafePackPath('')).toBe(false);
  });

  it('builds file URLs under the pack base and encodes each segment', () => {
    expect(samplePackFileUrl('/samples/808/', 'kick short.wav')).toBe('/samples/808/kick%20short.wav');
    expect(samplePackFileUrl('/samples/808', 'a/b.wav')).toBe('/samples/808/a/b.wav');
  });
});

describe('checksums', () => {
  it('computes lower-case SHA-256 hex', async () => {
    const data = bytes('abc');
    expect(await sha256Hex(data)).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('accepts bytes that match the manifest', async () => {
    const data = bytes('abcd');
    const sample = parseSamplePackManifest(manifestText({}, { bytes: 4, sha256: createHash('sha256').update('abcd').digest('hex') })).samples[0];
    await expect(verifyPackSample(sample, data)).resolves.toBeUndefined();
  });

  it('rejects a file whose size differs from the manifest', async () => {
    const sample = parseSamplePackManifest(manifestText()).samples[0];
    await expect(verifyPackSample(sample, bytes('abcdef'), async () => HEX)).rejects.toThrow(/6 bytes, expected 4/);
  });

  it('rejects a checksum mismatch and names the file', async () => {
    const sample = parseSamplePackManifest(manifestText()).samples[0];
    await expect(verifyPackSample(sample, bytes('abcd'), async () => 'b'.repeat(64))).rejects.toThrow(/Kick failed its checksum/);
  });
});

describe('loadSamplePack', () => {
  function manifest(): SamplePackManifest {
    const sha256 = createHash('sha256').update('abcd').digest('hex');
    return parseSamplePackManifest(
      manifestText({ samples: [
        { id: 'kick', name: 'Kick', category: 'kick', file: 'kick.wav', bytes: 4, sha256, upstream: 'bd/KICK.WAV' },
        { id: 'snare', name: 'Snare', category: 'snare', file: 'snare.wav', bytes: 4, sha256, upstream: 'sd/SNARE.WAV' },
      ] }),
    );
  }

  function fakeSample(id: string, name: string): LoadedSample {
    return { id, name, buffer: {} as AudioBuffer, durationSeconds: 0.1, contentHash: 'sha256:x', format: 'wav', bytes: 4, sampleRate: 48000, channels: 1 };
  }

  it('fetches each file from the base URL, verifies it, and imports it in order', async () => {
    const fetchBytes = vi.fn(async (_url: string) => bytes('abcd'));
    const imported: File[] = [];
    const importFile = vi.fn(async (file: { name: string }) => {
      imported.push(file as unknown as File);
      return fakeSample(file.name, file.name);
    });
    const loaded = await loadSamplePack({ baseUrl: '/samples/808/', manifest: manifest(), fetchBytes, importFile, hash: async () => createHash('sha256').update('abcd').digest('hex') });

    expect(fetchBytes.mock.calls.map((call) => call[0])).toEqual(['/samples/808/kick.wav', '/samples/808/snare.wav']);
    expect(loaded.map((sample) => sample.id)).toEqual(['Kick.wav', 'Snare.wav']);
    expect(imported.map((file) => file.type)).toEqual(['audio/wav', 'audio/wav']);
  });

  it('stops at the first sample that fails verification and names it', async () => {
    const importFile = vi.fn(async (file: { name: string }) => fakeSample(file.name, file.name));
    await expect(
      loadSamplePack({ baseUrl: '/samples/808/', manifest: manifest(), fetchBytes: async () => bytes('abcd'), importFile, hash: async () => 'c'.repeat(64) }),
    ).rejects.toThrow(/Kick failed its checksum/);
    expect(importFile).not.toHaveBeenCalled();
  });

  it('reports a download failure with the sample name', async () => {
    await expect(
      loadSamplePack({
        baseUrl: '/samples/808/',
        manifest: manifest(),
        fetchBytes: async () => {
          throw new Error('HTTP 404');
        },
        importFile: async () => fakeSample('x', 'x'),
        hash: null,
      }),
    ).rejects.toThrow(/Kick could not be downloaded/);
  });

  it('skips checksum verification only when the hash is explicitly disabled', async () => {
    const importFile = vi.fn(async (file: { name: string }) => fakeSample(file.name, file.name));
    await loadSamplePack({ baseUrl: '/s/', manifest: manifest(), fetchBytes: async () => bytes('abcd'), importFile, hash: null });
    expect(importFile).toHaveBeenCalledTimes(2);
  });
});

describe('the shipped 808 starter kit', () => {
  const packDir = fileURLToPath(new URL('../../public/samples/808/', import.meta.url));
  const manifest = parseSamplePackManifest(readFileSync(`${packDir}manifest.json`, 'utf8'));

  it('lists seven CC0 samples with files that match their checksums and sizes', () => {
    expect(manifest.id).toBe('gridline-808-starter');
    expect(manifest.license.id).toBe('CC0-1.0');
    expect(manifest.samples).toHaveLength(7);
    for (const sample of manifest.samples) {
      const data = readFileSync(`${packDir}${sample.file}`);
      expect(data.byteLength, sample.file).toBe(sample.bytes);
      expect(createHash('sha256').update(data).digest('hex'), sample.file).toBe(sample.sha256);
    }
  });

  it('ships the license text, and the file matches the license checksum in the manifest', () => {
    const license = readFileSync(`${packDir}${manifest.license.file}`);
    expect(createHash('sha256').update(license).digest('hex')).toBe(manifest.license.sha256);
    expect(license.toString('utf8')).toMatch(/CC0 1\.0 Universal/);
  });

  it('records the upstream source and commit for every sample', () => {
    expect(manifest.source.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const sample of manifest.samples) expect(sample.upstream).toMatch(/\.(WAV)$/i);
  });
});
