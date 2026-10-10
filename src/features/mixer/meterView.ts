/**
 * Meter view binding.
 *
 * Level meters update far more often than any React render should. The registry holds direct
 * references to the handful of DOM nodes each meter view owns and writes to them in place, so one
 * meter tick costs a few style/text writes instead of reconciling the mixer. React only re-renders
 * when the project changes.
 *
 * Views are keyed separately from mixer channel ids because the same channel can be metered in more
 * than one place at once (the Mixer's master strip and the transport bar's master widget).
 */

import { formatMixerDb, meterPercent } from '../../core/mixer/mixerModel';
import type { MeterReading } from '../../audio/metering';

export type MeterElementKind = 'fill' | 'peak' | 'clip' | 'readout';
export type MeterOrientation = 'vertical' | 'horizontal';

export type MeterReadingSource = (mixerChannelId: string) => MeterReading | null;

/** Smallest visible change worth a style write; below this the meter would not move a pixel. */
const PERCENT_EPSILON = 0.4;

interface MeterView {
  channelId: string;
  orientation: MeterOrientation;
  elements: Partial<Record<MeterElementKind, HTMLElement>>;
  levelPercent: number;
  peakPercent: number;
  clipLatched: boolean;
  clipHit: boolean;
  readout: string;
}

export class MeterViewRegistry {
  private readonly views = new Map<string, MeterView>();

  /** Number of bound meter views. */
  get size(): number {
    return this.views.size;
  }

  has(viewId: string): boolean {
    return this.views.has(viewId);
  }

  get viewIds(): string[] {
    return [...this.views.keys()];
  }

  /** Bind a meter view of one mixer channel. Idempotent for the same view id. */
  register(viewId: string, channelId: string, orientation: MeterOrientation = 'vertical'): void {
    const existing = this.views.get(viewId);
    if (existing) {
      existing.channelId = channelId;
      existing.orientation = orientation;
      return;
    }
    this.views.set(viewId, {
      channelId,
      orientation,
      elements: {},
      levelPercent: -1,
      peakPercent: -1,
      clipLatched: false,
      clipHit: false,
      readout: '',
    });
  }

  setElement(viewId: string, kind: MeterElementKind, node: HTMLElement | null): void {
    const view = this.views.get(viewId);
    if (!view) return;
    if (!node) delete view.elements[kind];
    else view.elements[kind] = node;
  }

  /** Drop one view, or every view when called without an id. */
  unregister(viewId?: string): void {
    if (viewId === undefined) this.views.clear();
    else this.views.delete(viewId);
  }

  /** Write the current readings into the bound elements, skipping values that would not move. */
  apply(getReading: MeterReadingSource): void {
    for (const view of this.views.values()) {
      const reading = getReading(view.channelId);
      const levelPercent = reading ? meterPercent(reading.levelDb) : 0;
      const peakPercent = reading ? meterPercent(reading.peakDb) : 0;
      if (view.elements.fill && Math.abs(levelPercent - view.levelPercent) > PERCENT_EPSILON) {
        setAxis(view.elements.fill, view.orientation, 'level', levelPercent);
        view.levelPercent = levelPercent;
      }
      if (view.elements.peak && Math.abs(peakPercent - view.peakPercent) > PERCENT_EPSILON) {
        setAxis(view.elements.peak, view.orientation, 'peak', peakPercent);
        view.peakPercent = peakPercent;
      }
      const clip = view.elements.clip;
      if (clip && reading) {
        if (reading.clipLatched !== view.clipLatched) {
          clip.classList.toggle('is-latched', reading.clipLatched);
          clip.setAttribute('aria-label', reading.clipLatched ? 'Clear clip indicator' : 'No clipping');
          view.clipLatched = reading.clipLatched;
        }
        if (reading.clipped !== view.clipHit) {
          clip.classList.toggle('is-hit', reading.clipped);
          view.clipHit = reading.clipped;
        }
      }
      const readout = view.elements.readout;
      if (readout) {
        const text = formatMixerDb(reading ? reading.peakDb : Number.NEGATIVE_INFINITY);
        if (text !== view.readout) {
          readout.textContent = text;
          view.readout = text;
        }
      }
    }
  }
}

function setAxis(node: HTMLElement, orientation: MeterOrientation, part: 'level' | 'peak', percent: number): void {
  const value = `${percent.toFixed(1)}%`;
  if (orientation === 'horizontal') {
    if (part === 'level') node.style.width = value;
    else node.style.left = value;
    return;
  }
  if (part === 'level') node.style.height = value;
  else node.style.bottom = value;
}
