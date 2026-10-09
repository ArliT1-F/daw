// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { FakeAudioContext } from './audio/__fixtures__/fakeAudioContext';

/**
 * Integration test for the React wiring around the audio engine: it mounts the real app in a DOM,
 * swaps in the AudioContext double, and drives playback through the transport buttons.
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let fake: FakeAudioContext;

function findByLabel(label: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`No element with aria-label "${label}"`);
  return element;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  fake = new FakeAudioContext();
  (window as unknown as { AudioContext: unknown }).AudioContext = function AudioContextDouble() {
    return fake as unknown as AudioContext;
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe('studio audio wiring', () => {
  it('mounts without touching audio until a gesture', async () => {
    await act(async () => {
      root.render(<App />);
    });
    expect(fake.resumeCount).toBe(0);
    expect(container.textContent).toContain('Enable audio');
  });

  it('starts the engine, plays scheduled voices, and stops cleanly', async () => {
    await act(async () => {
      root.render(<App />);
    });

    await click(findByLabel('Play'));
    expect(fake.resumeCount).toBe(1);
    // The first window is queued immediately: step 0 of the starter pattern (kick, hat, bass note).
    expect(fake.oscillators.length).toBeGreaterThan(0);
    expect(fake.bufferSources.length).toBeGreaterThan(0);
    expect(findByLabel('Pause')).toBeTruthy();

    await click(findByLabel('Stop transport and return to start'));
    // Every voice is cut at, or before, the moment it would have started: nothing keeps sounding.
    for (const source of fake.sources) {
      const cutAt = Math.max(source.startedAt ?? 0, fake.currentTime);
      expect(source.stopAt).toBeLessThanOrEqual(cutAt + 0.01);
    }
    fake.advanceTo(0.5);
    expect(fake.getSoundingSources(0.5)).toHaveLength(0);
    expect(container.querySelector('.position-value')?.textContent).toBe('01 : 01 : 01');
  });

  it('auditions a test tone on demand', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await click(findByLabel('Play a test tone'));
    expect(fake.oscillators).toHaveLength(1);
    expect(fake.oscillators[0].startedAt).toBeCloseTo(0.02, 6);
  });

  it('toggles looping through the transport bar', async () => {
    await act(async () => {
      root.render(<App />);
    });
    const loopButton = findByLabel('Looping is on');
    expect(loopButton.getAttribute('aria-pressed')).toBe('true');
    await click(loopButton);
    expect(findByLabel('Looping is off').getAttribute('aria-pressed')).toBe('false');
  });
});
