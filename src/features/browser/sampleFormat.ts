import type { AudioAsset } from '../../core/project/model';

/** Duration as seconds with three decimals, e.g. `0.250 s`; a non-finite value shows a dash. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return `${seconds.toFixed(3)} s`;
}

/** Short size label, e.g. `22 KB` or `1.4 MB`. */
export function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes)) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `44.1 kHz`, `48 kHz`, or null when the rate is not known. */
export function formatSampleRate(rate: number | undefined): string | null {
  if (!rate || !Number.isFinite(rate)) return null;
  const khz = rate / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

export function formatChannels(channels: number | undefined): string | null {
  if (!channels) return null;
  if (channels === 1) return 'mono';
  if (channels === 2) return 'stereo';
  return `${channels} ch`;
}

/** Joined metadata line for an asset: duration first, then whatever the file reported. */
export function describeAsset(asset: Pick<AudioAsset, 'durationSeconds' | 'sampleRate' | 'channels' | 'bytes' | 'format'>): string {
  return [
    formatDuration(asset.durationSeconds),
    formatSampleRate(asset.sampleRate),
    formatChannels(asset.channels),
    formatBytes(asset.bytes),
    asset.format ? asset.format.toUpperCase() : null,
  ].filter(Boolean).join(' · ');
}

/** Gain as a percentage and decibels, e.g. `100% · 0.0 dB`. Zero gain reads as silence. */
export function formatGain(gain: number): string {
  if (gain <= 0) return '0% · silent';
  const db = 20 * Math.log10(gain);
  return `${Math.round(gain * 100)}% · ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/** Parse a user-typed seconds value. Returns null for anything that is not a finite number. */
export function parseSeconds(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
