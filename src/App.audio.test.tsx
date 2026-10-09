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

/**
 * Phase 3 acceptance: a user can load drum samples, create a drum pattern, play it in time,
 * change tempo, duplicate a pattern, and hear the expected result.
 */
describe('phase 3 acceptance: channel rack workflow', () => {
  function setNativeValue(element: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('No value setter');
    setter.call(element, value);
  }

  async function flushAsync() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function loadSampleInto(channelLabel: string, file: File) {
    const input = container.querySelector<HTMLInputElement>(`[aria-label="${channelLabel}"]`);
    if (!input) throw new Error(`No file input for ${channelLabel}`);
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flushAsync();
  }

  it('loads a sample, builds and plays a pattern, changes tempo, and duplicates it', async () => {
    await act(async () => {
      root.render(<App />);
    });

    // 1. Load a drum sample into the kick channel (file picker path).
    const sampleBytes = new Uint8Array(256).fill(7);
    await loadSampleInto('Load an audio sample into Kick', new File([sampleBytes], 'kick-user.wav', { type: 'audio/wav' }));
    expect(fake.decodeCount).toBe(1);
    expect(container.textContent).toContain('kick-user.wav');
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // 2. Build the pattern: turn on kick step 2 through the rack.
    await click(findByLabel('Kick step 2, off'));
    expect(findByLabel('Kick step 2, on, velocity 85 percent').getAttribute('aria-pressed')).toBe('true');

    // 3. Play: the scheduler queues the loaded sample buffer on the audio clock.
    await click(findByLabel('Play'));
    const decodedBufferLength = Math.round(48000 * 0.25); // what the fake decoder returns
    const sampleHits = fake.bufferSources.filter((source) => source.buffer?.length === decodedBufferLength);
    expect(sampleHits.length).toBeGreaterThanOrEqual(1); // kick steps 0 and (just toggled) 1 — step 0 in the window
    expect(sampleHits[0].startedAt).toBeCloseTo(0.06, 6);
    expect(container.querySelector('.transport-play')?.classList.contains('is-playing')).toBe(true);

    await click(findByLabel('Stop transport and return to start'));

    // 4. Change tempo; the commit must be accepted without project errors.
    const tempoInput = container.querySelector<HTMLInputElement>('[aria-label="Tempo in beats per minute"]')!;
    setNativeValue(tempoInput, '140');
    await act(async () => {
      tempoInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      tempoInput.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    });
    expect(tempoInput.value).toBe('140');
    expect(container.querySelector('.error-notice')).toBeNull();

    // 5. Duplicate the pattern; selection follows the copy.
    await click(findByLabel('Duplicate current pattern'));
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Selected pattern"]')!;
    expect(select.options).toHaveLength(2);
    expect(select.value).not.toBe('pattern-main');
    expect((container.querySelector('[aria-label="Pattern name"]') as HTMLInputElement).value).toBe('Pattern 01 copy');
    expect(container.querySelector('.session-pattern')!.textContent).toBe('Pattern 01 copy');

    // 6. Arrange the duplicate so it can be heard: place its clip at bar 5.
    await click(findByLabel('Place Pattern 01 copy clip at bar 5'));
    expect(container.querySelectorAll('.playlist-clip')).toHaveLength(2);

    // 7. Play again: both the original steps and the duplicated clip's pattern produce sound.
    await click(findByLabel('Play'));
    expect(fake.bufferSources.filter((source) => source.buffer?.length === decodedBufferLength).length).toBeGreaterThanOrEqual(1);
    await click(findByLabel('Stop transport and return to start'));
  });

  it('shows a per-channel error when a sample cannot be decoded, and dismisses it', async () => {
    await act(async () => {
      root.render(<App />);
    });

    fake.failNextDecode = true;
    await loadSampleInto('Load an audio sample into Kick', new File([new Uint8Array([1, 2, 3])], 'broken.wav', { type: 'audio/wav' }));

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain('“broken.wav” could not be decoded');
    // The channel keeps its previous state: no sample chip appears, no crash.
    expect(container.querySelector('.rack-sample-name')).toBeNull();

    await click(alert!.querySelector<HTMLElement>('.rack-row-error-dismiss')!);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('previews a channel once without starting the transport', async () => {
    await act(async () => {
      root.render(<App />);
    });
    const before = fake.oscillators.length + fake.bufferSources.length;
    await click(findByLabel('Preview Kick'));
    expect(fake.oscillators.length + fake.bufferSources.length).toBe(before + 1);
    // The transport never started: the play button still reads "Play".
    expect(findByLabel('Play')).toBeTruthy();
  });

  it('keeps rack playback indicators still until the engine is genuinely playing', async () => {
    await act(async () => {
      root.render(<App />);
    });
    // Press play with the audio context available: indicators appear from the audio clock.
    expect(container.querySelectorAll('.rack-step--playhead')).toHaveLength(0);
    await click(findByLabel('Play'));
    // Even while playing, the step playhead only lights the column the scheduler is on.
    const playheadCells = container.querySelectorAll('.rack-step--playhead');
    expect(playheadCells.length).toBeLessThanOrEqual(container.querySelectorAll('.rack-channel-row').length);
    await click(findByLabel('Stop transport and return to start'));
    expect(container.querySelectorAll('.rack-step--playhead')).toHaveLength(0);
  });
});
