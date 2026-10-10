import type { SampleFile, LoadedSample } from './sampleStore';

/**
 * Built-in sample packs. A pack is a static manifest under `public/samples/` that lists each file
 * with its size and SHA-256, plus its license. Packs load through the same import path as user
 * files, so a pack sample that is already in the library reuses its decoded buffer.
 */

export const SAMPLE_PACK_FORMAT = 'gridline-sample-pack' as const;
export const SAMPLE_PACK_VERSION = 1 as const;

export interface SamplePackLicense {
  /** SPDX-style identifier, e.g. `CC0-1.0`. */
  id: string;
  name: string;
  url: string;
  /** Licence text shipped with the pack, relative to the manifest. */
  file: string;
  sha256: string;
  attributionRequired: boolean;
}

export interface SamplePackSample {
  id: string;
  name: string;
  category: string;
  /** Path relative to the manifest directory. */
  file: string;
  bytes: number;
  sha256: string;
  /** Where the bytes came from, for provenance. Not fetched at runtime. */
  upstream: string;
}

export interface SamplePackManifest {
  format: typeof SAMPLE_PACK_FORMAT;
  version: typeof SAMPLE_PACK_VERSION;
  id: string;
  name: string;
  description: string;
  license: SamplePackLicense;
  attribution: string;
  source: { name: string; url: string; commit: string; retrieved: string };
  samples: SamplePackSample[];
}

export class SamplePackError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SamplePackError';
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new SamplePackError(`${label} is missing.`);
  return value;
}

/** Relative paths only: no drive letters, leading slashes, backslashes, or parent segments. */
export function isSafePackPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[a-z]+:/i.test(path)) return false;
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** Parse and validate a manifest. Any malformed field is reported by name. */
export function parseSamplePackManifest(text: string): SamplePackManifest {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (error) {
    throw new SamplePackError('The sample pack manifest is not valid JSON.', { cause: error });
  }
  if (!isRecord(data)) throw new SamplePackError('The sample pack manifest must be an object.');
  if (data.format !== SAMPLE_PACK_FORMAT) throw new SamplePackError('This file is not a Gridline sample pack.');
  if (data.version !== SAMPLE_PACK_VERSION) throw new SamplePackError(`Unsupported sample pack version: ${String(data.version)}.`);
  requireString(data, 'id', 'Pack ID');
  requireString(data, 'name', 'Pack name');
  requireString(data, 'attribution', 'Pack attribution');

  const license = data.license;
  if (!isRecord(license)) throw new SamplePackError('The pack license is missing.');
  requireString(license, 'id', 'License identifier');
  requireString(license, 'name', 'License name');
  requireString(license, 'url', 'License URL');
  requireString(license, 'file', 'License file');
  if (!isSafePackPath(String(license.file))) throw new SamplePackError('The license file path is not allowed.');
  if (typeof license.sha256 !== 'string' || !SHA256_PATTERN.test(license.sha256)) throw new SamplePackError('The license checksum is invalid.');
  if (typeof license.attributionRequired !== 'boolean') throw new SamplePackError('The license attribution flag must be a boolean.');

  const source = data.source;
  if (!isRecord(source)) throw new SamplePackError('The pack source is missing.');
  requireString(source, 'name', 'Source name');
  requireString(source, 'url', 'Source URL');
  requireString(source, 'commit', 'Source commit');

  if (!Array.isArray(data.samples) || data.samples.length === 0) throw new SamplePackError('The sample pack has no samples.');
  const ids = new Set<string>();
  const samples: SamplePackSample[] = data.samples.map((item) => {
    if (!isRecord(item)) throw new SamplePackError('A pack sample entry is not an object.');
    const id = requireString(item, 'id', 'Sample ID');
    if (ids.has(id)) throw new SamplePackError(`Sample ID "${id}" appears more than once.`);
    ids.add(id);
    const file = requireString(item, 'file', `Sample ${id} file`);
    if (!isSafePackPath(file)) throw new SamplePackError(`Sample ${id} has an unsafe file path.`);
    if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) <= 0) throw new SamplePackError(`Sample ${id} size is invalid.`);
    if (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) throw new SamplePackError(`Sample ${id} checksum is invalid.`);
    return {
      id,
      name: requireString(item, 'name', `Sample ${id} name`),
      category: requireString(item, 'category', `Sample ${id} category`),
      file,
      bytes: Number(item.bytes),
      sha256: item.sha256,
      upstream: requireString(item, 'upstream', `Sample ${id} upstream path`),
    };
  });

  return {
    format: SAMPLE_PACK_FORMAT,
    version: SAMPLE_PACK_VERSION,
    id: String(data.id),
    name: String(data.name),
    description: typeof data.description === 'string' ? data.description : '',
    license: {
      id: String(license.id),
      name: String(license.name),
      url: String(license.url),
      file: String(license.file),
      sha256: license.sha256,
      attributionRequired: license.attributionRequired,
    },
    attribution: String(data.attribution),
    source: { name: String(source.name), url: String(source.url), commit: String(source.commit), retrieved: typeof source.retrieved === 'string' ? source.retrieved : '' },
    samples,
  };
}

/** Join a base URL (such as `import.meta.env.BASE_URL + 'samples/'`) with a manifest-relative path. */
export function samplePackFileUrl(baseUrl: string, relativePath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Lower-case hex SHA-256 of bytes. Requires SubtleCrypto (secure contexts only). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new SamplePackError('This browser cannot verify sample checksums.');
  const digest = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Check downloaded bytes against the manifest before they are decoded or added. */
export async function verifyPackSample(sample: SamplePackSample, data: ArrayBuffer, hash: (data: ArrayBuffer) => Promise<string> = sha256Hex): Promise<void> {
  if (data.byteLength !== sample.bytes) {
    throw new SamplePackError(`${sample.name} is ${data.byteLength} bytes, expected ${sample.bytes}. The pack may be corrupt.`);
  }
  const actual = await hash(data);
  if (actual !== sample.sha256) {
    throw new SamplePackError(`${sample.name} failed its checksum. The pack may be corrupt; reload the page.`);
  }
}

export interface SamplePackLoadOptions {
  baseUrl: string;
  manifest: SamplePackManifest;
  fetchBytes: (url: string) => Promise<ArrayBuffer>;
  importFile: (file: SampleFile) => Promise<LoadedSample>;
  /** Checksum function; defaults to SHA-256. Pass `null` to skip verification where crypto is unavailable. */
  hash?: ((data: ArrayBuffer) => Promise<string>) | null;
}

/**
 * Load every sample in a pack into the library. Each file is verified, then imported through the
 * same path as a user file. A failure stops the load and names the file that caused it.
 */
export async function loadSamplePack(options: SamplePackLoadOptions): Promise<LoadedSample[]> {
  const loaded: LoadedSample[] = [];
  for (const sample of options.manifest.samples) {
    const url = samplePackFileUrl(options.baseUrl, sample.file);
    let data: ArrayBuffer;
    try {
      data = await options.fetchBytes(url);
    } catch (error) {
      throw new SamplePackError(`${sample.name} could not be downloaded.`, { cause: error });
    }
    if (options.hash !== null) {
      await verifyPackSample(sample, data, options.hash ?? sha256Hex);
    }
    const file = new File([data], `${sample.name}.wav`, { type: 'audio/wav' });
    loaded.push(await options.importFile(file));
  }
  return loaded;
}
