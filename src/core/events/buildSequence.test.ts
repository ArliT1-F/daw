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

describe('sequencer playback rules', () => {
  it('applies per-step velocities from the pattern rows', () => {
    const project = createInitialProject();
    project.patterns[0].velocities['channel-kick'][0] = 0.3;
    project.patterns[0].velocities['channel-hat'][2] = 1;
    const events = build(project);

    const kicks = events.filter((event) => event.kind === 'sample' && event.channelId === 'channel-kick');
    expect(kicks[0].velocity).toBeCloseTo(0.3, 10);
    expect(kicks[1].velocity).toBeCloseTo(0.85, 10);
    const hats = events.filter((event) => event.kind === 'sample' && event.channelId === 'channel-hat');
    expect(hats.find((event) => event.step === 2)?.velocity).toBe(1);
  });

  it('falls back to the default step velocity when a row is missing at runtime', () => {
    const project = createInitialProject();
    delete project.patterns[0].velocities['channel-kick'];
    const events = buildPlaylistEvents(project, { timeSignature: FOUR_FOUR, defaultStepVelocity: 0.5 });
    const kicks = events.filter((event) => event.kind === 'sample' && event.channelId === 'channel-kick');
    expect(kicks.length).toBeGreaterThan(0);
    expect(kicks.every((event) => event.velocity === 0.5)).toBe(true);
  });

  it('delays offbeat steps by the swing amount while keeping the list ordered', () => {
    const straight = build(createInitialProject());
    expect(straight.every((event) => Number.isInteger(event.step))).toBe(true);

    const project = createInitialProject();
    project.settings.swing = 1; // full triplet feel: offbeats move by 4/6 = 0.6667 steps
    const swung = build(project);

    // Hat steps 2, 6, 10, 14 are the offbeat 8ths in 4/4; downbeats stay on the grid.
    const hatSteps = swung
      .filter((event) => event.kind === 'sample' && event.channelId === 'channel-hat')
      .map((event) => event.step);
    expect(hatSteps.filter((step) => !Number.isInteger(step)).slice(0, 4)).toEqual([2 + 4 / 6, 6 + 4 / 6, 10 + 4 / 6, 14 + 4 / 6]);
    expect(hatSteps.filter((step) => Number.isInteger(step)).slice(0, 4)).toEqual([0, 4, 8, 12]);
    const kickSteps = swung
      .filter((event) => event.kind === 'sample' && event.channelId === 'channel-kick')
      .map((event) => event.step);
    expect(kickSteps.slice(0, 2)).toEqual([0, 8]);

    // Ordered output is what the scheduler's binary search requires.
    const steps = swung.map((event) => event.step);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // Nothing escapes the four-bar clip even with swing applied.
    expect(swung.every((event) => event.step < 64)).toBe(true);

    // Half swing moves offbeats by half of the full amount.
    const projectHalf = createInitialProject();
    projectHalf.settings.swing = 0.5;
    const half = build(projectHalf);
    expect(half.find((event) => event.kind === 'sample' && event.channelId === 'channel-hat' && Math.abs(event.step - (2 + 2 / 6)) < 1e-9)).toBeTruthy();
  });

  it('excludes muted channels from playback', () => {
    const project = createInitialProject();
    project.channels.find((channel) => channel.id === 'channel-kick')!.muted = true;
    const events = build(project);

    expect(events.some((event) => event.channelId === 'channel-kick')).toBe(false);
    expect(events.some((event) => event.channelId === 'channel-snare')).toBe(true);
    expect(events.some((event) => event.kind === 'note' && event.channelId === 'channel-bass')).toBe(true);
  });

  it('solo keeps only soloed channels, and muting a soloed channel silences it', () => {
    const project = createInitialProject();
    project.channels.find((channel) => channel.id === 'channel-hat')!.solo = true;
    const soloed = build(project);
    const channels = new Set(soloed.map((event) => event.channelId));
    expect([...channels]).toEqual(['channel-hat']);

    project.channels.find((channel) => channel.id === 'channel-hat')!.muted = true;
    expect(build(project)).toEqual([]);
  });

  it('plays step rows of instrument channels only once a sample is loaded', () => {
    const project = createInitialProject();
    // The bass channel has active steps, but without a sample it plays piano-roll notes only.
    const before = build(project);
    expect(before.some((event) => event.kind === 'sample' && event.channelId === 'channel-bass')).toBe(false);

    project.channels.find((channel) => channel.id === 'channel-bass')!.sampleId = 'sample-bass-snap';
    const after = build(project);
    const bassSamples = after.filter((event) => event.kind === 'sample' && event.channelId === 'channel-bass');
    // The four-bar clip repeats the 16-step pattern four times.
    expect(bassSamples.map((event) => event.step)).toEqual([0, 8, 16, 24, 32, 40, 48, 56]);
    expect(bassSamples.every((event) => event.kind === 'sample' && event.sampleId === 'sample-bass-snap')).toBe(true);
    // Its piano-roll notes still play.
    expect(after.some((event) => event.kind === 'note' && event.channelId === 'channel-bass')).toBe(true);
  });

  it('tags events with their source pattern and serves 32-step patterns across the clip', () => {
    const project = createInitialProject();
    const source = project.patterns[0];
    source.lengthSteps = 32;
    for (const channel of project.channels) {
      source.steps[channel.id] = Array.from({ length: 32 }, (_, index) => source.steps[channel.id][index] ?? false);
      source.velocities[channel.id] = Array.from({ length: 32 }, (_, index) => source.velocities[channel.id][index] ?? 0.85);
      source.notes[channel.id] = source.notes[channel.id].map((note) => ({ ...note }));
    }
    source.steps['channel-kick'][20] = true;
    project.playlist = [{ id: 'clip-a', patternId: 'pattern-main', startBar: 0, lengthBars: 4 }];

    const events = build(project);
    expect(events.every((event) => event.patternId === 'pattern-main')).toBe(true);
    const kicks = events
      .filter((event) => event.kind === 'sample' && event.channelId === 'channel-kick')
      .map((event) => event.step);
    // Two passes of the 32-step pattern fill the four-bar clip: 0, 8, 20, 32, 40, 52.
    expect(kicks).toEqual([0, 8, 20, 32, 40, 52]);
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
