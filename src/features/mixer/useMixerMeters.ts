import { useEffect } from 'react';
import type { MeterReading } from '../../audio/metering';
import type { MeterViewRegistry } from './meterView';

/**
 * Meter poll rate in milliseconds. 20 Hz is smooth for a level meter, well below the frame rate,
 * and — because the loop is `requestAnimationFrame`-driven — it stops entirely in a hidden tab.
 */
export const METER_UI_INTERVAL_MS = 50;

/** The slice of the audio engine the meter loop needs. */
export interface MixerMeterHost {
  sampleMeters(): void;
  getMeterReading(mixerChannelId: string): MeterReading | null;
}

/**
 * Poll the engine's analysers at a bounded rate and write the results straight into the bound DOM
 * nodes. Deliberately free of React state: a meter tick must never re-render the mixer.
 */
export function useMixerMeters(host: MixerMeterHost, registry: MeterViewRegistry, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return undefined;
    let frame = 0;
    let lastSampleAt = Number.NEGATIVE_INFINITY;
    const draw = (timestamp: number) => {
      frame = window.requestAnimationFrame(draw);
      if (timestamp - lastSampleAt < METER_UI_INTERVAL_MS) return;
      lastSampleAt = timestamp;
      try {
        host.sampleMeters();
        registry.apply((id) => host.getMeterReading(id));
      } catch {
        /* the context can close mid-frame; the next user gesture rebuilds it */
      }
    };
    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [host, registry, enabled]);
}
