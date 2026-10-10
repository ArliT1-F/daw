// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { meterPercent } from '../../core/mixer/mixerModel';
import type { MeterReading } from '../../audio/metering';
import { MeterViewRegistry, type MeterElementKind } from './meterView';

function el(): HTMLElement {
  return document.createElement('div');
}

function reading(levelDb: number, peakDb: number, clipped = false, clipLatched = false): MeterReading {
  return { level: 0, levelDb, rms: 0, peak: 0, peakDb, clipped, clipLatched };
}

function mountVertical(registry: MeterViewRegistry, channelId = 'mix-1') {
  const elements = { fill: el(), peak: el(), clip: el(), readout: el() };
  registry.register(channelId, channelId, 'vertical');
  registry.setElement(channelId, 'fill', elements.fill);
  registry.setElement(channelId, 'peak', elements.peak);
  registry.setElement(channelId, 'clip', elements.clip);
  registry.setElement(channelId, 'readout', elements.readout);
  return elements;
}

describe('meter view registry', () => {
  it('writes vertical meters as a fill height and a peak marker position', () => {
    const registry = new MeterViewRegistry();
    const { fill, peak, readout } = mountVertical(registry);

    registry.apply(() => reading(-20, -6));
    expect(fill.style.height).toBe(`${meterPercent(-20).toFixed(1)}%`);
    expect(peak.style.bottom).toBe(`${meterPercent(-6).toFixed(1)}%`);
    expect(readout.textContent).toContain('-6.0 dB');
  });

  it('writes horizontal meters as a fill width and a peak marker offset', () => {
    const registry = new MeterViewRegistry();
    const elements = { fill: el(), peak: el(), clip: el(), readout: el() };
    registry.register('master', 'mixer-master', 'horizontal');
    for (const [kind, node] of Object.entries(elements)) registry.setElement('master', kind as MeterElementKind, node);

    registry.apply((id) => (id === 'mixer-master' ? reading(-12, -3) : null));
    expect(elements.fill.style.width).toBe(`${meterPercent(-12).toFixed(1)}%`);
    expect(elements.peak.style.left).toBe(`${meterPercent(-3).toFixed(1)}%`);
    // A horizontal view never touches the vertical axes.
    expect(elements.fill.style.height).toBe('');
    expect(elements.peak.style.bottom).toBe('');
  });

  it('skips DOM writes that would not move the meter visibly', () => {
    const registry = new MeterViewRegistry();
    const { fill } = mountVertical(registry);

    registry.apply(() => reading(-30, -30));
    const first = fill.style.height;
    // A change far smaller than a pixel does not rewrite the style.
    registry.apply(() => reading(-29.85, -29.85));
    expect(fill.style.height).toBe(first);
    // A real change does.
    registry.apply(() => reading(-20, -20));
    expect(fill.style.height).toBe(`${meterPercent(-20).toFixed(1)}%`);
  });

  it('drives the clip indicator classes and label, and reports silence for a missing reading', () => {
    const registry = new MeterViewRegistry();
    const { fill, clip, readout } = mountVertical(registry);

    registry.apply(() => reading(-1, -0.1, true, true));
    expect(clip.classList.contains('is-hit')).toBe(true);
    expect(clip.classList.contains('is-latched')).toBe(true);
    expect(clip.getAttribute('aria-label')).toBe('Clear clip indicator');

    registry.apply(() => reading(-30, -30, false, true));
    expect(clip.classList.contains('is-hit')).toBe(false);
    expect(clip.classList.contains('is-latched')).toBe(true);

    registry.apply(() => reading(-30, -30, false, false));
    expect(clip.classList.contains('is-latched')).toBe(false);
    expect(clip.getAttribute('aria-label')).toBe('No clipping');

    registry.apply(() => null);
    expect(fill.style.height).toBe('0%');
    expect(readout.textContent).toBe('-inf dB');
  });

  it('registers multiple views of the same channel and unregisters cleanly', () => {
    const registry = new MeterViewRegistry();
    const a = mountVertical(registry, 'mixer-master');
    const b = el();
    registry.register('transport-master', 'mixer-master', 'horizontal');
    registry.setElement('transport-master', 'fill', b);
    expect(registry.size).toBe(2);

    registry.apply((id) => (id === 'mixer-master' ? reading(-10, -4) : null));
    expect(a.fill.style.height).toBe(`${meterPercent(-10).toFixed(1)}%`);
    // The horizontal view of the same channel tracks the level (not the peak) on its width axis.
    expect(b.style.width).toBe(`${meterPercent(-10).toFixed(1)}%`);

    registry.unregister('transport-master');
    expect(registry.size).toBe(1);
    registry.unregister();
    expect(registry.size).toBe(0);
  });
});
