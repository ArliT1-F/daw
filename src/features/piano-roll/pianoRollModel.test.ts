import { describe, expect, it } from 'vitest';
import type { Note } from '../../core/project/model';
import { TICKS_PER_QUARTER_NOTE, TICKS_PER_STEP, ticksToSeconds } from '../../core/time';
import {
  DEFAULT_NOTE_VELOCITY,
  applyLaneEdits,
  clampVelocity,
  contentToPitchTick,
  createNote,
  duplicateNotes,
  durationFromDraw,
  gridContentHeight,
  gridContentWidth,
  hitTestNote,
  isBlackKey,
  lengthTicksFor,
  notesIntersectingRect,
  notesEqual,
  pasteNotes,
  patternTicks,
  pitchLabel,
  pitchToY,
  placeNote,
  playheadTickInPattern,
  pointerToContent,
  quantizeNotes,
  replaceSelectedNotes,
  resizeNotesAsGroup,
  seekStepFromPatternTick,
  setNotesVelocity,
  snapTicksFor,
  snappedStartForDraw,
  tickToX,
  translateNotesAsGroup,
  velocityFromLaneY,
  xToTick,
  yToPitch,
} from './pianoRollModel';

const FOUR_FOUR = { numerator: 4, denominator: 4 };
const SIX_EIGHT = { numerator: 6, denominator: 8 };

function note(overrides: Partial<Note> & Pick<Note, 'id'>): Note {
  return {
    pitch: 60,
    startTick: 0,
    durationTicks: 24,
    velocity: 0.8,
    ...overrides,
  };
}

describe('piano-roll geometry', () => {
  it('maps ticks and pitches to pixels invertibly', () => {
    const pxPerStep = 28;
    const keyHeight = 16;
    expect(tickToX(0, pxPerStep)).toBe(0);
    expect(tickToX(TICKS_PER_STEP, pxPerStep)).toBe(pxPerStep);
    expect(tickToX(96, pxPerStep)).toBe(4 * pxPerStep);
    expect(xToTick(pxPerStep, pxPerStep)).toBe(TICKS_PER_STEP);
    expect(xToTick(tickToX(48, pxPerStep), pxPerStep)).toBe(48);

    expect(pitchLabel(60)).toBe('C4');
    expect(pitchLabel(69)).toBe('A4');
    expect(pitchLabel(0)).toBe('C-1');
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(60)).toBe(false);

    expect(pitchToY(127, keyHeight)).toBe(0);
    expect(yToPitch(0, keyHeight)).toBe(127);
    expect(yToPitch(pitchToY(60, keyHeight) + 1, keyHeight)).toBe(60);
    expect(gridContentWidth(384, pxPerStep)).toBe(16 * pxPerStep);
    expect(gridContentHeight(keyHeight)).toBe(128 * keyHeight);
  });

  it('keeps note x-positions aligned with the playhead when tempo changes', () => {
    const pxPerStep = 24;
    const tick = 96;
    const x = tickToX(tick, pxPerStep);
    expect(x).toBe(tickToX(tick, pxPerStep));
    expect(playheadTickInPattern(4, 16)).toBe(tick);
    expect(tickToX(playheadTickInPattern(4, 16), pxPerStep)).toBe(x);
    // Audio time changes with tempo; the column does not.
    expect(ticksToSeconds(tick, 120, FOUR_FOUR)).not.toBeCloseTo(ticksToSeconds(tick, 90, FOUR_FOUR), 6);
    expect(tickToX(playheadTickInPattern(4.0, 16), pxPerStep)).toBe(x);
  });

  it('converts pointer coordinates using the scroll offset', () => {
    const point = pointerToContent(40, 20, { left: 10, top: 5 }, 100, 50);
    expect(point).toEqual({ x: 130, y: 65 });
    expect(contentToPitchTick(28, 0, { pxPerStep: 28, keyHeight: 16 })).toEqual({ pitch: 127, tick: 24 });
  });

  it('hit-tests notes and their resize edges', () => {
    const layout = { pxPerStep: 24, keyHeight: 16 };
    const notes = [note({ id: 'a', startTick: 0, durationTicks: 96, pitch: 60 })];
    const y = pitchToY(60, 16) + 8;
    expect(hitTestNote(notes, 4, y, layout)?.edge).toBe('start');
    expect(hitTestNote(notes, tickToX(48, 24), y, layout)?.edge).toBe('body');
    expect(hitTestNote(notes, tickToX(96, 24) - 1, y, layout)?.edge).toBe('end');
    expect(hitTestNote(notes, 10, pitchToY(64, 16), layout)).toBeNull();
  });

  it('selects notes that intersect a marquee rectangle', () => {
    const layout = { pxPerStep: 24, keyHeight: 16 };
    const notes = [
      note({ id: 'a', pitch: 60, startTick: 0, durationTicks: 24 }),
      note({ id: 'b', pitch: 64, startTick: 96, durationTicks: 24 }),
    ];
    const hits = notesIntersectingRect(
      notes,
      { x0: 0, y0: pitchToY(60, 16), x1: 20, y1: pitchToY(60, 16) + 16 },
      layout,
    );
    expect(hits.map((item) => item.id)).toEqual(['a']);
  });
});

