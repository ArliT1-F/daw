// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App } from './App';
import { BrowserAudioEngine } from './audio/AudioEngine';
import { FakeAudioContext } from './audio/__fixtures__/fakeAudioContext';

let container: HTMLDivElement, root: Root, fake: FakeAudioContext;
let arrangementSpy: MockInstance<BrowserAudioEngine['setArrangement']>;
function label(text: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${text}"]`);
  if (!element) throw new Error(`Missing ${text}`);
  return element;
}
async function click(element: HTMLElement) { await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); }
async function inputValue(element: HTMLInputElement, value: string, commit = true) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  if (commit) await act(async () => { element.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
}
function engine() { return arrangementSpy.mock.contexts[0] as BrowserAudioEngine; }

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  fake = new FakeAudioContext();
  (window as unknown as { AudioContext: unknown }).AudioContext = function Double() { return fake as unknown as AudioContext; };
  arrangementSpy = vi.spyOn(BrowserAudioEngine.prototype, 'setArrangement');
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(<App />); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); delete (window as unknown as { AudioContext?: unknown }).AudioContext; });

describe('Phase 5: Playlist/Channel Rack/Piano Roll/transport integration', () => {
  it('seeks while stopped via the ruler, then plays held notes at that position instead of restarting at zero', async () => {
    await click(label('Seek to bar 3 beat 2'));
    expect(engine().getPositionSteps()).toBe(36);
    expect(container.querySelector('.position-value')?.textContent).toBe('03 : 02 : 01');
    await click(label('Play'));
    expect(engine().getPositionSteps()).toBe(36);
    expect(fake.sources.length).toBeGreaterThan(0);
    fake.sources.forEach((source) => expect(source.startedAt).toBeCloseTo(0.06, 9));
  });
  it('saves the loop in project history and keeps both transport loop controls synchronized', async () => {
    await inputValue(label('Loop start bar') as HTMLInputElement, '3');
    await inputValue(label('Loop end bar') as HTMLInputElement, '4');
    expect(engine().transport.loop).toEqual({ enabled: true, startStep: 32, endStep: 48 });
    expect(engine().getPositionSteps()).toBe(32);
    await click(label('Toggle Playlist loop'));
    expect(label('Looping is off').getAttribute('aria-pressed')).toBe('false');
    expect(engine().transport.loop).toMatchObject({ enabled: false, startStep: 0, endStep: 64 });
    await click(label('Undo'));
    expect(label('Looping is on').getAttribute('aria-pressed')).toBe('true');
    expect(engine().transport.loop).toMatchObject({ enabled: true, startStep: 32, endStep: 48 });
    await click(label('Play'));
    await click(label('Stop transport and return to start'));
    expect(container.querySelector('.position-value')?.textContent).toBe('03 : 01 : 01');
  });
  it('imports, duplicates, and plays audio asset instances without duplicating the decoded source', async () => {
    await click(label('Track name Audio'));
    const file = new File([new Uint8Array(128).fill(7)], 'arrangement.wav', { type: 'audio/wav' });
    const input = label('Import an audio file into the Playlist') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fake.decodeCount).toBe(1);
    expect(container.querySelectorAll('.playlist-clip--audio')).toHaveLength(1);
    await click(label('Duplicate selected clips'));
    expect(container.querySelectorAll('.playlist-clip--audio')).toHaveLength(2);
    expect(fake.decodeCount).toBe(1);
    await click(label('Play'));
    expect(fake.bufferSources.filter((source) => source.buffer?.duration === 0.25)).toHaveLength(1);
    await act(async () => {
      fake.advanceTo(0.5); engine().tick();
    });
    expect(fake.bufferSources.filter((source) => source.buffer?.duration === 0.25)).toHaveLength(2);
    await click(label('Stop transport and return to start'));
    fake.advanceTo(1);
    expect(fake.getSoundingSources()).toHaveLength(0);
    await click(label('Undo'));
    expect(container.querySelectorAll('.playlist-clip--audio')).toHaveLength(1);
  });
  it('track mute/solo affects the single arrangement source while Channel Rack edits remain playable', async () => {
    await click(label('Mute track Patterns'));
    await click(label('Play'));
    expect(fake.sources).toHaveLength(0);
    await click(label('Stop transport and return to start'));
    await click(label('Mute track Patterns'));
    await click(label('Kick step 2, off'));
    await click(label('Play'));
    expect(fake.sources.length).toBeGreaterThan(0);
    await act(async () => { fake.advanceTo(0.12); engine().tick(); });
    expect(fake.oscillators.filter((source) => Math.abs((source.startedAt ?? 0) - (0.06 + 60 / 124 / 4)) < 1e-8)).toHaveLength(1);
  });
  it('edits and seeks Piano Roll notes relative to a moved instance, not the absolute song modulo', async () => {
    const clip = container.querySelector<HTMLElement>('[data-clip-id="clip-main-0"]')!;
    await click(clip);
    await inputValue(label('Clip start beat') as HTMLInputElement, '2'); // move to step 4, source still starts at zero
    await click(label('Seek to bar 1 beat 2'));
    await click(label('Play'));
    expect(fake.oscillators.filter((source) => source.type === 'sawtooth')[0].frequency.value).toBeCloseTo(261.625565, 5); // source C4 at 4, not source G4 at global % 16 = 4
    expect(container.querySelector<HTMLElement>('.piano-playhead')?.style.transform).toBe('translateX(0px)');
    const ruler = label('Bar and beat ruler');
    expect(ruler).toBeTruthy();
    await click(label('Stop transport and return to start'));
    expect(container.querySelectorAll('.piano-note')).toHaveLength(4);
  });
  it('does not show a fake playing transport when audio is unavailable', async () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    await click(label('Play'));
    expect(label('Play')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Web Audio');
    expect(container.querySelector('.timeline-playhead--playing')).toBeNull();
  });

  it('reuses a Channel Rack sample as a native Playlist audio asset without another decode', async () => {
    const file = new File([new Uint8Array(128).fill(7)], 'shared-kick.wav', { type: 'audio/wav' });
    const input = label('Load an audio sample into Kick') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const sources = label('Playlist clip source') as HTMLSelectElement;
    const asset = [...sources.options].find((option) => option.value.startsWith('audio:') && option.textContent?.includes('shared-kick.wav'))!;
    expect(asset).toBeTruthy();
    await act(async () => { sources.value = asset.value; sources.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await click(label('Place shared-kick.wav clip at bar 5'));
    expect(container.querySelectorAll('.playlist-clip--audio')).toHaveLength(1);
    expect(fake.decodeCount).toBe(1);
    await click(label('Seek to bar 5'));
    await click(label('Play'));
    expect(fake.bufferSources).toHaveLength(1);
    expect(fake.bufferSources[0].offsetSeconds).toBe(0);
  });

  it('selecting overlapping shared instances switches the source-local Piano Roll playhead to that instance', async () => {
    await click(label('Place Pattern 01 clip at bar 3'));
    await inputValue(label('Clip start beat') as HTMLInputElement, '10'); // step 36, overlapping the original
    await click(label('Seek to bar 3 beat 2'));
    expect(engine().getPositionSteps()).toBe(36);
    expect(container.querySelector<HTMLElement>('.piano-playhead')?.style.transform).toBe('translateX(0px)');
    await click(container.querySelector<HTMLElement>('[data-clip-id="clip-main-0"]')!);
    expect(container.querySelector<HTMLElement>('.piano-playhead')?.style.transform).toBe('translateX(112px)');
  });

});
