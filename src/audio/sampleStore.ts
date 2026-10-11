import { createStableId } from '../core/project/model';

/**
 * Runtime registry for decoded user samples.
 *
 * Decoded `AudioBuffer`s are browser audio objects and never enter the project document. The
 * project stores a stable asset id plus metadata (name, duration, format, and a content hash) on
 * each asset. The store keeps one buffer per id for the session:
 *  - importing bytes that are already loaded reuses the existing buffer without decoding again;
 *  - a file whose hash matches a project asset that has lost its buffer is relinked to that id;
 *  - voices resolve ids through `get`, and a missing id is reported as missing, never substituted.
 */

export interface LoadedSample {
  id: string;
  name: string;
  buffer: AudioBuffer;
  durationSeconds: number;
  /** Identity of the file's bytes, such as `sha256:<hex>`. */
  contentHash: string;
  /** Lower-case extension, or the MIME type when the name has none. */
  format: string;
  bytes: number;
  /** Decoded sample rate, or 0 when the browser did not report one. */
  sampleRate: number;
  channels: number;
}

/** Anything File-like, so tests can pass plain objects. */
export interface SampleFile {
  name: string;
  size: number;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type SampleDecodeFunction = (data: ArrayBuffer) => Promise<AudioBuffer>;
/** Hashes the raw bytes of a file. Injectable so tests and older browsers can supply their own. */
export type ContentHasher = (data: ArrayBuffer) => Promise<string>;

export class SampleLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SampleLoadError';
  }
}

/** Extensions the loader will attempt to decode. */
export const SUPPORTED_SAMPLE_EXTENSIONS = ['wav', 'mp3', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'webm', 'aif', 'aiff'] as const;

export const MAX_SAMPLE_BYTES = 64 * 1024 * 1024;

export function isSupportedAudioFile(name: string, type?: string): boolean {
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if ((SUPPORTED_SAMPLE_EXTENSIONS as readonly string[]).includes(extension)) return true;
  return Boolean(type && type.startsWith('audio/'));
}

function quoted(name: string): string {
  return `“${name}”`;
}

