import { describe, expect, it } from 'vitest';
import { createInitialProject, type Note, type Project } from '../project/model';
import { buildPlaylistEvents, getSequenceEndStep } from './buildSequence';
import { firstEventIndexAtOrAfter, sortMusicalEvents, type MusicalEvent } from './musicalEvents';

const FOUR_FOUR = { numerator: 4, denominator: 4 };
const SIX_EIGHT = { numerator: 6, denominator: 8 };

function build(project: Project, overrides = {}) {
  return buildPlaylistEvents(project, { timeSignature: FOUR_FOUR, ...overrides });
}

describe('playlist event building', () => {
  it('turns the starter project into ordered drum triggers and synth notes', () => {
    const project = createInitialProject();
    const events = build(project);

    const kick = events.filter((event) => event.kind === 'sample' && event.channelId === 'channel-kick');
    const snare = events.filter((event) => event.kind === 'sample' && event.channelId === 'channel-snare');
    const hat = events.filter((event) => event.kind === 'sample' && event.channelId === 'channel-hat');
    const notes = events.filter((event) => event.kind === 'note');

    // The 4-bar clip repeats the 16-step pattern four times: 2 kicks x 4, 2 snares x 4, 8 hats x 4.
    expect(kick.map((event) => event.step)).toEqual([0, 8, 16, 24, 32, 40, 48, 56]);
    expect(snare.map((event) => event.step)).toEqual([4, 12, 20, 28, 36, 44, 52, 60]);
    expect(hat).toHaveLength(32);
    expect(notes).toHaveLength(16);
    expect(notes[0]).toMatchObject({ channelId: 'channel-bass', pitch: 60, step: 0, durationSteps: 4 });
  });

  it('sorts events by step and keeps ids unique', () => {
    const events = build(createInitialProject());
    const steps = events.map((event) => event.step);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });

  it('drops events outside the loop region', () => {
    const events = build(createInitialProject(), { endStep: 20 });
    expect(events.every((event) => event.step < 20)).toBe(true);
    expect(events.some((event) => event.step === 16)).toBe(true);
    expect(events.some((event) => event.step === 24)).toBe(false);
  });

  it('places clips at their start bar and honours clip length', () => {
    const project = createInitialProject();
    project.playlist = [
      { id: 'clip-a', patternId: 'pattern-main', startBar: 2, lengthBars: 1 },
      { id: 'clip-b', patternId: 'pattern-main', startBar: 5, lengthBars: 2 },
    ];
    const events = build(project);
    const kickSteps = events
      .filter((event) => event.kind === 'sample' && event.channelId === 'channel-kick')
      .map((event) => event.step);
    // Bar 2 starts at step 32 (one-bar clip = one pass), bars 5-6 start at step 80 (two passes).
    expect(kickSteps).toEqual([32, 40, 80, 88, 96, 104]);
  });

  it('repeats a pattern shorter than its clip and stops at the clip end', () => {
    const project = createInitialProject();
    project.patterns[0].lengthSteps = 4;
    project.patterns[0].steps['channel-kick'] = [true, false, false, false];
    const emptyNotes: Record<string, Note[]> = {};
    for (const channel of project.channels) emptyNotes[channel.id] = [];
    project.patterns[0].notes = emptyNotes;
    project.playlist = [{ id: 'clip-a', patternId: 'pattern-main', startBar: 0, lengthBars: 1 }];
    const events = build(project);
    const kicks = events
      .filter((event) => event.kind === 'sample' && event.channelId === 'channel-kick')
      .map((event) => event.step);
    expect(kicks).toEqual([0, 4, 8, 12]);
    // Nothing may escape the clip: a 1-bar clip in 4/4 ends at step 16.
    expect(events.every((event) => event.step < 16)).toBe(true);
  });

  it('ignores clips that reference a missing pattern', () => {
    const project = createInitialProject();
    project.playlist = [{ id: 'clip-a', patternId: 'does-not-exist', startBar: 0, lengthBars: 2 }];
    expect(build(project)).toEqual([]);
  });

  it('follows the time signature when converting bars to steps', () => {
    const project = createInitialProject();
    project.playlist = [{ id: 'clip-a', patternId: 'pattern-main', startBar: 1, lengthBars: 1 }];
    const events = buildPlaylistEvents(project, { timeSignature: SIX_EIGHT });
    // 6/8 has 12 steps per bar, but the pattern is still 16 steps long, so only one pass fits.
    expect(events[0].step).toBe(12);
    expect(events.every((event) => event.step < 24)).toBe(true);
  });

  it('reports the end of the sequence including note lengths', () => {
    const events = build(createInitialProject());
    expect(getSequenceEndStep(events)).toBe(64);
    expect(getSequenceEndStep([])).toBe(0);
  });

  it('clamps velocity into 0..1', () => {
    const project = createInitialProject();
    project.patterns[0].notes['channel-bass'][0].velocity = 5;
    const events = build(project);
    expect(events.every((event) => event.velocity >= 0 && event.velocity <= 1)).toBe(true);
  });
});

describe('event list helpers', () => {
  const events: MusicalEvent[] = [
    { kind: 'sample', id: 'b', step: 2, channelId: 'c', sampleId: 'c', velocity: 1 },
    { kind: 'note', id: 'a', step: 0, channelId: 'c', pitch: 60, velocity: 1, durationSteps: 1 },
    { kind: 'sample', id: 'a', step: 0, channelId: 'c', sampleId: 'c', velocity: 1 },
  ];

  it('sorts by step, then kind, then id', () => {
    expect(sortMusicalEvents(events).map((event) => `${event.kind}:${event.id}`)).toEqual([
      'sample:a',
      'note:a',
      'sample:b',
    ]);
  });

  it('finds the first event at or after a position', () => {
    const sorted = sortMusicalEvents(events);
    expect(firstEventIndexAtOrAfter(sorted, 0)).toBe(0);
    expect(firstEventIndexAtOrAfter(sorted, 1)).toBe(2);
    expect(firstEventIndexAtOrAfter(sorted, 99)).toBe(3);
    expect(firstEventIndexAtOrAfter([], 0)).toBe(0);
  });
});