describe('note creation, movement, resize, and snapping', () => {
  it('places a note snapped to the grid and clamped to the pattern', () => {
    expect(snappedStartForDraw(10, 24, 384)).toBe(0);
    expect(snappedStartForDraw(24, 24, 384)).toBe(24);
    expect(placeNote(0, 60, 96, 384, 'n1')).toEqual({
      id: 'n1',
      pitch: 60,
      startTick: 0,
      durationTicks: 96,
      velocity: DEFAULT_NOTE_VELOCITY,
    });
    expect(placeNote(360, 60, 96, 384, 'n2')?.durationTicks).toBe(24);
    expect(placeNote(384, 60, 24, 384, 'n3')).toBeNull();
    expect(durationFromDraw(0, 10, 24, 384)).toBe(24);
    expect(durationFromDraw(0, 48, 24, 384)).toBe(48);
  });

  it('moves a group without letting any note leave the pattern or MIDI range', () => {
    const notes = [
      note({ id: 'a', pitch: 60, startTick: 0, durationTicks: 24 }),
      note({ id: 'b', pitch: 62, startTick: 360, durationTicks: 24 }),
    ];
    const right = translateNotesAsGroup(notes, 48, 0, 384);
    expect(right[0].startTick).toBe(0);
    expect(right[1].startTick).toBe(360);
    const up = translateNotesAsGroup(notes, 0, 80, 384);
    expect(up.map((item) => item.pitch)).toEqual([125, 127]);
    const left = translateNotesAsGroup(
      [note({ id: 'a', pitch: 10, startTick: 48, durationTicks: 24 })],
      -24,
      -4,
      384,
    );
    expect(left[0]).toMatchObject({ startTick: 24, pitch: 6 });
  });

  it('resizes from either edge with a minimum duration', () => {
    const notes = [note({ id: 'a', startTick: 48, durationTicks: 96 })];
    expect(resizeNotesAsGroup(notes, 'end', 24, 384, 24)[0].durationTicks).toBe(120);
    expect(resizeNotesAsGroup(notes, 'end', -200, 384, 24)[0].durationTicks).toBe(24);
    const fromStart = resizeNotesAsGroup(notes, 'start', 24, 384, 24)[0];
    expect(fromStart.startTick).toBe(72);
    expect(fromStart.durationTicks).toBe(72);
    expect(resizeNotesAsGroup(notes, 'start', -48, 384, 24)[0].startTick).toBe(0);
  });

  it('quantizes starts onto the chosen subdivision', () => {
    const notes = [note({ id: 'a', startTick: 10, durationTicks: 30 })];
    expect(quantizeNotes(notes, 24, 384)[0].startTick).toBe(0);
    expect(quantizeNotes([note({ id: 'b', startTick: 40, durationTicks: 24 })], 24, 384)[0].startTick).toBe(48);
    expect(snapTicksFor('1/16', FOUR_FOUR)).toBe(24);
    expect(snapTicksFor('1/8t', FOUR_FOUR)).toBe(32);
    expect(snapTicksFor('bar', FOUR_FOUR)).toBe(384);
    expect(snapTicksFor('bar', SIX_EIGHT)).toBe(288);
    expect(lengthTicksFor('1/4', FOUR_FOUR)).toBe(TICKS_PER_QUARTER_NOTE);
    expect(lengthTicksFor('bar', FOUR_FOUR)).toBe(384);
  });

  it('does not accumulate float error across many move-and-snap cycles', () => {
    let current = [note({ id: 'a', startTick: 0, durationTicks: 24 })];
    for (let index = 0; index < 12; index += 1) {
      current = translateNotesAsGroup(current, 16, 0, 384);
      current = quantizeNotes(current, 16, 384);
    }
    expect(Number.isInteger(current[0].startTick)).toBe(true);
    expect(current[0].startTick).toBe(12 * 16);
    expect(current[0].startTick % 16).toBe(0);
  });
});

