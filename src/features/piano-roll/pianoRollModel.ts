import type { Note, TimeSignature } from '../../core/project/model';
import {
  TICKS_PER_QUARTER_NOTE,
  TICKS_PER_STEP,
  floorSnapTicks,
  patternLengthTicks,
  quantizeTicks,
  ticksPerBar,
} from '../../core/time/ticks';

export const MIDI_PITCH_MIN = 0;
export const MIDI_PITCH_MAX = 127;
export const PITCH_COUNT = MIDI_PITCH_MAX - MIDI_PITCH_MIN + 1;

export const DEFAULT_PX_PER_STEP = 28;
export const MIN_PX_PER_STEP = 12;
export const MAX_PX_PER_STEP = 96;
export const DEFAULT_KEY_HEIGHT = 16;
export const MIN_KEY_HEIGHT = 10;
export const MAX_KEY_HEIGHT = 28;
export const KEYBOARD_WIDTH = 52;
export const VELOCITY_LANE_HEIGHT = 56;
export const RULER_HEIGHT = 22;
export const RESIZE_HANDLE_PX = 7;
export const DRAG_THRESHOLD_PX = 4;
export const DEFAULT_NOTE_VELOCITY = 0.8;
export const DEFAULT_SNAP_ID = '1/16';
export const DEFAULT_LENGTH_ID = '1/16';

const PITCH_CLASSES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

export type EditorTool = 'draw' | 'select';
export type ResizeEdge = 'start' | 'end';
export type NoteHitEdge = 'body' | ResizeEdge;

export interface GridSnapOption {
  id: string;
  label: string;
  /** Ticks per grid cell. `bar` is derived from the time signature. */
  ticks?: number;
  bar?: boolean;
}

export interface LengthPreset {
  id: string;
  label: string;
  ticks?: number;
  bar?: boolean;
}

export const GRID_SNAP_OPTIONS: readonly GridSnapOption[] = [
  { id: '1/4', label: '1/4', ticks: TICKS_PER_QUARTER_NOTE },
  { id: '1/8', label: '1/8', ticks: TICKS_PER_QUARTER_NOTE / 2 },
  { id: '1/8t', label: '1/8T', ticks: TICKS_PER_QUARTER_NOTE / 3 },
  { id: '1/16', label: '1/16', ticks: TICKS_PER_QUARTER_NOTE / 4 },
  { id: '1/16t', label: '1/16T', ticks: TICKS_PER_QUARTER_NOTE / 6 },
  { id: '1/32', label: '1/32', ticks: TICKS_PER_QUARTER_NOTE / 8 },
  { id: '1/32t', label: '1/32T', ticks: TICKS_PER_QUARTER_NOTE / 12 },
  { id: '1/64', label: '1/64', ticks: TICKS_PER_QUARTER_NOTE / 16 },
  { id: 'bar', label: 'Bar', bar: true },
  { id: 'off', label: 'Off', ticks: 1 },
];

export const LENGTH_PRESETS: readonly LengthPreset[] = [
  { id: '1/16', label: '1/16', ticks: TICKS_PER_QUARTER_NOTE / 4 },
  { id: '1/8', label: '1/8', ticks: TICKS_PER_QUARTER_NOTE / 2 },
  { id: '1/4', label: '1/4', ticks: TICKS_PER_QUARTER_NOTE },
  { id: '1/2', label: '1/2', ticks: TICKS_PER_QUARTER_NOTE * 2 },
  { id: 'bar', label: 'Bar', bar: true },
];

export interface PianoRollLayout {
  pxPerStep: number;
  keyHeight: number;
  lengthTicks: number;
  snapTicks: number;
}

export function pitchLabel(pitch: number): string {
  const wrapped = ((Math.floor(pitch) % 12) + 12) % 12;
  return `${PITCH_CLASSES[wrapped]}${Math.floor(pitch / 12) - 1}`;
}

export function isBlackKey(pitch: number): boolean {
  return BLACK_PITCH_CLASSES.has(((Math.floor(pitch) % 12) + 12) % 12);
}

export function clampVelocity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NOTE_VELOCITY;
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

export function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 60;
  return Math.min(MIDI_PITCH_MAX, Math.max(MIDI_PITCH_MIN, Math.round(pitch)));
}

