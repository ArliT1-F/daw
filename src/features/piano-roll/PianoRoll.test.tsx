// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PianoRoll } from './PianoRoll';
import { applyProjectCommand, type ProjectCommand } from '../../core/commands';
import { createInitialProject, type Project } from '../../core/project/model';
import { serializeProject, deserializeProject } from '../../core/project/serialization';
import { DEFAULT_KEY_HEIGHT, pitchToY, tickToX } from './pianoRollModel';
import { TICKS_PER_STEP } from '../../core/time/ticks';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let recorded: ProjectCommand[];
let previewed: Array<{ pitch: number; velocity: number }>;

interface HarnessOptions {
  initialProject?: Project;
  playbackActive?: boolean;
  positionStep?: number;
  selectedChannelId?: string;
}

function Harness({
  initialProject,
  playbackActive = false,
  positionStep = 0,
  selectedChannelId = 'channel-bass',
}: HarnessOptions) {
  const [project, setProject] = useState<Project>(() => initialProject ?? createInitialProject());
  const projectRef = useRef(project);
  const [channelId, setChannelId] = useState(selectedChannelId);

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

  const pattern = project.patterns[0];
  return (
    <PianoRoll
      collapsed={false}
      onCommand={handleCommand}
      onPreviewNote={(pitch, velocity) => previewed.push({ pitch, velocity })}
      onSelectChannel={setChannelId}
      onToggle={() => {}}
      pattern={pattern}
      playbackActive={playbackActive}
      project={project}
      selectedChannelId={channelId}
      transport={{ status: playbackActive ? 'playing' : 'stopped', positionStep }}
    />
  );
}

function renderRoll(options: HarnessOptions = {}) {
  act(() => {
    root.render(<Harness {...options} />);
  });
}

function findByLabel(label: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`No element with aria-label "${label}"`);
  return element;
}

