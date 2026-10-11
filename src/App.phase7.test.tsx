// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { FakeAudioContext } from './audio/__fixtures__/fakeAudioContext';

/**
 * Phase 7 integration: sample library import, reuse, unsupported files, assignment to channels,
 * and the synth inspector. Drives the real app through its DOM.
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let fake: FakeAudioContext;

function byLabel(label: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`No element with aria-label "${label}"`);
  return element;
}

function byLabelPrefix(prefix: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label^="${prefix}"]`);
  if (!element) throw new Error(`No element with aria-label starting "${prefix}"`);
  return element;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function importFiles(files: File[]): Promise<void> {
  const input = byLabel('Import audio files into the sample library') as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await flush();
}

async function selectChannel(name: string): Promise<void> {
  const info = byLabel(`Name of ${name}`).closest('.rack-channel-info') as HTMLElement;
  await act(async () => {
    info.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  });
}

function wav(name: string, text = 'RIFF-fake-wave-data'): File {
  return new File([text], name, { type: 'audio/wav' });
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

describe('sample library', () => {
  it('imports a WAV into the library, shows its metadata, and reuses identical bytes', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await importFiles([wav('snare.wav')]);

    const list = byLabel('Loaded samples');
    expect(list.textContent).toContain('snare.wav');
    expect(list.textContent).toContain('0.250 s');
    expect(list.textContent).toContain('WAV');

    // The same bytes under another name: no second asset, and the decoded buffer is reused.
    const decodesBefore = fake.decodeCount;
    await importFiles([wav('snare copy.wav')]);
    expect(container.querySelectorAll('.library-item')).toHaveLength(1);
    expect(fake.decodeCount).toBe(decodesBefore);
    expect(container.querySelector('.library-notice')?.textContent).toContain('already in the library');
  });

  it('rejects an unsupported file with a clear message and keeps the library unchanged', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await importFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    const notice = container.querySelector('.library-notice--error');
    expect(notice?.textContent).toContain('notes.txt');
    expect(container.querySelectorAll('.library-item')).toHaveLength(0);
  });

  it('assigns a library sample to the selected channel and shows its name on the row', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await importFiles([wav('clap.wav')]);
    await selectChannel('Kick');
    await click(byLabel('Assign clap.wav to Kick'));

    const kickRow = byLabel('Name of Kick').closest('.rack-channel-block') as HTMLElement;
    expect(kickRow.querySelector('.rack-sample-name')?.textContent).toBe('clap.wav');
    expect(kickRow.querySelector('.rack-sample-chip')?.getAttribute('title')).toContain('0.250 s');
  });

  it('shows the inspector region and gain controls for the assigned sample', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await importFiles([wav('hat.wav')]);
    await selectChannel('Kick');
    await click(byLabel('Assign hat.wav to Kick'));

    expect((byLabel('Sample end in seconds') as HTMLInputElement).value).toBe('0.250');
    expect(byLabel('Sample gain percent')).toBeTruthy();
    expect(container.querySelector('.inspector-region .inspector-meta')?.textContent).toContain('0.250 s of 0.250 s');
  });
});

describe('synth inspector', () => {
  it('shows the synth of the selected instrument channel and edits it', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await selectChannel('Soft Synth');
    expect(byLabelPrefix('Synthesizer for Soft Synth')).toBeTruthy();

    const square = [...container.querySelectorAll<HTMLButtonElement>('.synth-wave-button')].find((button) => button.textContent?.trim() === 'square');
    expect(square).toBeTruthy();
    await click(square!);
    expect(square!.getAttribute('aria-pressed')).toBe('true');
    // Editing a parameter turns the named preset into a custom patch.
    expect((byLabel('Synth preset') as HTMLSelectElement).value).toBe('');
  });

  it('adds a synth channel and selects it for editing', async () => {
    await act(async () => {
      root.render(<App />);
    });
    const before = container.querySelectorAll('.rack-channel-block').length;
    await click(byLabel('Add synth channel'));
    expect(container.querySelectorAll('.rack-channel-block')).toHaveLength(before + 1);
    expect(container.querySelector('[aria-label^="Synthesizer for Synth"]')).toBeTruthy();
  });

  it('reports an invalid preset file without changing the patch', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await selectChannel('Soft Synth');
    const input = byLabel('Import synth preset file') as HTMLInputElement;
    const bad = new File(['{"format":"something-else","version":1}'], 'bad.json', { type: 'application/json' });
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [bad], configurable: true });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain('not a Gridline synth preset');
  });
});