export function clampPxPerStep(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PX_PER_STEP;
  return Math.min(MAX_PX_PER_STEP, Math.max(MIN_PX_PER_STEP, value));
}

export function clampKeyHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_KEY_HEIGHT;
  return Math.min(MAX_KEY_HEIGHT, Math.max(MIN_KEY_HEIGHT, Math.round(value)));
}

export function snapTicksFor(optionId: string, timeSignature: TimeSignature): number {
  const option = GRID_SNAP_OPTIONS.find((item) => item.id === optionId) ?? GRID_SNAP_OPTIONS.find((item) => item.id === DEFAULT_SNAP_ID)!;
  if (option.bar) return Math.max(1, ticksPerBar(timeSignature));
  return Math.max(1, option.ticks ?? 1);
}

export function lengthTicksFor(optionId: string, timeSignature: TimeSignature): number {
  const option = LENGTH_PRESETS.find((item) => item.id === optionId) ?? LENGTH_PRESETS[0];
  if (option.bar) return Math.max(TICKS_PER_STEP, ticksPerBar(timeSignature));
  return Math.max(1, option.ticks ?? TICKS_PER_STEP);
}

export function tickToX(tick: number, pxPerStep: number): number {
  return (tick / TICKS_PER_STEP) * pxPerStep;
}

export function xToTick(x: number, pxPerStep: number): number {
  if (!Number.isFinite(x) || pxPerStep <= 0) return 0;
  return Math.round((x / pxPerStep) * TICKS_PER_STEP);
}

/** High pitches sit at the top of the roll (MIDI 127 at y = 0). */
export function pitchToY(pitch: number, keyHeight: number): number {
  return (MIDI_PITCH_MAX - clampPitch(pitch)) * keyHeight;
}

export function yToPitch(y: number, keyHeight: number): number {
  if (!Number.isFinite(y) || keyHeight <= 0) return MIDI_PITCH_MAX;
  const index = Math.floor(y / keyHeight);
  return clampPitch(MIDI_PITCH_MAX - index);
}

export function gridContentWidth(lengthTicks: number, pxPerStep: number): number {
  return tickToX(lengthTicks, pxPerStep);
}

export function gridContentHeight(keyHeight: number): number {
  return PITCH_COUNT * keyHeight;
}

export function pointerToContent(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  scrollLeft: number,
  scrollTop: number,
): { x: number; y: number } {
  return {
    x: clientX - rect.left + scrollLeft,
    y: clientY - rect.top + scrollTop,
  };
}

export function contentToPitchTick(
  x: number,
  y: number,
  layout: Pick<PianoRollLayout, 'pxPerStep' | 'keyHeight'>,
): { pitch: number; tick: number } {
  return {
    pitch: yToPitch(y, layout.keyHeight),
    tick: Math.max(0, xToTick(x, layout.pxPerStep)),
  };
}

export interface NoteHit {
  note: Note;
  edge: NoteHitEdge;
}

export function hitTestNote(
  notes: readonly Note[],
  x: number,
  y: number,
  layout: Pick<PianoRollLayout, 'pxPerStep' | 'keyHeight'>,
  handlePx = RESIZE_HANDLE_PX,
): NoteHit | null {
  const pitch = yToPitch(y, layout.keyHeight);
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index];
    if (note.pitch !== pitch) continue;
    const x0 = tickToX(note.startTick, layout.pxPerStep);
    const x1 = tickToX(note.startTick + note.durationTicks, layout.pxPerStep);
    if (x < x0 || x > x1) continue;
    const handle = Math.min(handlePx, Math.max(2, (x1 - x0) / 3));
    if (x <= x0 + handle) return { note, edge: 'start' };
    if (x >= x1 - handle) return { note, edge: 'end' };
    return { note, edge: 'body' };
  }
  return null;
}

