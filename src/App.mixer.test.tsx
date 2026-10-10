// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App } from './App';
import { BrowserAudioEngine } from './audio/AudioEngine';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let arrangementSpy: MockInstance<BrowserAudioEngine['setArrangement']>;
let mixerSpy: MockInstance<BrowserAudioEngine['setMixerState']>;

function byLabel(text: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${text}"]`);
  if (!element) throw new Error(`Missing "${text}"`);
  return element;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function setRange(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  arrangementSpy = vi.spyOn(BrowserAudioEngine.prototype, 'setArrangement');
  mixerSpy = vi.spyOn(BrowserAudioEngine.prototype, 'setMixerState');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  arrangementSpy.mockRestore();
  mixerSpy.mockRestore();
});

describe('mixer wiring in the studio', () => {
  it('applies mixer edits to the engine without rebuilding the arrangement', async () => {
    await act(async () => {
      root.render(<App />);
    });
    const engine = mixerSpy.mock.contexts[0] as BrowserAudioEngine;
    expect(engine).toBe(arrangementSpy.mock.contexts[0]);
    // Both syncs run once on mount.
    const arrangementCalls = arrangementSpy.mock.calls.length;
    const mixerCalls = mixerSpy.mock.calls.length;
    expect(arrangementCalls).toBeGreaterThan(0);
    expect(mixerCalls).toBeGreaterThan(0);

    // A fader move is a mixer-only edit: it re-syncs the mixer graph but never the arrangement,
    // so the event source and any sounding voices are left untouched.
    const fader = container.querySelector<HTMLInputElement>('[aria-label="Volume of mixer channel Kick in decibels"]')!;
    await act(async () => {
      fader.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    });
    await setRange(fader, '-18');

    expect(mixerSpy.mock.calls.length).toBe(mixerCalls + 1);
    expect(arrangementSpy.mock.calls.length).toBe(arrangementCalls);
    const lastState = mixerSpy.mock.calls.at(-1)![0];
    expect(lastState.channels.find((channel) => channel.id === 'mixer-insert-1')?.volumeDb).toBe(-18);
  });

  it('keeps the master output meter bound in the transport and the mixer panel', async () => {
    await act(async () => {
      root.render(<App />);
    });
    // The transport master widget and the mixer master strip both measure the master bus.
    expect(container.querySelector('.master-placeholder [data-meter="fill"]')).toBeTruthy();
    const masterStrip = container.querySelector('.mixer-strip--master')!;
    expect(masterStrip.querySelector('[data-meter="fill"]')).toBeTruthy();
    expect(container.querySelector('.mixer-strip--master [data-meter="readout"]')).toBeTruthy();
  });

  it('routes a Playlist track to an insert from the mixer and restores it on undo', async () => {
    await act(async () => {
      root.render(<App />);
    });
    // The starter routes the "Audio" track to the master bus.
    let assign = container.querySelector<HTMLSelectElement>('[aria-label="Mixer channel for track Audio"]')!;
    expect(assign.value).toBe('mixer-master');

    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(assign, 'mixer-insert-2');
      assign.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const lastState = mixerSpy.mock.calls.at(-1)![0];
    expect(lastState.sources.find((source) => source.id === 'audio:track-audio')?.mixerChannelId).toBe('mixer-insert-2');

    // Undo restores the previous routing and re-syncs the engine.
    await click(byLabel('Undo'));
    const restored = mixerSpy.mock.calls.at(-1)![0];
    expect(restored.sources.find((source) => source.id === 'audio:track-audio')?.mixerChannelId).toBe('mixer-master');
  });

  it('coalesces a fader drag into a single undo entry', async () => {
    await act(async () => {
      root.render(<App />);
    });
    const fader = container.querySelector<HTMLInputElement>('[aria-label="Volume of mixer channel Snare in decibels"]')!;
    await act(async () => {
      fader.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    });
    await setRange(fader, '-3');
    await setRange(fader, '-6');
    await setRange(fader, '-9');

    expect(fader.value).toBe('-9');
    // The whole drag is one undo step, not one per pixel.
    await click(byLabel('Undo'));
    expect(container.querySelector<HTMLInputElement>('[aria-label="Volume of mixer channel Snare in decibels"]')!.value).toBe('0');
  });
});