async function keyDown(element: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

function grid(): HTMLElement {
  return findByLabel('Piano roll grid');
}

function resetScroll() {
  const surface = grid();
  surface.scrollTop = 0;
  surface.scrollLeft = 0;
  const velocity = container.querySelector('.piano-velocity-scroll') as HTMLElement | null;
  if (velocity) {
    velocity.scrollTop = 0;
    velocity.scrollLeft = 0;
  }
}

function notes(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.piano-note[data-note-id]')];
}

function firePointer(element: HTMLElement, type: string, init: PointerEventInit) {
  element.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init }));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  recorded = [];
  previewed = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PianoRoll', () => {
  it('renders a keyboard, bar markers, velocity lane, and starter notes', () => {
    renderRoll();
    expect(findByLabel('Preview C4')).toBeTruthy();
    expect(findByLabel('Preview C5')).toBeTruthy();
    expect(notes()).toHaveLength(4);
    expect(findByLabel('Note C4 at 01 : 01 : 01, velocity 82 percent')).toBeTruthy();
    expect(findByLabel('Note velocity lane')).toBeTruthy();
    expect(container.querySelector('.piano-ruler-mark--bar')?.textContent).toBe('1');
    expect(container.querySelector('.piano-playhead')).toBeTruthy();
  });

  it('creates a note on an empty grid click in draw mode', async () => {
    renderRoll();
    resetScroll();
    const surface = grid();
    const x = tickToX(6 * TICKS_PER_STEP, 28) + 4;
    const y = pitchToY(64, DEFAULT_KEY_HEIGHT) + 4;
    await act(async () => {
      firePointer(surface, 'pointerdown', { clientX: x, clientY: y, button: 0 });
      firePointer(window as unknown as HTMLElement, 'pointerup', { clientX: x, clientY: y, button: 0 });
    });
    expect(recorded.at(-1)?.type).toBe('pattern.notes.replace');
    expect(notes().length).toBe(5);
    expect(findByLabel('Note E4 at 01 : 02 : 03, velocity 80 percent')).toBeTruthy();
  });

  it('does not create a note when the grid scrolls during the pointer gesture', async () => {
    renderRoll();
    resetScroll();
    const surface = grid();
    const x = tickToX(6 * TICKS_PER_STEP, 28) + 4;
    const y = pitchToY(64, DEFAULT_KEY_HEIGHT) + 4;
    await act(async () => {
      firePointer(surface, 'pointerdown', { clientX: x, clientY: y, button: 0 });
      surface.scrollTop = 40;
      surface.dispatchEvent(new window.Event('scroll', { bubbles: true }));
      firePointer(window as unknown as HTMLElement, 'pointerup', { clientX: x, clientY: y, button: 0 });
    });
    expect(notes()).toHaveLength(4);
    expect(recorded.some((command) => command.type === 'pattern.notes.replace')).toBe(false);
  });

  it('selects a note on click and deletes it with Backspace', async () => {
    renderRoll();
    resetScroll();
    const y = pitchToY(60, DEFAULT_KEY_HEIGHT) + 4;
    await act(async () => {
      firePointer(grid(), 'pointerdown', { clientX: 8, clientY: y, button: 0 });
      firePointer(window as unknown as HTMLElement, 'pointerup', { clientX: 8, clientY: y, button: 0 });
    });
    const note = findByLabel('Note C4 at 01 : 01 : 01, velocity 82 percent');
    expect(note.getAttribute('aria-pressed')).toBe('true');

    const workspace = container.querySelector('.piano-roll-workspace') as HTMLElement;
    await keyDown(workspace, 'ArrowRight');
    const moved = recorded.at(-1);
    expect(moved?.type).toBe('pattern.notes.replace');
    if (moved?.type === 'pattern.notes.replace') {
      const c4 = moved.notes.find((note) => note.id === 'note-bass-1');
      expect(c4?.startTick).toBe(TICKS_PER_STEP);
      expect(Number.isInteger(c4?.startTick)).toBe(true);
    }

    await keyDown(workspace, 'Backspace');
    expect(recorded.at(-1)?.type).toBe('pattern.notes.replace');
    expect(notes()).toHaveLength(3);
  });

  it('copies and pastes selected notes as new ids', async () => {
    renderRoll();
    resetScroll();
    await act(async () => {
      firePointer(grid(), 'pointerdown', { clientX: 8, clientY: pitchToY(60, DEFAULT_KEY_HEIGHT) + 4, button: 0 });
      firePointer(window as unknown as HTMLElement, 'pointerup', { clientX: 8, clientY: pitchToY(60, DEFAULT_KEY_HEIGHT) + 4, button: 0 });
    });
    const workspace = container.querySelector('.piano-roll-workspace') as HTMLElement;
    await keyDown(workspace, 'c', { ctrlKey: true });
    await keyDown(workspace, 'v', { ctrlKey: true });
    expect(notes().length).toBeGreaterThanOrEqual(5);
  });

  it('edits velocity from the velocity lane', async () => {
    renderRoll();
    resetScroll();
    const lane = findByLabel('Note velocity lane');
    await act(async () => {
      firePointer(lane, 'pointerdown', { clientX: 8, clientY: 0, button: 0 });
      firePointer(window as unknown as HTMLElement, 'pointerup', { clientX: 8, clientY: 0, button: 0 });
    });
    const command = recorded.at(-1);
    expect(command?.type).toBe('pattern.notes.replace');
    if (command?.type === 'pattern.notes.replace') {
      const c4 = command.notes.find((note) => note.pitch === 60 && note.startTick === 0);
      expect(c4?.velocity).toBe(1);
    }
  });

  it('previews pitches from the keyboard on instrument channels', async () => {
    renderRoll();
    await act(async () => {
      findByLabel('Preview C4').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(previewed.some((item) => item.pitch === 60)).toBe(true);
  });

  it('exposes snap and length presets', async () => {
    renderRoll();
    const snap = findByLabel('Grid snap') as HTMLSelectElement;
    expect(snap.value).toBe('1/16');
    await act(async () => {
      snap.value = '1/8t';
      snap.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect((findByLabel('Grid snap') as HTMLSelectElement).value).toBe('1/8t');
    expect(findByLabel('Note length preset')).toBeTruthy();
  });

  it('keeps serialized notes in integer ticks after an edit', async () => {
    renderRoll();
    resetScroll();
    const x = tickToX(2 * TICKS_PER_STEP, 28) + 4;
    const y = pitchToY(61, DEFAULT_KEY_HEIGHT) + 4;
    await act(async () => {
      firePointer(grid(), 'pointerdown', { clientX: x, clientY: y, button: 0 });
      firePointer(window as unknown as HTMLElement, 'pointerup', { clientX: x, clientY: y, button: 0 });
    });
    const command = recorded.at(-1);
    expect(command?.type).toBe('pattern.notes.replace');
    if (command?.type !== 'pattern.notes.replace') throw new Error('expected replace');
    const project = createInitialProject();
    project.patterns[0].notes['channel-bass'] = command.notes;
    const roundTrip = deserializeProject(serializeProject(project));
    for (const note of roundTrip.patterns[0].notes['channel-bass']) {
      expect(Number.isInteger(note.startTick)).toBe(true);
      expect(Number.isInteger(note.durationTicks)).toBe(true);
    }
  });

  it('switches lanes from the channel select', async () => {
    renderRoll();
    const select = findByLabel('Piano roll channel') as HTMLSelectElement;
    await act(async () => {
      select.value = 'channel-kick';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(notes()).toHaveLength(0);
    expect(container.textContent).toContain('0 NOTES');
  });
});
