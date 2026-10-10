// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mixer } from './Mixer';
import { MeterViewRegistry } from './meterView';
import { applyProjectCommand, type ProjectCommand } from '../../core/commands';
import { createInitialProject, MAX_MIXER_INSERTS, type Project } from '../../core/project/model';
import { getInsertChannels } from '../../core/mixer/mixerModel';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let recorded: Array<{ command: ProjectCommand; coalesceKey?: string }>;
let registry: MeterViewRegistry;
let clearedClips: string[];

interface HarnessOptions {
  initialProject?: Project;
}

function Harness({ initialProject }: HarnessOptions) {
  return (
    <Mixer
      collapsed={false}
      meterRegistry={registry}
      onClearClip={(mixerChannelId) => clearedClips.push(mixerChannelId)}
      onCommand={(command, options) => {
        recorded.push({ command, coalesceKey: options?.coalesceKey });
        return true;
      }}
      onToggle={() => {}}
      project={initialProject ?? createInitialProject()}
    />
  );
}

function findByLabel(text: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${text}"]`);
  if (!element) throw new Error(`Missing element with aria-label "${text}"`);
  return element;
}

function maybeByLabel(text: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[aria-label="${text}"]`);
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function inputText(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function blur(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  });
}

async function setRange(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function selectOption(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

function renderMixer(options: HarnessOptions = {}) {
  act(() => {
    root.render(<Harness {...options} />);
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  recorded = [];
  clearedClips = [];
  registry = new MeterViewRegistry();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('mixer strips', () => {
  it('renders one strip per insert plus a master strip, each registering a meter view', () => {
    renderMixer();
    const strips = container.querySelectorAll('.mixer-strip');
    expect(strips).toHaveLength(5);
    expect(container.querySelectorAll('.mixer-strip--master')).toHaveLength(1);
    expect(container.querySelector('.mixer-strip--master')).toBe(strips[strips.length - 1]);
    // Every channel registers exactly one meter view in the shared registry.
    expect(registry.size).toBe(5);
    expect(registry.viewIds.sort()).toEqual(['mixer-insert-1', 'mixer-insert-2', 'mixer-insert-3', 'mixer-insert-4', 'mixer-master'].sort());
  });

  it('renames a channel on blur and reverts an empty name', async () => {
    renderMixer();
    const input = container.querySelector<HTMLInputElement>('[aria-label="Name of mixer channel Kick"]')!;
    await inputText(input, 'Thump');
    await blur(input);
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.channel.rename', channelId: 'mixer-insert-1', name: 'Thump' });
    const countAfterRename = recorded.length;

    // An empty/whitespace name is rejected and the draft snaps back to the saved name.
    await inputText(input, '   ');
    await blur(input);
    expect(recorded).toHaveLength(countAfterRename);
    expect(input.value).toBe('Kick');
  });

  it('moves the fader with a coalesced command and groups a drag into one undo gesture', async () => {
    renderMixer();
    const fader = container.querySelector<HTMLInputElement>('[aria-label="Volume of mixer channel Kick in decibels"]')!;

    await act(async () => {
      fader.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    });
    await setRange(fader, '-6');
    await setRange(fader, '-9');

    const volumeCommands = recorded.filter(({ command }) => command.type === 'mixer.channel.volume.set');
    expect(volumeCommands).toHaveLength(2);
    expect(volumeCommands[0].command).toMatchObject({ type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -6 });
    expect(volumeCommands[1].command).toMatchObject({ type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -9 });
    // Both moves in the gesture share one coalesce key.
    expect(volumeCommands[0].coalesceKey).toBeDefined();
    expect(volumeCommands[0].coalesceKey).toBe(volumeCommands[1].coalesceKey);

    // A new pointer gesture starts a new key.
    await act(async () => {
      fader.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    });
    await setRange(fader, '-12');
    const last = recorded.filter(({ command }) => command.type === 'mixer.channel.volume.set').at(-1)!;
    expect(last.command).toMatchObject({ volumeDb: -12 });
    expect(last.coalesceKey).not.toBe(volumeCommands[0].coalesceKey);
  });

  it('pans a channel and double-clicks back to centre', async () => {
    renderMixer();
    const pan = container.querySelector<HTMLInputElement>('[aria-label="Pan of mixer channel Snare"]')!;
    await setRange(pan, '-0.5');
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.channel.pan.set', channelId: 'mixer-insert-2', pan: -0.5 });
    await act(async () => {
      pan.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    });
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.channel.pan.set', channelId: 'mixer-insert-2', pan: 0 });
  });

  it('toggles mute and solo with pressed state', async () => {
    renderMixer();
    const mute = findByLabel('Mute mixer channel Kick') as HTMLButtonElement;
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    await click(mute);
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.channel.mute.set', channelId: 'mixer-insert-1', muted: true });

    const solo = findByLabel('Solo mixer channel Kick') as HTMLButtonElement;
    await click(solo);
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.channel.solo.set', channelId: 'mixer-insert-1', solo: true });
  });

  it('reorders channels within the insert list', async () => {
    renderMixer();
    await click(findByLabel('Move mixer channel Kick later'));
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.channel.reorder', channelId: 'mixer-insert-1', toIndex: 1 });

    // Kick is at index 0 in the starter project, so "earlier" is disabled.
    renderMixer();
    expect((findByLabel('Move mixer channel Kick earlier') as HTMLButtonElement).disabled).toBe(true);
    expect((findByLabel('Move mixer channel Soft Synth later') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers only legal destinations to the output selector', async () => {
    renderMixer();
    const route = container.querySelector<HTMLSelectElement>('[aria-label="Output of mixer channel Kick"]')!;
    const options = [...route.querySelectorAll('option')].map((option) => option.value);
    expect(options).toContain('mixer-master');
    expect(options).toContain('mixer-insert-2');
    expect(options).not.toContain('mixer-insert-1');

    await selectOption(route, 'mixer-insert-2');
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' });
  });

  it('adds and removes mixer channels', async () => {
    renderMixer();
    await click(findByLabel('Add mixer channel'));
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.channel.add', channel: { role: 'insert', outputId: 'mixer-master' } });

    await click(findByLabel('Remove mixer channel Kick'));
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.channel.remove', channelId: 'mixer-insert-1' });

    // The master strip has no remove button.
    expect(maybeByLabel('Remove mixer channel Master')).toBeNull();
  });

  it('disables adding a channel once the insert limit is reached', () => {
    let project = createInitialProject();
    while (getInsertChannels(project).length < MAX_MIXER_INSERTS) {
      project = applyProjectCommand(project, {
        type: 'mixer.channel.add',
        channel: { id: `mixer-fill-${getInsertChannels(project).length}`, name: `Fill ${getInsertChannels(project).length}`, role: 'insert', volumeDb: 0, pan: 0, muted: false, solo: false, outputId: 'mixer-master', effects: [] },
      });
    }
    renderMixer({ initialProject: project });
    expect((findByLabel('Add mixer channel') as HTMLButtonElement).disabled).toBe(true);
  });

  it('assigns sources to mixer channels from a strip', async () => {
    renderMixer();
    const assign = container.querySelector<HTMLSelectElement>('[aria-label="Mixer channel for channel Kick"]')!;
    expect(assign.value).toBe('mixer-insert-1');
    await selectOption(assign, 'mixer-insert-2');
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.source.assign', sourceId: 'channel-kick', mixerChannelId: 'mixer-insert-2' });
  });

  it('clears every solo from the toolbar', async () => {
    let project = applyProjectCommand(createInitialProject(), { type: 'mixer.channel.solo.set', channelId: 'mixer-insert-1', solo: true });
    renderMixer({ initialProject: project });
    const clear = findByLabel('Clear all mixer solos') as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    await click(clear);
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.solo.clear' });
  });

  it('locks the master bus: no output selector, no solo, and a fixed output label', () => {
    renderMixer();
    expect(maybeByLabel('Output of mixer channel Master')).toBeNull();
    expect(container.textContent).toContain('OUT · LIMITER');
    const masterSolo = findByLabel('Solo mixer channel Master') as HTMLButtonElement;
    expect(masterSolo.disabled).toBe(true);
    // The master fader is still adjustable.
    expect((findByLabel('Volume of mixer channel Master in decibels') as HTMLInputElement).disabled).toBe(false);
  });

  it('registers meter elements and clears a clip indicator on click', async () => {
    renderMixer();
    const strip = container.querySelector('.mixer-strip')!;
    expect(strip.querySelector('[data-meter="fill"]')).toBeTruthy();
    expect(strip.querySelector('[data-meter="peak"]')).toBeTruthy();
    expect(strip.querySelector('[data-meter="clip"]')).toBeTruthy();
    expect(strip.querySelector('[data-meter="readout"]')).toBeTruthy();

    const clip = strip.querySelector<HTMLElement>('[data-meter="clip"]')!;
    await click(clip);
    expect(clearedClips).toEqual(['mixer-insert-1']);
  });
});