function fileFormat(name: string, type?: string): string {
  if (name.includes('.')) return name.split('.').pop()!.toLowerCase();
  return (type ?? 'unknown').toLowerCase();
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** FNV-1a, 32-bit. A fallback for hosts without SubtleCrypto; identifies files, not secrets. */
function fnv1a32(data: ArrayBuffer): string {
  let hash = 0x811c9dc5;
  const bytes = new Uint8Array(data);
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Default content hash: SHA-256 when SubtleCrypto exists, otherwise FNV-1a 32-bit. */
export const defaultContentHasher: ContentHasher = async (data) => {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) {
    try {
      return `sha256:${toHex(await subtle.digest('SHA-256', data))}`;
    } catch {
      /* fall through to the non-cryptographic identity */
    }
  }
  return `fnv1a32:${fnv1a32(data)}`;
};

export interface PreparedSampleFile {
  name: string;
  format: string;
  bytes: number;
  data: ArrayBuffer;
  contentHash: string;
}

/** Validate and read one file, and hash its bytes. Decoding is a separate step. */
export async function readSampleFile(file: SampleFile, hasher: ContentHasher = defaultContentHasher): Promise<PreparedSampleFile> {
  const name = file.name?.trim();
  if (!name) throw new SampleLoadError('The file has no name.');
  if (!isSupportedAudioFile(name, file.type)) {
    throw new SampleLoadError(
      `${quoted(name)} is not a supported audio file. Try WAV, MP3, OGG, FLAC, or M4A.`,
    );
  }
  if (!file.size) throw new SampleLoadError(`${quoted(name)} is empty.`);
  if (file.size > MAX_SAMPLE_BYTES) {
    throw new SampleLoadError(`${quoted(name)} is larger than ${Math.round(MAX_SAMPLE_BYTES / (1024 * 1024))} MB.`);
  }

  let data: ArrayBuffer;
  try {
    data = await file.arrayBuffer();
  } catch (error) {
    throw new SampleLoadError(`${quoted(name)} could not be read.`, { cause: error });
  }
  if (!data || data.byteLength === 0) {
    throw new SampleLoadError(`${quoted(name)} is empty.`);
  }
  const contentHash = await hasher(data);
  return { name, format: fileFormat(name, file.type), bytes: data.byteLength, data, contentHash };
}

async function decodePrepared(prepared: PreparedSampleFile, decode: SampleDecodeFunction): Promise<AudioBuffer> {
  const quotedName = quoted(prepared.name);
  let buffer: AudioBuffer;
  try {
    buffer = await decode(prepared.data);
  } catch (error) {
    throw new SampleLoadError(
      `${quotedName} could not be decoded. The format may not be supported by this browser; try exporting it as WAV.`,
      { cause: error },
    );
  }
  if (!buffer || typeof buffer.length !== 'number' || buffer.length === 0) {
    throw new SampleLoadError(`${quotedName} decoded to empty audio.`);
  }
  return buffer;
}

function toLoadedSample(id: string, prepared: PreparedSampleFile, buffer: AudioBuffer): LoadedSample {
  const durationSeconds = Number.isFinite(buffer.duration) ? buffer.duration : 0;
  return {
    id,
    name: prepared.name,
    buffer,
    durationSeconds,
    contentHash: prepared.contentHash,
    format: prepared.format,
    bytes: prepared.bytes,
    sampleRate: Number.isFinite(buffer.sampleRate) ? buffer.sampleRate : 0,
    channels: Number.isFinite(buffer.numberOfChannels) && buffer.numberOfChannels > 0 ? buffer.numberOfChannels : 1,
  };
}

/** Validate + decode + store one file under a pre-generated stable id. */
export async function loadSampleFile(
  id: string,
  file: SampleFile,
  decode: SampleDecodeFunction,
  hasher: ContentHasher = defaultContentHasher,
): Promise<LoadedSample> {
  const prepared = await readSampleFile(file, hasher);
  const buffer = await decodePrepared(prepared, decode);
  return toLoadedSample(id, prepared, buffer);
}

export interface SampleImportOptions {
  /**
   * Maps a content hash to an asset id that should own the decoded buffer. Used to relink a
   * missing project asset to a re-imported file instead of creating a duplicate asset.
   */
  assetIdForHash?: (contentHash: string) => string | undefined;
}

export interface SampleImportResult {
  sample: LoadedSample;
  /** True when identical bytes were already decoded, so no new buffer was created. */
  reused: boolean;
}

export class SampleStore {
  private readonly samples = new Map<string, LoadedSample>();
  private readonly idsByHash = new Map<string, string>();

  constructor(
    private readonly decode: SampleDecodeFunction,
    private readonly hasher: ContentHasher = defaultContentHasher,
  ) {}

  /** Import a file, reusing an already-decoded buffer for identical bytes. */
  async import(file: SampleFile, options: SampleImportOptions = {}): Promise<SampleImportResult> {
    const prepared = await readSampleFile(file, this.hasher);
    const knownId = this.idsByHash.get(prepared.contentHash);
    const known = knownId ? this.samples.get(knownId) : undefined;
    if (known) return { sample: known, reused: true };

    const requestedId = options.assetIdForHash?.(prepared.contentHash);
    const id = requestedId && !this.samples.has(requestedId) ? requestedId : createStableId('sample');
    const buffer = await decodePrepared(prepared, this.decode);
    const sample = toLoadedSample(id, prepared, buffer);
    this.set(sample);
    return { sample, reused: false };
  }

  /** Decode `file` and register it under a fresh (or reused, identical-content) stable id. */
  async add(file: SampleFile): Promise<LoadedSample> {
    return (await this.import(file)).sample;
  }

  /** Register an already-validated sample (used when a command is retried). */
  set(sample: LoadedSample): void {
    this.samples.set(sample.id, sample);
    if (sample.contentHash) this.idsByHash.set(sample.contentHash, sample.id);
  }

  get(id: string | undefined): AudioBuffer | null {
    if (!id) return null;
    return this.samples.get(id)?.buffer ?? null;
  }

  getSample(id: string): LoadedSample | null {
    return this.samples.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.samples.has(id);
  }

  /** The loaded sample that holds these exact bytes, if any. */
  findByHash(contentHash: string): LoadedSample | null {
    const id = this.idsByHash.get(contentHash);
    return id ? this.samples.get(id) ?? null : null;
  }

  size(): number {
    return this.samples.size;
  }

  /** Approximate decoded PCM bytes held, each buffer counted once. For diagnostics. */
  totalDecodedBytes(): number {
    let total = 0;
    const seen = new Set<AudioBuffer>();
    for (const sample of this.samples.values()) {
      if (seen.has(sample.buffer)) continue;
      seen.add(sample.buffer);
      total += sample.buffer.length * Math.max(1, sample.buffer.numberOfChannels || 1) * 4;
    }
    return total;
  }

  clear(): void {
    this.samples.clear();
    this.idsByHash.clear();
  }
}

/** Bounded, reusable envelope metadata for a clip thumbnail. No audio samples are serialized. */
export function buildWaveformPeaks(buffer: AudioBuffer, count = 96): number[] {
  const size = Number.isFinite(count) ? Math.max(1, Math.min(256, Math.floor(count))) : 96;
  const peaks = Array<number>(size).fill(0);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < size; index += 1) {
      const start = Math.floor(index * data.length / size);
      const end = Math.max(start + 1, Math.floor((index + 1) * data.length / size));
      // Cap reads for very large files; this is a thumbnail, never an audio rendering path.
      const stride = Math.max(1, Math.floor((end - start) / 512));
      for (let position = start; position < Math.min(end, data.length); position += stride) {
        if (Number.isFinite(data[position])) peaks[index] = Math.max(peaks[index], Math.min(1, Math.abs(data[position])));
      }
    }
  }
  return peaks;
}