export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function notesIntersectingRect(
  notes: readonly Note[],
  rect: PixelRect,
  layout: Pick<PianoRollLayout, 'pxPerStep' | 'keyHeight'>,
): Note[] {
  const left = Math.min(rect.x0, rect.x1);
  const right = Math.max(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const bottom = Math.max(rect.y0, rect.y1);
  if (right - left < 1 && bottom - top < 1) return [];
  return notes.filter((note) => {
    const x0 = tickToX(note.startTick, layout.pxPerStep);
    const x1 = tickToX(note.startTick + note.durationTicks, layout.pxPerStep);
    const y0 = pitchToY(note.pitch, layout.keyHeight);
    const y1 = y0 + layout.keyHeight;
    return x0 < right && x1 > left && y0 < bottom && y1 > top;
  });
}

export function createNote(input: {
  id: string;
  pitch: number;
  startTick: number;
  durationTicks: number;
  velocity?: number;
}): Note {
  return {
    id: input.id,
    pitch: clampPitch(input.pitch),
    startTick: Math.max(0, Math.floor(input.startTick)),
    durationTicks: Math.max(1, Math.floor(input.durationTicks)),
    velocity: clampVelocity(input.velocity ?? DEFAULT_NOTE_VELOCITY),
  };
}

export function placeNote(
  startTick: number,
  pitch: number,
  durationTicks: number,
  lengthTicks: number,
  id: string,
  velocity = DEFAULT_NOTE_VELOCITY,
): Note | null {
  if (lengthTicks < 1 || !Number.isFinite(startTick) || startTick >= lengthTicks || startTick < 0) return null;
  const start = Math.floor(startTick);
  const duration = Math.max(1, Math.min(Math.floor(durationTicks), lengthTicks - start));
  if (duration < 1) return null;
  return createNote({ id, pitch, startTick: start, durationTicks: duration, velocity });
}

export function translateNotesAsGroup(
  notes: readonly Note[],
  deltaTicks: number,
  deltaPitch: number,
  lengthTicks: number,
): Note[] {
  if (notes.length === 0) return [];
  const minTick = Math.min(...notes.map((note) => note.startTick));
  const maxEnd = Math.max(...notes.map((note) => note.startTick + note.durationTicks));
  const minPitch = Math.min(...notes.map((note) => note.pitch));
  const maxPitch = Math.max(...notes.map((note) => note.pitch));
  let dt = Math.round(deltaTicks);
  let dp = Math.round(deltaPitch);
  if (minTick + dt < 0) dt = -minTick;
  if (maxEnd + dt > lengthTicks) dt = lengthTicks - maxEnd;
  if (minPitch + dp < MIDI_PITCH_MIN) dp = MIDI_PITCH_MIN - minPitch;
  if (maxPitch + dp > MIDI_PITCH_MAX) dp = MIDI_PITCH_MAX - maxPitch;
  return notes.map((note) => ({
    ...note,
    startTick: note.startTick + dt,
    pitch: note.pitch + dp,
  }));
}

export function resizeNotesAsGroup(
  notes: readonly Note[],
  edge: ResizeEdge,
  deltaTicks: number,
  lengthTicks: number,
  minDurationTicks: number,
): Note[] {
  if (notes.length === 0) return [];
  const minDuration = Math.max(1, Math.floor(minDurationTicks));
  let dt = Math.round(deltaTicks);

  if (edge === 'end') {
    const maxGrow = Math.min(...notes.map((note) => lengthTicks - (note.startTick + note.durationTicks)));
    const maxShrink = Math.min(...notes.map((note) => note.durationTicks - minDuration));
    dt = Math.min(maxGrow, Math.max(-maxShrink, dt));
    return notes.map((note) => ({ ...note, durationTicks: note.durationTicks + dt }));
  }

  const maxLeft = Math.min(...notes.map((note) => note.startTick));
  const maxShrink = Math.min(...notes.map((note) => note.durationTicks - minDuration));
  dt = Math.min(maxShrink, Math.max(-maxLeft, dt));
  return notes.map((note) => ({
    ...note,
    startTick: note.startTick + dt,
    durationTicks: note.durationTicks - dt,
  }));
}

export function quantizeNotes(notes: readonly Note[], gridTicks: number, lengthTicks: number): Note[] {
  const grid = Math.max(1, Math.floor(gridTicks));
  return notes.map((note) => {
    const start = Math.max(0, Math.min(lengthTicks - 1, quantizeTicks(note.startTick, grid)));
    const duration = Math.max(1, Math.min(note.durationTicks, lengthTicks - start));
    return { ...note, startTick: start, durationTicks: duration };
  });
}

export function duplicateNotes(
  notes: readonly Note[],
  offsetTicks: number,
  lengthTicks: number,
  createId: () => string,
): Note[] {
  const copies = notes.map((note) => ({ ...note, id: createId() }));
  return translateNotesAsGroup(copies, offsetTicks, 0, lengthTicks);
}

export function applyLaneEdits(
  lane: readonly Note[],
  upserts: readonly Note[],
  removeIds: ReadonlySet<string>,
): Note[] {
  const next = lane.filter((note) => !removeIds.has(note.id)).map((note) => ({ ...note }));
  const byId = new Map(next.map((note) => [note.id, note]));
  for (const note of upserts) {
    const copy = { ...note };
    const existing = byId.get(copy.id);
    if (existing) {
      Object.assign(existing, copy);
    } else {
      next.push(copy);
      byId.set(copy.id, copy);
    }
  }
  return next;
}

export function replaceSelectedNotes(lane: readonly Note[], selectedIds: ReadonlySet<string>, nextSelected: readonly Note[]): Note[] {
  const replacements = new Map(nextSelected.map((note) => [note.id, note]));
  const kept = lane.filter((note) => !selectedIds.has(note.id) || replacements.has(note.id)).map((note) => {
    const replacement = replacements.get(note.id);
    return replacement ? { ...replacement } : { ...note };
  });
  for (const note of nextSelected) {
    if (!lane.some((item) => item.id === note.id)) kept.push({ ...note });
  }
  return kept;
}

export function pasteNotes(
  lane: readonly Note[],
  clipboard: readonly Note[],
  atTick: number,
  atPitch: number,
  lengthTicks: number,
  createId: () => string,
): Note[] {
  if (clipboard.length === 0) return lane.map((note) => ({ ...note }));
  const originTick = Math.min(...clipboard.map((note) => note.startTick));
  const originPitch = Math.max(...clipboard.map((note) => note.pitch));
  const copies = clipboard.map((note) => ({ ...note, id: createId() }));
  const placed = translateNotesAsGroup(copies, atTick - originTick, atPitch - originPitch, lengthTicks);
  return [...lane.map((note) => ({ ...note })), ...placed];
}

export function setNotesVelocity(notes: readonly Note[], velocity: number): Note[] {
  const next = clampVelocity(velocity);
  return notes.map((note) => ({ ...note, velocity: next }));
}

export function velocityFromLaneY(y: number, laneHeight: number): number {
  if (laneHeight <= 0) return 0;
  return clampVelocity(1 - y / laneHeight);
}

export function snapDeltaTicks(deltaTicks: number, gridTicks: number): number {
  return quantizeTicks(deltaTicks, gridTicks);
}

export function snappedStartForDraw(tick: number, gridTicks: number, lengthTicks: number): number {
  return Math.max(0, Math.min(lengthTicks - 1, floorSnapTicks(tick, gridTicks)));
}

export function durationFromDraw(startTick: number, hoverTick: number, gridTicks: number, lengthTicks: number): number {
  const grid = Math.max(1, Math.floor(gridTicks));
  const rawEnd = Math.max(startTick + 1, hoverTick);
  const snappedEnd = Math.max(startTick + grid, quantizeTicks(rawEnd, grid));
  return Math.max(1, Math.min(snappedEnd, lengthTicks) - startTick);
}

export function patternTicks(lengthSteps: number): number {
  return patternLengthTicks(lengthSteps);
}

export function playheadTickInPattern(playheadSteps: number, lengthSteps: number): number {
  if (!Number.isFinite(playheadSteps) || lengthSteps <= 0) return 0;
  const length = Math.max(1, lengthSteps);
  const wrapped = ((playheadSteps % length) + length) % length;
  return wrapped * TICKS_PER_STEP;
}

export function seekStepFromPatternTick(tick: number, playheadSteps: number, lengthSteps: number): number {
  const length = Math.max(1, lengthSteps);
  const patternStep = tick / TICKS_PER_STEP;
  if (!Number.isFinite(playheadSteps)) return patternStep;
  const cycle = Math.floor(playheadSteps / length);
  return cycle * length + patternStep;
}

export function notesEqual(a: readonly Note[], b: readonly Note[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left.id !== right.id ||
      left.pitch !== right.pitch ||
      left.startTick !== right.startTick ||
      left.durationTicks !== right.durationTicks ||
      left.velocity !== right.velocity
    ) {
      return false;
    }
  }
  return true;
}

export const ALL_PITCHES: readonly number[] = Array.from({ length: PITCH_COUNT }, (_, index) => MIDI_PITCH_MAX - index);
