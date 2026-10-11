// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { BrowserAudioEngine } from './audio/AudioEngine';
import { applyProjectCommand } from './core/commands';
import { createInitialProject } from './core/project/model';
import { serializeProject } from './core/project/serialization';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let createdBlobs: Blob[];
let downloads: string[];

function byLabel(text: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${text}"]`);
  if (!element) throw new Error(`Missing "${text}"`);
  return element;
}

function buttonWithText(text: string): HTMLElement {
  const match = [...container.querySelectorAll<HTMLElement>('button')].find((button) => button.textContent?.trim() === text);
  if (!match) throw new Error(`Missing button "${text}"`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function chooseOption(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

async function pressCtrlS() {
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  });
}

async function chooseFile(file: File) {
  const input = byLabel('Open project file') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  // Opening reads the file asynchronously; let the promise chain settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  createdBlobs = [];
  downloads = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    createdBlobs.push(blob as Blob);
    return 'blob:test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  vi.spyOn(BrowserAudioEngine.prototype, 'setArrangement').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('Phase 8: project save and open', () => {
  it('saves a .json document that carries the effect chain', async () => {
    await click(byLabel('Effects for mixer channel Kick: 0 loaded'));
    await chooseOption(byLabel('Add effect to Kick') as HTMLSelectElement, 'delay');
    await click(buttonWithText('Save'));

    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/\.json$/);
    const document = JSON.parse(await readBlob(createdBlobs[0])) as { mixerChannels: Array<{ id: string; effects: Array<{ type: string | null }> }> };
    const kick = document.mixerChannels.find((channel) => channel.id === 'mixer-insert-1')!;
    expect(kick.effects.map((slot) => slot.type)).toEqual(['delay']);
  });

  it('saves with Ctrl+S', async () => {
    await pressCtrlS();
    expect(downloads).toHaveLength(1);
  });

  it('opens a saved project, shows its chain, and clears undo history so the old one cannot return', async () => {
    let saved = createInitialProject();
    saved = applyProjectCommand(saved, { type: 'mixer.effect.add', channelId: 'mixer-insert-2', effectId: 'fx-comp', effectType: 'compressor' });
    saved = applyProjectCommand(saved, { type: 'mixer.effect.param.set', channelId: 'mixer-insert-2', effectId: 'fx-comp', key: 'ratio', value: 6 });
    saved = { ...saved, name: 'Loaded Session' };

    await click(byLabel('Effects for mixer channel Snare: 0 loaded'));
    await click(byLabel('Close effects rack'));
    expect(byLabel('Undo').hasAttribute('disabled')).toBe(true);
    await chooseFile(new File([serializeProject(saved)], 'loaded.json', { type: 'application/json' }));

    expect(container.querySelector('.session-name')?.textContent).toBe('Loaded Session');
    expect(byLabel('Effects for mixer channel Snare: 1 loaded')).toBeTruthy();
    expect(byLabel('Undo').hasAttribute('disabled')).toBe(true);
    await click(byLabel('Effects for mixer channel Snare: 1 loaded'));
    expect((byLabel('Ratio of Compressor on Snare') as HTMLInputElement).getAttribute('aria-valuetext')).toBe('6.0:1');
  });

  it('reports an unreadable file and leaves the open project unchanged', async () => {
    await chooseFile(new File(['{"format":"not-a-project"}'], 'bad.json', { type: 'application/json' }));
    expect(container.querySelector('.error-notice')?.textContent).toContain('project');
    expect(container.querySelector('.session-name')?.textContent).toBe(createInitialProject().name);
  });
});

describe('Phase 8: effect warnings reach the user', () => {
  it('shows a notice when the engine reports effects missing from the mix, and clears it once fixed', async () => {
    const warnings = vi.spyOn(BrowserAudioEngine.prototype, 'getMixerEffectWarnings');
    warnings.mockReturnValue(['mixer-insert-1: Effect "fx-x" (delay) could not be created: bad']);
    await click(byLabel('Effects for mixer channel Kick: 0 loaded'));
    await chooseOption(byLabel('Add effect to Kick') as HTMLSelectElement, 'delay');
    expect(container.querySelector('.error-notice')?.textContent).toContain('absent from the mix');

    // The rack stays open (its FX button toggles it), so the next add goes straight to the same select.
    warnings.mockReturnValue([]);
    await chooseOption(byLabel('Add effect to Kick') as HTMLSelectElement, 'reverb');
    expect(container.querySelector('.error-notice')?.textContent ?? '').not.toContain('absent from the mix');
  });
});
