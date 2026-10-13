/**
 * Synthetic stereo room impulse for the reverb.
 *
 * The impulse is generated, not loaded, so it needs no asset and no network. It is deterministic:
 * the same decay and sample rate always yield the same samples, so an offline render is repeatable
 * and a saved project sounds the same after reloading.
 *
 * Shape: independent uniform noise per channel under an exponential envelope that falls by 60 dB
 * over `decaySeconds` (RT60). The ConvolverNode normalises the result, so changing the decay
 * changes the tail length without changing the loudness much.
 */

/** Longest impulse the reverb will build. Longer tails cost quadratically more CPU. */
export const MAX_IMPULSE_SECONDS = 5;

/** mulberry32: a tiny, well-distributed seeded PRNG. Same seed, same sequence, every platform. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ImpulseResponse {
  readonly sampleRate: number;
  readonly length: number;
  /** One Float32Array per output channel (left, right). */
  readonly channels: readonly [Float32Array, Float32Array];
}

const LEFT_SEED = 0x9e3779b9;
const RIGHT_SEED = 0x7f4a7c15;

/**
 * Build the stereo impulse for a decay time. The decay is clamped to the supported range, and the
 * length is the decay time in samples (the envelope reaches -60 dB at the last sample).
 */
export function generateReverbImpulse(decaySeconds: number, sampleRate: number): ImpulseResponse {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Impulse sample rate must be positive.');
  const decay = Math.min(MAX_IMPULSE_SECONDS, Math.max(0.05, Number.isFinite(decaySeconds) ? decaySeconds : 1));
  const length = Math.max(1, Math.round(decay * sampleRate));
  const left = new Float32Array(new ArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT));
  const right = new Float32Array(new ArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT));
  const randomLeft = createSeededRandom(LEFT_SEED);
  const randomRight = createSeededRandom(RIGHT_SEED);
  for (let index = 0; index < length; index += 1) {
    const t = index / sampleRate;
    // Amplitude falls 60 dB (factor 1000) over the decay time: 10^(-3 t / RT60).
    const envelope = 10 ** (-3 * (t / decay));
    left[index] = (randomLeft() * 2 - 1) * envelope;
    right[index] = (randomRight() * 2 - 1) * envelope;
  }
  return { sampleRate, length, channels: [left, right] };
}

const IMPULSE_CACHE_LIMIT = 8;
const impulseCache = new Map<string, ImpulseResponse>();

/**
 * Same as `generateReverbImpulse`, memoised on the (rounded) decay and sample rate. Undo, redo, and
 * re-adding a reverb reuse the impulse instead of regenerating it on the main thread. Impulses are
 * read-only once generated: callers copy them into an AudioBuffer.
 */
export function getCachedReverbImpulse(decaySeconds: number, sampleRate: number): ImpulseResponse {
  const decay = Math.min(MAX_IMPULSE_SECONDS, Math.max(0.05, Number.isFinite(decaySeconds) ? decaySeconds : 1));
  const key = `${Math.round(decay * 1000)}@${sampleRate}`;
  const hit = impulseCache.get(key);
  if (hit) {
    // Re-insert so the cache evicts the least recently used entry.
    impulseCache.delete(key);
    impulseCache.set(key, hit);
    return hit;
  }
  const impulse = generateReverbImpulse(decay, sampleRate);
  impulseCache.set(key, impulse);
  if (impulseCache.size > IMPULSE_CACHE_LIMIT) {
    const oldest = impulseCache.keys().next().value;
    if (oldest !== undefined) impulseCache.delete(oldest);
  }
  return impulse;
}