describe('selection helpers, clipboard, and velocity', () => {
  it('duplicates with new ids offset by the snap grid', () => {
    let nextId = 0;
    const copies = duplicateNotes(
      [note({ id: 'a', startTick: 0, durationTicks: 24 })],
      24,
      384,
      () => `copy-${(nextId += 1)}`,
    );
    expect(copies).toHaveLength(1);
    expect(copies[0].id).toBe('copy-1');
    expect(copies[0].startTick).toBe(24);
  });

  it('pastes relative to the click pitch and tick', () => {
    let nextId = 0;
    const lane = [note({ id: 'keep', startTick: 0, pitch: 50 })];
    const clipboard = [note({ id: 'clip', startTick: 48, pitch: 64, durationTicks: 24 })];
    const pasted = pasteNotes(lane, clipboard, 0, 60, 384, () => `p-${(nextId += 1)}`);
    expect(pasted).toHaveLength(2);
    expect(pasted[1].id).toBe('p-1');
    expect(pasted[1].startTick).toBe(0);
    expect(pasted[1].pitch).toBe(60);
    expect(lane[0].id).toBe('keep');
  });

  it('replaces selected notes and upserts new ones', () => {
    const lane = [note({ id: 'a', pitch: 60 }), note({ id: 'b', pitch: 62 })];
    const next = replaceSelectedNotes(lane, new Set(['a']), [note({ id: 'a', pitch: 64, startTick: 48 })]);
    expect(next.find((item) => item.id === 'a')).toMatchObject({ pitch: 64, startTick: 48 });
    expect(next.find((item) => item.id === 'b')?.pitch).toBe(62);
    const added = applyLaneEdits(lane, [note({ id: 'c', pitch: 67 })], new Set(['a']));
    expect(added.map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('sets velocity from the lane pointer and clamps it', () => {
    expect(clampVelocity(1.4)).toBe(1);
    expect(clampVelocity(-1)).toBe(0);
    expect(velocityFromLaneY(0, 50)).toBe(1);
    expect(velocityFromLaneY(50, 50)).toBe(0);
    expect(velocityFromLaneY(25, 50)).toBe(0.5);
    expect(setNotesVelocity([note({ id: 'a', velocity: 0.2 })], 0.73)[0].velocity).toBe(0.73);
  });

  it('compares lanes and maps a ruler click onto the current loop cycle', () => {
    const a = [note({ id: 'a' })];
    expect(notesEqual(a, [note({ id: 'a' })])).toBe(true);
    expect(notesEqual(a, [note({ id: 'a', pitch: 61 })])).toBe(false);
    expect(patternTicks(16)).toBe(384);
    expect(playheadTickInPattern(20, 16)).toBe(4 * TICKS_PER_STEP);
    expect(seekStepFromPatternTick(48, 20, 16)).toBe(16 + 2);
  });

  it('creates notes with integer tick fields only', () => {
    const created = createNote({ id: 'z', pitch: 60.4, startTick: 10.2, durationTicks: 5.9, velocity: 2 });
    expect(created.pitch).toBe(60);
    expect(created.startTick).toBe(10);
    expect(created.durationTicks).toBe(5);
    expect(created.velocity).toBe(1);
  });
});
