// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelRack, type ChannelSampleStatus } from './ChannelRack';
import { applyProjectCommand, type ProjectCommand } from '../../core/commands';
import { createInitialProject, type Project } from '../../core/project/model';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let recorded: ProjectCommand[];

interface HarnessOptions {
  initialProject?: Project;
  playbackActive?: boolean;
  positionStep?: number;
  transportPlaying?: boolean;
  sampleStatus?: Record<string, ChannelSampleStatus>;
  activityAtStep?: Map<number, Set<string>>;
  onLoadSample?: (channelId: string, file: File) => void;
  onDismissSampleError?: (channelId: string) => void;
  onPreviewChannel?: (channelId: string) => void;
}

function Harness({
  initialProject,
  playbackActive = false,
  positionStep = 0,
  transportPlaying = false,
  sampleStatus = {},
  activityAtStep = new Map<number, Set<string>>(),
  onLoadSample = vi.fn(),
  onDismissSampleError = vi.fn(),
  onPreviewChannel = vi.fn(),
}: HarnessOptions) {
  const [project, setProject] = useState<Project>(() => initialProject ?? createInitialProject());
  const projectRef = useRef(project);
  const [selectedPatternId, setSelectedPatternId] = useState('pattern-main');
  const [selectedChannelId, setSelectedChannelId] = useState(project.channels[0]?.id ?? '');

  function handleCommand(command: ProjectCommand): boolean {
    recorded.push(command);
    try {
      const next = applyProjectCommand(projectRef.current, command);
      const changed = next !== projectRef.current;
      projectRef.current = next;
      if (changed) setProject(next);
      return changed;
    } catch {
      return false;
    }
  }

  const pattern = project.patterns.find((item) => item.id === selectedPatternId) ?? project.patterns[0];
  return (
    <ChannelRack
      activityAtStep={activityAtStep}
      collapsed={false}
      onCommand={handleCommand}
      onDismissSampleError={onDismissSampleError}
      onLoadSample={onLoadSample}
      onPreviewChannel={onPreviewChannel}
      onSelectPattern={setSelectedPatternId}
      onToggle={() => {}}
      pattern={pattern}
      playbackActive={playbackActive}
      project={project}
      sampleStatus={sampleStatus}
      selectedPatternId={pattern.id}
      selectedChannelId={selectedChannelId}
      onSelectChannel={setSelectedChannelId}
      isAssetLoaded={() => true}
      onAssignAsset={() => {}}
      transport={{ status: transportPlaying ? 'playing' : 'stopped', positionStep }}
    />
  );
}

function renderRack(options: HarnessOptions = {}) {
  act(() => {
    root.render(<Harness {...options} />);
  });
}

function findByLabel(label: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`No element with aria-label "${label}"`);
  return element;
}

function maybeByLabel(label: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('No value setter');
  setter.call(element, value);
}

