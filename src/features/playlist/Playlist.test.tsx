// @vitest-environment jsdom
import { act, useReducer, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Playlist } from './Playlist';
import { createProjectHistory, projectHistoryReducer, type ProjectCommand, type ProjectHistoryState } from '../../core/commands';
import { createInitialProject, type Project } from '../../core/project/model';
import { createTestArrangement } from '../../core/arrangement/__fixtures__/testArrangement';
import { deserializeProject, serializeProject } from '../../core/project/serialization';
import { TICKS_PER_STEP as T } from '../../core/time/ticks';
import { TRACK_HEADER_WIDTH as H } from './playlistModel';

let container: HTMLDivElement;
let root: Root;
let latest: ProjectHistoryState;
let commands: ProjectCommand[];
let seeks: number[];
let edits: string[];
let undo: () => void;
let redo: () => void;
const audioLoader = vi.fn<NonNullable<Parameters<typeof Playlist>[0]['onLoadAudio']>>();

function Harness({ initial = createInitialProject(), positionStep = 0 }: { initial?: Project; positionStep?: number }) {
  const [history, dispatch] = useReducer(projectHistoryReducer, initial, createProjectHistory);
  const [patternId, setPatternId] = useState(initial.patterns[0].id);
  const ref = useRef(history);
  ref.current = history;
  latest = history;
  undo = () => dispatch({ type: 'undo' });
  redo = () => dispatch({ type: 'redo' });
  const pattern = history.project.patterns.find((item) => item.id === patternId) ?? history.project.patterns[0];
  return <Playlist project={history.project} pattern={pattern} transport={{ status: 'stopped', positionStep }} collapsed={false} onToggle={() => {}} onCommand={(command) => { commands.push(command); dispatch({ type: 'command', command }); }} onSeek={(step) => seeks.push(step)} onSelectPattern={setPatternId} onEditPattern={(id, clipId) => edits.push(`${id}:${clipId}`)} onLoadAudio={audioLoader} isAudioAssetLoaded={() => true} />;
}
function render(initial?: Project, positionStep = 0) { act(() => root.render(<Harness initial={initial} positionStep={positionStep} />)); }
function label(text: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${text}"]`);
  if (!element) throw new Error(`No element: ${text}`);
  return element;
}
function clip(id: string): HTMLElement { return container.querySelector<HTMLElement>(`[data-clip-id="${id}"]`)!; }
async function click(element: HTMLElement, init: MouseEventInit = {}) { await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ...init }))); }
async function key(key: string, init: KeyboardEventInit = {}) { await act(async () => label('Playlist editor').dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))); }
function pointer(element: HTMLElement | Window, type: string, x: number, y: number, init: PointerEventInit = {}) {
  element.dispatchEvent(new window.PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true, ...init }));
}
async function changeInput(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function blur(element: HTMLElement) { await act(async () => element.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))); }

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  commands = []; seeks = []; edits = []; audioLoader.mockReset(); audioLoader.mockResolvedValue(null);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Playlist editor', () => {
  it('renders independent lanes, names, pattern/audio distinctions, sources, and an absolute parked playhead', () => {
    render(createTestArrangement(), 40);
    expect(container.querySelectorAll('.timeline-track-row')).toHaveLength(3);
    expect(container.querySelectorAll('.playlist-clip--pattern')).toHaveLength(3);
    expect(container.querySelectorAll('.playlist-clip--audio')).toHaveLength(1);
    expect(label('Seek to bar 3')).toBeTruthy();
    expect(label('Seek to bar 3 beat 2')).toBeTruthy();
    expect(container.querySelector<HTMLElement>('.timeline-playhead')?.style.transform).toBe('translateX(240px)');
    expect(container.textContent).toContain('Texture.wav');
  });
  it('places reusable pattern instances in occupied bars instead of disallowing overlaps', async () => {
    render();
    const source = latest.project.patterns;
    await click(label('Place Pattern 01 clip at bar 1'));
    expect(latest.project.playlist).toHaveLength(2);
    expect(latest.project.patterns).toBe(source);
    expect(latest.project.playlist[1]).toMatchObject({ kind: 'pattern', patternId: 'pattern-main', startTick: 0, durationTicks: 384 });
    expect(container.querySelectorAll('.playlist-clip')).toHaveLength(2);
    const tops = [...container.querySelectorAll<HTMLElement>('.playlist-clip')].map((element) => element.style.top);
    expect(new Set(tops).size).toBe(2);
  });
  it('creates, renames, reorders, mutes and solos a track through visible controls', async () => {
    render();
    await click(label('Add Playlist track'));
    await changeInput(label('Track name Track 4') as HTMLInputElement, 'Textures');
    await blur(label('Track name Track 4'));
    await click(label('Mute track Textures'));
    await click(label('Solo track Textures'));
    await click(label('Move track Textures up'));
    expect(latest.project.tracks[2]).toMatchObject({ name: 'Textures', muted: true, solo: true });
    expect(label('Mute track Textures').getAttribute('aria-pressed')).toBe('true');
    expect(label('Solo track Textures').getAttribute('aria-pressed')).toBe('true');
  });
  it('selecting a clip does not delete it, and double-click opens its actual shared source', async () => {
    render();
    await click(clip('clip-main-0'));
    expect(latest.project.playlist).toHaveLength(1);
    expect(clip('clip-main-0').getAttribute('aria-pressed')).toBe('true');
    await act(async () => clip('clip-main-0').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
    expect(edits).toEqual(['pattern-main:clip-main-0']);
    expect(label('Clip start beat')).toBeTruthy();
  });
  it('previews pointer movement without writing history, then commits a snapped cross-track move once', async () => {
    render(createTestArrangement());
    const sources = latest.project.patterns;
    await act(async () => pointer(clip('clip-a'), 'pointerdown', H + 104, 68));
    await act(async () => pointer(window, 'pointermove', H + 128, 130));
    expect(commands).toHaveLength(0);
    expect(latest.project.playlist[0].startTick).toBe(16 * T);
    await act(async () => pointer(window, 'pointerup', H + 128, 130));
    expect(commands).toHaveLength(1);
    expect(latest.project.playlist[0]).toMatchObject({ startTick: 20 * T, trackId: 'track-audio' });
    expect(latest.project.patterns).toBe(sources);
    await act(async () => undo());
    expect(latest.project.playlist[0]).toMatchObject({ startTick: 16 * T, trackId: 'track-main' });
  });
  it('right edge resize and left trim are undoable instance edits, not source edits', async () => {
    render();
    const original = latest.project.patterns[0];
    const edge = clip('clip-main-0').querySelector<HTMLElement>('.playlist-clip-handle--end')!;
    await act(async () => pointer(edge, 'pointerdown', H + 380, 68));
    await act(async () => pointer(window, 'pointermove', H + 404, 68));
    await act(async () => pointer(window, 'pointerup', H + 404, 68));
    expect(latest.project.playlist[0].durationTicks).toBe(68 * T);
    const start = clip('clip-main-0').querySelector<HTMLElement>('.playlist-clip-handle--start')!;
    await act(async () => pointer(start, 'pointerdown', H + 2, 68));
    await act(async () => pointer(window, 'pointermove', H + 26, 68));
    await act(async () => pointer(window, 'pointerup', H + 26, 68));
    expect(latest.project.playlist[0]).toMatchObject({ startTick: 4 * T, durationTicks: 64 * T, sourceOffsetTicks: 4 * T });
    expect(latest.project.patterns[0]).toBe(original);
  });
  it('Alt-drag duplicates an instance without duplicating its pattern source', async () => {
    render();
    const sources = latest.project.patterns;
    await act(async () => pointer(clip('clip-main-0'), 'pointerdown', H + 16, 68, { altKey: true }));
    await act(async () => pointer(window, 'pointermove', H + 112, 68, { altKey: true }));
    await act(async () => pointer(window, 'pointerup', H + 112, 68));
    expect(latest.project.playlist).toHaveLength(2);
    expect(latest.project.playlist[0].startTick).toBe(0);
    expect(latest.project.playlist[1]).toMatchObject({ startTick: 16 * T, patternId: 'pattern-main' });
    expect(latest.project.patterns).toBe(sources);
  });
  it('shift-select moves/duplicates/deletes multiple clips as one operation, with undo/redo', async () => {
    render(createTestArrangement());
    await click(clip('clip-a'));
    await click(clip('clip-b'), { shiftKey: true });
    expect(container.querySelectorAll('.playlist-clip--selected')).toHaveLength(2);
    await key('ArrowRight');
    expect(latest.project.playlist[0].startTick).toBe(20 * T);
    expect(latest.project.playlist[1].startTick).toBe(28 * T);
    const count = latest.past.length;
    await click(label('Duplicate selected clips'));
    expect(latest.project.playlist).toHaveLength(6);
    expect(latest.past).toHaveLength(count + 1);
    await key('Delete');
    expect(latest.project.playlist).toHaveLength(4);
    await act(async () => undo());
    expect(latest.project.playlist).toHaveLength(6);
    await act(async () => redo());
    expect(latest.project.playlist).toHaveLength(4);
    expect(deserializeProject(serializeProject(latest.project))).toEqual(latest.project);
  });
  it('supports clipboard operations for mixed audio/pattern selections', async () => {
    render(createTestArrangement(), 80);
    await click(clip('clip-a'));
    await click(clip('clip-audio'), { shiftKey: true });
    await key('c', { ctrlKey: true });
    await key('v', { ctrlKey: true });
    expect(latest.project.playlist).toHaveLength(6);
    expect(latest.project.playlist.slice(-2).map((item) => item.startTick)).toEqual([80 * T, 84 * T]);
    expect(latest.project.audioAssets).toHaveLength(1);
    expect(latest.project.patterns).toHaveLength(2);
  });
  it('marquee-selects visible overlapping clips and cancels an uncommitted drag cleanly', async () => {
    const project = createInitialProject();
    project.playlist.push({ ...project.playlist[0], id: 'overlap', startTick: 384, durationTicks: 384 });
    render(project);
    await click(label('Playlist select tool'));
    await act(async () => pointer(label('Patterns arrangement lane'), 'pointerdown', H + 1, 53));
    await act(async () => pointer(window, 'pointermove', H + 300, 130));
    await act(async () => pointer(window, 'pointerup', H + 300, 130));
    expect(container.querySelectorAll('.playlist-clip--selected')).toHaveLength(2);
    await act(async () => pointer(clip('overlap'), 'pointerdown', H + 104, 93));
    await act(async () => pointer(window, 'pointermove', H + 152, 93));
    await act(async () => pointer(window, 'pointercancel', H + 152, 93));
    expect(latest.project).toBe(project);
    expect(commands).toHaveLength(0);
  });
  it('sets loop markers via Shift-drag ruler and seeks the actual song timeline', async () => {
    render();
    const ruler = label('Bar and beat ruler');
    await act(async () => pointer(ruler, 'pointerdown', H + 144, 12, { shiftKey: true }));
    await act(async () => pointer(window, 'pointermove', H + 288, 12, { shiftKey: true }));
    await act(async () => pointer(window, 'pointerup', H + 288, 12, { shiftKey: true }));
    expect(latest.project.settings.loop).toMatchObject({ startTick: 24 * T, endTick: 48 * T });
    // Complete the click belonging to the Shift-drag; it must not also seek.
    await click(ruler);
    expect(seeks).toHaveLength(0);
    await click(label('Seek to bar 3'));
    expect(seeks).toEqual([32]);
  });
  it('adjusts audio start/length/trim and track routing through the inspector', async () => {
    render(createTestArrangement());
    await click(clip('clip-audio'));
    await changeInput(label('Audio source start seconds') as HTMLInputElement, '1.25');
    await blur(label('Audio source start seconds'));
    await changeInput(label('Clip duration beats') as HTMLInputElement, '4');
    await blur(label('Clip duration beats'));
    const audio = latest.project.playlist.find((item) => item.id === 'clip-audio');
    expect(audio).toMatchObject({ sourceOffsetSeconds: 1.25, durationTicks: 16 * T });
  });
  it('imports a file on the selected track and reports rejected loads without an unhandled error', async () => {
    render();
    audioLoader.mockRejectedValueOnce(new Error('The browser could not decode this file.'));
    const file = new File([new Uint8Array([1, 2, 3])], 'texture.wav', { type: 'audio/wav' });
    const input = label('Import an audio file into the Playlist') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(audioLoader).toHaveBeenCalledWith(file, 'track-main', 0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not decode');
    await click(label('Dismiss Playlist import error'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it('scrolls and zooms independently of musical placement, with virtualized ruler/cell counts', async () => {
    const project = createInitialProject();
    project.playlist[0].durationTicks = 100_000 * 384;
    render(project);
    expect(container.querySelectorAll('.timeline-ruler-mark').length).toBeLessThan(100);
    const scroll = label('Scrollable arrangement timeline');
    await act(async () => { scroll.scrollLeft = 96 * 100; scroll.dispatchEvent(new window.Event('scroll')); });
    expect(label('Seek to bar 101')).toBeTruthy();
    const before = latest.project;
    await click(label('Zoom Playlist in'));
    expect(latest.project).toBe(before);
    expect(container.querySelector<HTMLElement>('.playlist-content')?.style.getPropertyValue('--playlist-beat-width')).toBe('30px');
  });
  it('adds/removes serializable tempo markers at the central playhead', async () => {
    render(createInitialProject(), 32);
    await changeInput(label('Tempo marker BPM') as HTMLInputElement, '90');
    await click(label('Set tempo marker at playhead'));
    expect(latest.project.settings.tempoChanges).toEqual([{ tick: 32 * T, bpm: 90 }]);
    await click(label('Tempo 90 BPM at 03 : 01 : 01; remove marker'));
    expect(latest.project.settings.tempoChanges).toEqual([]);
  });

  it('canceling an Alt-drag restores the original selection without copying sources or adding history', async () => {
    render();
    const project = latest.project;
    await act(async () => pointer(clip('clip-main-0'), 'pointerdown', H + 16, 68, { altKey: true }));
    await act(async () => pointer(window, 'pointermove', H + 112, 68, { altKey: true }));
    await key('Escape');
    await act(async () => pointer(window, 'pointerup', H + 112, 68));
    expect(commands).toHaveLength(0);
    expect(latest.project).toBe(project);
    expect(container.querySelectorAll('.playlist-clip')).toHaveLength(1);
    expect(clip('clip-main-0').getAttribute('aria-pressed')).toBe('true');
  });

  it('Escape cancels a focused track-name draft instead of committing it during blur', async () => {
    render();
    const input = label('Track name Patterns') as HTMLInputElement;
    await act(async () => input.focus());
    await changeInput(input, 'Uncommitted draft');
    await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(latest.project.tracks[0].name).toBe('Patterns');
    expect(input.value).toBe('Patterns');
    expect(commands).toHaveLength(0);
  });

  it('an unchanged or canceled clip-name field does not create a source-name override', async () => {
    render();
    await click(clip('clip-main-0'));
    const input = label('Clip name') as HTMLInputElement;
    await act(async () => input.focus());
    await blur(input);
    expect(latest.project.playlist[0].name).toBeUndefined();
    await changeInput(input, 'Canceled instance name');
    await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(input.value).toBe('Pattern 01');
    expect(latest.project.playlist[0].name).toBeUndefined();
    expect(commands).toHaveLength(0);
  });

});
