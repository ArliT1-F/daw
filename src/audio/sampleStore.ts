import { createStableId } from '../core/project/model';

/**
 * Runtime registry for decoded user samples.
 *
 * Decoded `AudioBuffer`s are browser audio objects and never enter the project document; the
 * project only stores a stable `sampleId` plus a display name on each channel. The store keeps
 * the buffers in memory for the session, exposes per-load error reporting, and resolves ids for
 * the voice builder through `get`.
 */

export interface LoadedSample {
  id: string;
  name: string;
  buffer: AudioBuffer;
  durationSeconds: number;
}

/** Anything File-like, so tests can pass plain objects. */
export interface SampleFile {
  name: string;
  size: number;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type SampleDecodeFunction = (data: ArrayBuffer) => Promise<AudioBuffer>;

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

/** Validate + decode + store one file under a pre-generated stable id. */
export async function loadSampleFile(id: string, file: SampleFile, decode: SampleDecodeFunction): Promise<LoadedSample> {
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

  let buffer: AudioBuffer;
  try {
    buffer = await decode(data);
  } catch (error) {
    throw new SampleLoadError(
      `${quoted(name)} could not be decoded. The format may not be supported by this browser.`,
      { cause: error },
    );
  }
  if (!buffer || typeof buffer.length !== 'number' || buffer.length === 0) {
    throw new SampleLoadError(`${quoted(name)} decoded to empty audio.`);
  }

  const durationSeconds = Number.isFinite(buffer.duration) ? buffer.duration : 0;
  return { id, name, buffer, durationSeconds };
}

export class SampleStore {
  private readonly samples = new Map<string, LoadedSample>();

  constructor(private readonly decode: SampleDecodeFunction) {}

  /** Decode `file` and register it under a fresh stable id. */
  async add(file: SampleFile): Promise<LoadedSample> {
    const sample = await loadSampleFile(createStableId('sample'), file, this.decode);
    this.samples.set(sample.id, sample);
    return sample;
  }

  /** Re-register an already-validated id (used when a channel command is retried). */
  set(sample: LoadedSample): void {
    this.samples.set(sample.id, sample);
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

  size(): number {
    return this.samples.size;
  }

  clear(): void {
    this.samples.clear();
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
