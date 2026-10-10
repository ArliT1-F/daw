import { describe, expect, it } from 'vitest';
import { ArrangementEventSource } from './arrangementEventSource';
import { createInitialProject } from '../project/model';
import { createTestArrangement } from '../arrangement/__fixtures__/testArrangement';
import { TICKS_PER_STEP as T } from '../time/ticks';
import { applyProjectCommand, createEmptyChannel } from '../commands';

function window(project = createTestArrangement(), startStep = 24, endStep = 25, includeSustains = true) {
  return new ArrangementEventSource(project).queryWindow({ startStep, endStep, includeSustains });
}

describe('arrangement event window queries', () => {
  it('keeps separate voice identities for overlapping instances of one shared pattern', () => {
    const events = window();
    const roots = events.filter((event) => event.kind === 'note' && event.pitch === 60);
    expect(roots.map((event) => event.clipId)).toEqual(['clip-a', 'clip-b']);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(roots.every((event) => event.patternId === 'pattern-main')).toBe(true);
  });
  it('returns pre-existing notes/audio only when sustain chasing is requested; never chases a one-shot', () => {
    const events = window(createTestArrangement(), 26, 27);
    expect(events.filter((event) => event.kind === 'note')).toHaveLength(3);
    expect(events.filter((event) => event.kind === 'audio')).toHaveLength(1);
    expect(events.some((event) => event.kind === 'sample')).toBe(false);
    expect(window(createTestArrangement(), 26, 27, false)).toEqual([]);
  });
  it('has half-open boundaries: ends at the window/clip boundary are not retriggered', () => {
    const project = createTestArrangement();
    const atEnd = window(project, 64, 65);
    expect(atEnd).toEqual([]);
    const before = window(project, 39, 40, false);
    expect(before.some((event) => event.step === 40)).toBe(false);
    expect(window(project, 40, 40.1, false).some((event) => event.clipId === 'clip-c' && event.step === 40)).toBe(true);
  });
  it('left-trimmed pattern instances enter held notes with only their remaining source duration', () => {
    const events = window(createTestArrangement(), 40, 41);
    const upper = events.find((event) => event.clipId === 'clip-c' && event.kind === 'note' && event.pitch === 76)!;
    expect(upper).toMatchObject({ step: 40, durationSteps: 4 }); // source ticks 8..12 of note 0..12
    const third = events.find((event) => event.clipId === 'clip-c' && event.kind === 'note' && event.pitch === 64)!;
    expect(third).toMatchObject({ step: 40, durationSteps: 8 });
  });
  it('uses absolute ticks: changing meter does not silently move arrangement clips', () => {
    const project = createTestArrangement();
    const before = window(project, 24, 25, false);
    project.settings.timeSignature = { numerator: 7, denominator: 8 };
    const after = window(project, 24, 25, false);
    expect(after.map((event) => [event.id, event.step])).toEqual(before.map((event) => [event.id, event.step]));
  });
  it('enforces track mute/solo in addition to Channel Rack mute/solo, including audio', () => {
    const project = createTestArrangement();
    project.tracks.find((track) => track.id === 'track-main')!.solo = true;
    expect(window(project).every((event) => event.trackId === 'track-main')).toBe(true);
    project.channels.find((channel) => channel.id === 'channel-pad')!.solo = true;
    expect(window(project).every((event) => event.channelId === 'channel-pad')).toBe(true);
    project.tracks.find((track) => track.id === 'track-main')!.muted = true;
    expect(window(project)).toEqual([]);
  });
  it('renaming/editing a source immediately updates all instances without copying it', () => {
    const original = createTestArrangement();
    const changed = applyProjectCommand(original, { type: 'pattern.note.update', patternId: 'pattern-main', channelId: 'channel-bass', noteId: 'held-root', changes: { pitch: 62 } });
    const events = window(changed);
    expect(events.filter((event) => event.kind === 'note' && event.channelId === 'channel-bass').every((event) => event.kind === 'note' && event.pitch === 62)).toBe(true);
    expect(changed.patterns).toHaveLength(original.patterns.length);
  });
  it('does not let swung onsets or note lengths escape short/fractional clip boundaries', () => {
    const project = createInitialProject();
    project.settings.swing = 1;
    project.playlist[0].durationTicks = 2.5 * T;
    project.patterns[0].notes['channel-bass'] = [{ id: 'edge', pitch: 60, startTick: 2 * T, durationTicks: 2 * T, velocity: 0.8 }];
    const events = window(project, 0, 10);
    expect(events.every((event) => event.step < 2.5)).toBe(true);
    expect(events.filter((event) => event.kind === 'note')).toHaveLength(0);
  });
  it('clamps a swung note using its actual delayed onset, not its unswung grid start', () => {
    const project = createInitialProject();
    project.settings.swing = 1;
    project.playlist[0].durationTicks = 3 * T;
    project.patterns[0].notes['channel-bass'] = [{ id: 'edge', pitch: 60, startTick: 2 * T, durationTicks: 2 * T, velocity: 0.8 }];
    const event = window(project, 0, 10).find((item) => item.kind === 'note')!;
    expect(event.step).toBeCloseTo(2 + 4 / 6, 12);
    expect(event.step + event.durationSteps).toBe(3);
  });
  it('indexes a long held clip even when many shorter clips precede the query', () => {
    const project = createInitialProject();
    project.playlist[0].durationTicks = 1_000_000 * T;
    for (let index = 1; index < 1000; index += 1) project.playlist.push({ ...project.playlist[0], id: `small${index}`, startTick: index * T, durationTicks: T });
    const events = window(project, 10000, 10001);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.clipId === 'clip-main-0')).toBe(true);
  });
  it('returns no data for invalid/empty windows', () => {
    const source = new ArrangementEventSource(createTestArrangement());
    expect(source.queryWindow({ startStep: 10, endStep: 10 })).toEqual([]);
    expect(source.queryWindow({ startStep: NaN, endStep: 10 })).toEqual([]);
  });
  it('uses unambiguous event identities even when legal channel/note IDs contain separators', () => {
    const project = applyProjectCommand(createTestArrangement(), { type: 'channel.add', channel: createEmptyChannel('channel-bass:note:held', 'Extra voice', '#7fa8d8') });
    project.patterns[0].notes['channel-bass'][0].id = 'held:note:id';
    project.patterns[0].notes['channel-bass:note:held'] = [{ id: 'id', pitch: 72, startTick: 0, durationTicks: 16 * T, velocity: 0.5 }];
    const notes = window(project).filter((event) => event.kind === 'note' && ['channel-bass', 'channel-bass:note:held'].includes(event.channelId));
    expect(notes).toHaveLength(4); // both channels in each of the two shared instances
    expect(new Set(notes.map((note) => note.id)).size).toBe(4);
  });

});