async function inputText(element: HTMLInputElement, value: string) {
  await act(async () => {
    setNativeValue(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function blur(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  });
}

async function keyDown(element: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

function stepsOfRow(index: number): HTMLButtonElement[] {
  const row = container.querySelectorAll<HTMLElement>('.rack-channel-block')[index];
  if (!row) throw new Error(`No channel row at index ${index}`);
  return [...row.querySelectorAll<HTMLButtonElement>('.rack-step')];
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  recorded = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelRack step grid', () => {
  it('renders one row per channel with 16 keyboard-accessible steps', () => {
    renderRack();
    const kickFirst = stepsOfRow(0);
    expect(kickFirst).toHaveLength(16);
    expect(stepsOfRow(3)).toHaveLength(16);
    // Starter pattern: kick on steps 1 and 9, off elsewhere.
    expect(kickFirst[0].getAttribute('aria-pressed')).toBe('true');
    expect(kickFirst[1].getAttribute('aria-pressed')).toBe('false');
    expect(kickFirst[8].getAttribute('aria-pressed')).toBe('true');
    expect(kickFirst[0].getAttribute('aria-label')).toBe('Kick step 1, on, velocity 85 percent');
    expect(kickFirst[1].getAttribute('aria-label')).toBe('Kick step 2, off');
  });

  it('toggles steps on click through a pattern.step.set command', async () => {
    renderRack();
    const kick = stepsOfRow(0);
    await click(kick[1]);
    expect(recorded.at(-1)).toMatchObject({
      type: 'pattern.step.set',
      patternId: 'pattern-main',
      channelId: 'channel-kick',
      step: 1,
      active: true,
    });
    // The row re-renders from real project state.
    expect(stepsOfRow(0)[1].getAttribute('aria-pressed')).toBe('true');

    await click(stepsOfRow(0)[1]);
    expect(recorded.at(-1)).toMatchObject({ type: 'pattern.step.set', step: 1, active: false });
    expect(stepsOfRow(0)[1].getAttribute('aria-pressed')).toBe('false');
  });

  it('adjusts velocity with arrow keys, Delete clears, and the wheel nudges', async () => {
    renderRack();
    const step = stepsOfRow(0)[0];
    expect(step.dataset.velocity).toBe('85');

    await keyDown(step, 'ArrowUp');
    expect(recorded.at(-1)).toMatchObject({ type: 'pattern.step.set', step: 0, active: true, velocity: 0.9 });
    expect(stepsOfRow(0)[0].dataset.velocity).toBe('90');

    await keyDown(stepsOfRow(0)[0], 'ArrowDown', { shiftKey: true });
    expect(recorded.at(-1)).toMatchObject({ velocity: 0.89 });

    await act(async () => {
      stepsOfRow(0)[0].dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    expect(recorded.at(-1)).toMatchObject({ type: 'pattern.step.set', velocity: 0.94 });

    await keyDown(stepsOfRow(0)[0], 'Delete');
    expect(recorded.at(-1)).toMatchObject({ type: 'pattern.step.set', step: 0, active: false });
    expect(stepsOfRow(0)[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('paints velocity in velocity mode from pointer position', async () => {
    renderRack();
    const modeButton = findByLabel('Velocity editing mode is off');
    await click(modeButton);
    expect(findByLabel('Velocity editing mode is on').getAttribute('aria-pressed')).toBe('true');

    const step = stepsOfRow(0)[2];
    await act(async () => {
      // jsdom rects are zeroed: top = clientY 0 maps to full velocity.
      step.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientY: 0, buttons: 1 }));
    });
    expect(recorded.at(-1)).toMatchObject({ type: 'pattern.step.set', channelId: 'channel-kick', step: 2, active: true, velocity: 1 });
    expect(stepsOfRow(0)[2].getAttribute('aria-pressed')).toBe('true');
    expect(stepsOfRow(0)[2].dataset.velocity).toBe('100');
  });

  it('shows no playhead or activity while the engine is not actually playing', () => {
    renderRack({ transportPlaying: true, playbackActive: false, positionStep: 5, activityAtStep: new Map([[5, new Set(['channel-kick'])]]) });
    expect(container.querySelectorAll('.rack-step--playhead')).toHaveLength(0);
    expect(container.querySelectorAll('.rack-step-number--playhead')).toHaveLength(0);
    expect(container.querySelectorAll('.rack-led--on')).toHaveLength(0);
  });

  it('highlights the scheduled column and channel activity while playing', () => {
    renderRack({ transportPlaying: true, playbackActive: true, positionStep: 5, activityAtStep: new Map([[5, new Set(['channel-kick'])]]) });
    expect(stepsOfRow(0)[5].classList.contains('rack-step--playhead')).toBe(true);
    expect(stepsOfRow(1)[5].classList.contains('rack-step--playhead')).toBe(true);
    expect(container.querySelectorAll('.rack-step-number--playhead')).toHaveLength(1);
    // Only the channel with an event at this step lights up.
    expect(container.querySelectorAll('.rack-channel-block--silent')).toHaveLength(0);
    const leds = container.querySelectorAll('.rack-led');
    expect(leds[0].classList.contains('rack-led--on')).toBe(true);
    expect(leds[1].classList.contains('rack-led--on')).toBe(false);
  });
});

describe('ChannelRack channel controls', () => {
  it('mutes and solos channels with pressed state feedback', async () => {
    renderRack();
    const mute = findByLabel('Mute Kick');
    await click(mute);
    expect(recorded.at(-1)).toMatchObject({ type: 'channel.mute.set', channelId: 'channel-kick', muted: true });
    expect(findByLabel('Unmute Kick').getAttribute('aria-pressed')).toBe('true');
    // Muted rows are dimmed so the mix state is visible at a glance.
    expect(container.querySelectorAll('.rack-channel-block--silent')[0]).toBeTruthy();

    const solo = findByLabel('Solo Closed Hat');
    await click(solo);
    expect(recorded.at(-1)).toMatchObject({ type: 'channel.solo.set', channelId: 'channel-hat', solo: true });
    expect(findByLabel('Unsolo Closed Hat').getAttribute('aria-pressed')).toBe('true');
    // With solo active, non-soloed rows read as silent.
    expect(container.querySelectorAll('.rack-channel-block--silent').length).toBeGreaterThanOrEqual(3);
  });

  it('renames channels through the inline input on blur', async () => {
    renderRack();
    const input = container.querySelector<HTMLInputElement>('[aria-label="Name of Kick"]');
    expect(input).toBeTruthy();
    await inputText(input!, 'Big Kick');
    await blur(input!);
    expect(recorded.at(-1)).toMatchObject({ type: 'channel.rename', channelId: 'channel-kick', name: 'Big Kick' });
    expect(maybeByLabel('Mute Big Kick')).toBeTruthy();
    expect(maybeByLabel('Mute Kick')).toBeNull();
  });

  it('adds a new audible drum channel', async () => {
    renderRack();
    await click(findByLabel('Add channel'));
    expect(recorded.at(-1)).toMatchObject({
      type: 'channel.add',
      channel: { kind: 'drum', mixerChannelId: 'mixer-insert-1' },
    });
    expect(container.querySelectorAll('.rack-channel-block')).toHaveLength(5);
  });

  it('previews a channel and disables preview while its sample loads', async () => {
    const onPreviewChannel = vi.fn();
    renderRack({ onPreviewChannel, sampleStatus: { 'channel-snare': { status: 'loading', name: 's.wav' } } });

    await click(findByLabel('Preview Kick'));
    expect(onPreviewChannel).toHaveBeenCalledWith('channel-kick');

    expect((findByLabel('Preview Snare') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('LOADING…');
  });
});

describe('ChannelRack sample loading', () => {
  it('hands dropped files to the loader for that channel', async () => {
    const onLoadSample = vi.fn();
    renderRack({ onLoadSample });
    const row = container.querySelectorAll<HTMLElement>('.rack-channel-block')[1];

    await act(async () => {
      row.dispatchEvent(new window.Event('dragover', { bubbles: true, cancelable: true }));
    });
    expect(row.classList.contains('rack-channel-block--drop')).toBe(true);

    const file = new File(['RIFF'], 'snare.wav', { type: 'audio/wav' });
    await act(async () => {
      const drop = new window.Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
      Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
      row.dispatchEvent(drop);
    });
    expect(onLoadSample).toHaveBeenCalledWith('channel-snare', file);
    expect(row.classList.contains('rack-channel-block--drop')).toBe(false);
  });

  it('loads files through the per-row file input', async () => {
    const onLoadSample = vi.fn();
    renderRack({ onLoadSample });
    const input = container.querySelector<HTMLInputElement>('[aria-label="Load an audio sample into Kick"]');
    expect(input).toBeTruthy();
    const file = new File(['RIFF'], 'kick.wav', { type: 'audio/wav' });
    await act(async () => {
      Object.defineProperty(input!, 'files', { value: [file], configurable: true });
      input!.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(onLoadSample).toHaveBeenCalledWith('channel-kick', file);
    // The input resets so the same file can be picked again.
    expect(input!.value).toBe('');
  });

  it('renders per-channel loading and error states with dismissal', async () => {
    const onDismissSampleError = vi.fn();
    renderRack({
      onDismissSampleError,
      sampleStatus: {
        'channel-kick': { status: 'error', name: 'bad.txt', message: '“bad.txt” is not a supported audio file. Try WAV, MP3, OGG, FLAC, or M4A.' },
        'channel-hat': { status: 'loading', name: 'h.wav' },
      },
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('not a supported audio file');
    await click(alert!.querySelector<HTMLElement>('.rack-row-error-dismiss')!);
    expect(onDismissSampleError).toHaveBeenCalledWith('channel-kick');
    expect(container.textContent).toContain('LOADING…');
  });

  it('shows a loaded sample chip with a clear control', async () => {
    const projectWithSample = applyProjectCommand(createInitialProject(), {
      type: 'channel.sample.assign',
      channelId: 'channel-kick',
      sampleId: 'sample-1',
      sampleName: 'thump.wav',
    });
    renderRack({ initialProject: projectWithSample });

    expect(container.textContent).toContain('thump.wav');
    await click(findByLabel('Remove loaded sample from Kick'));
    expect(recorded.at(-1)).toMatchObject({ type: 'channel.sample.clear', channelId: 'channel-kick' });
    expect(container.textContent).not.toContain('thump.wav');
    expect(container.textContent).toContain('DRM');
  });
});

describe('ChannelRack pattern controls', () => {
  it('duplicates the current pattern and switches selection to the copy', async () => {
    renderRack();
    await click(findByLabel('Duplicate current pattern'));
    expect(recorded.at(-1)).toMatchObject({ type: 'pattern.duplicate', patternId: 'pattern-main' });
    const duplicate = recorded.at(-1) as Extract<ProjectCommand, { type: 'pattern.duplicate' }>;
    expect(duplicate.newPatternId).not.toBe('pattern-main');

    const select = container.querySelector<HTMLSelectElement>('[aria-label="Selected pattern"]')!;
    expect(select.value).toBe(duplicate.newPatternId);
    expect(select.options).toHaveLength(2);
    expect((container.querySelector('[aria-label="Pattern name"]') as HTMLInputElement).value).toBe('Pattern 01 copy');
  });

  it('clears the pattern with one command', async () => {
    renderRack();
    await click(findByLabel('Clear current pattern'));
    expect(recorded.at(-1)).toMatchObject({ type: 'pattern.clear', patternId: 'pattern-main' });
    expect(stepsOfRow(0).every((step) => step.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(container.querySelector('.panel-badge')!.textContent).toContain('4 CH · 16 STEPS');
  });

  it('toggles the grid between 16 and 32 steps', async () => {
    renderRack();
    const lengthButton = container.querySelector<HTMLButtonElement>('.rack-length-button')!;
    expect(lengthButton.textContent).toContain('16');
    await click(lengthButton);
    expect(recorded.at(-1)).toMatchObject({ type: 'pattern.length.set', patternId: 'pattern-main', lengthSteps: 32 });
    expect(stepsOfRow(0)).toHaveLength(32);
    expect(stepsOfRow(0)[20]).toBeTruthy();
    expect(container.querySelector('.rack-length-button')!.textContent).toContain('32');
  });

  it('creates a new empty pattern and selects it', async () => {
    renderRack();
    await click(findByLabel('Add a new pattern'));
    expect(recorded.at(-1)).toMatchObject({ type: 'pattern.add' });
    const added = recorded.at(-1) as Extract<ProjectCommand, { type: 'pattern.add' }>;
    expect(added.pattern.steps['channel-kick'].every((step) => step === false)).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Selected pattern"]')!.value).toBe(added.pattern.id);
  });

  it('renames the pattern via the toolbar input', async () => {
    renderRack();
    const input = container.querySelector<HTMLInputElement>('[aria-label="Pattern name"]')!;
    await inputText(input, 'Deep Groove');
    await blur(input);
    expect(recorded.at(-1)).toMatchObject({ type: 'pattern.rename', patternId: 'pattern-main', name: 'Deep Groove' });
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Selected pattern"]')!.value).toBe('pattern-main');
  });

  it('switches patterns through the selector', async () => {
    renderRack();
    await click(findByLabel('Duplicate current pattern'));
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Selected pattern"]')!;
    await act(async () => {
      setNativeValue(select, 'pattern-main');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect((container.querySelector('[aria-label="Pattern name"]') as HTMLInputElement).value).toBe('Pattern 01');
  });

  it('commits swing changes as a project.swing.set command', async () => {
    renderRack();
    const slider = container.querySelector<HTMLInputElement>('[aria-label="Swing amount percent"]')!;
    await inputText(slider, '50');
    expect(slider.value).toBe('50');
    await act(async () => {
      slider.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
    });
    expect(recorded.at(-1)).toMatchObject({ type: 'project.swing.set', swing: 0.5 });
    expect(container.querySelector('.rack-swing-value')!.textContent).toBe('50%');
  });
});
