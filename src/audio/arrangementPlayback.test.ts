import { describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from './AudioEngine';
import { FakeAudioBuffer, createFakeAudioContext } from './__fixtures__/fakeAudioContext';
import { ArrangementEventSource } from '../core/events';
import type { MusicalEventSource, ScheduledEventTiming } from '../core/events/musicalEvents';
import { getPlaybackRegion, getProjectTempoMap } from '../core/arrangement/arrangement';
import { createTestArrangement } from '../core/arrangement/__fixtures__/testArrangement';
import { applyProjectCommand } from '../core/commands';
import type { Project } from '../core/project/model';
import { secondsBetweenSteps } from '../core/time/musicalTime';
import { TICKS_PER_STEP as T } from '../core/time/ticks';
import type { RepeatingTimer } from './timer';

const timer: RepeatingTimer = { kind: 'interval', start() {}, stop() {}, dispose() {} };

function harness(project = createTestArrangement(), startDelay = 0) {
  const { context, fake } = createFakeAudioContext();
  const buffer = new FakeAudioBuffer(1, 8 * 48000, 48000);
  const engine = new BrowserAudioEngine({ createContext: () => context, timer, startDelaySeconds: startDelay, resolveSample: (id) => id === 'asset-texture' ? buffer as unknown as AudioBuffer : null });
  const records: ScheduledEventTiming[] = [];
  const original = engine.scheduleEvent.bind(engine);
  vi.spyOn(engine, 'scheduleEvent').mockImplementation((timing) => { records.push(timing); original(timing); });
  function configure(next: Project, source: MusicalEventSource = new ArrangementEventSource(next)) {
    engine.setArrangement(source, { tempoMap: getProjectTempoMap(next), timeSignature: next.settings.timeSignature, loop: getPlaybackRegion(next) });
  }
  configure(project);
  return {
    engine, fake, records, configure,
    advanceTo(time: number) {
      while (fake.currentTime + 0.02 < time - 1e-9) { fake.advanceTo(fake.currentTime + 0.02); engine.tick(); }
      fake.advanceTo(time); engine.tick();
    },
  };
}

describe('live arrangement scheduling', () => {
  it('starts a mid-song loop with every overlapping instance and instrument, chasing held notes and audio', async () => {
    const h = harness();
    await h.engine.play();
    const atEntry = h.records.filter((timing) => Math.abs(timing.time) < 1e-9);
    expect(atEntry.filter((timing) => timing.event.kind === 'note')).toHaveLength(3); // root + fifth from A, root from B
    expect(new Set(atEntry.map((timing) => timing.event.clipId))).toEqual(new Set(['clip-a', 'clip-b', 'clip-audio']));
    const root = atEntry.find((timing) => timing.event.clipId === 'clip-a' && timing.event.kind === 'note' && timing.event.pitch === 60)!;
    expect(root.durationSeconds).toBeCloseTo(1, 9); // step 24..32 at 120 BPM
    expect(h.fake.bufferSources.find((source) => source.buffer?.duration === 8)?.offsetSeconds).toBeCloseTo(1, 9); // 0.5 trim + 20..24
    expect(h.engine.getPositionSteps()).toBe(24);
    expect(h.records.some((timing) => timing.event.kind === 'sample' && timing.event.step < 24)).toBe(false);
  });

  it('schedules each clip/channel/repeat once per pass across many lookahead ticks and tempo-changing loops', async () => {
    const project = createTestArrangement();
    const h = harness(project);
    await h.engine.play();
    const duration = secondsBetweenSteps(getProjectTempoMap(project), project.settings.timeSignature, 24, 56);
    h.advanceTo(duration * 3 + 0.15);
    const keys = h.records.map((timing) => `${timing.event.id}@${timing.iteration}`);
    expect(new Set(keys).size).toBe(keys.length);
    const entries = h.records.filter((timing) => timing.event.kind === 'audio' && timing.event.clipId === 'clip-audio');
    expect(entries).toHaveLength(4);
    entries.forEach((timing, index) => { expect(timing.time).toBeCloseTo(index * duration, 9); expect(timing.sourceOffsetSeconds).toBeCloseTo(1, 9); });
    expect(h.engine.getDiagnostics().droppedCount).toBe(0);
    expect(h.records.every((timing) => timing.time + timing.durationSeconds <= (timing.stopTime ?? Infinity) + 1e-9)).toBe(true);
  });

  it('seeks while stopped and starts at the parked position, with no pre-start backward jump', async () => {
    const h = harness(createTestArrangement(), 0.06);
    h.engine.seek(28);
    await h.engine.play();
    expect(h.engine.getPositionSteps()).toBe(28);
    expect(h.engine.getPlayheadSteps()).toBe(28);
    const audio = h.records.find((timing) => timing.event.kind === 'audio')!;
    expect(audio.time).toBeCloseTo(0.06, 9);
    expect(audio.sourceOffsetSeconds).toBeCloseTo(1.5, 9);
    expect(h.records.filter((timing) => timing.event.kind === 'note').every((timing) => timing.time === 0.06)).toBe(true);
  });

  it('seeking while playing cuts old voices and chases only the remaining notes/source audio', async () => {
    const h = harness();
    await h.engine.play();
    h.advanceTo(0.2);
    const old = [...h.fake.sources];
    const count = h.records.length;
    h.engine.seek(44);
    expect(h.engine.getPositionSteps()).toBe(44);
    old.forEach((source) => expect(source.stopAt).toBeLessThanOrEqual(0.208 + 1e-9));
    const after = h.records.slice(count);
    expect(after.filter((timing) => timing.event.kind === 'note').length).toBeGreaterThan(0);
    const audio = after.find((timing) => timing.event.kind === 'audio')!;
    expect(audio.time).toBeCloseTo(0.2, 9);
    expect(audio.sourceOffsetSeconds).toBeCloseTo(0.5 + (12 * 0.125) + (12 * (60 / 90 / 4)), 9);
    h.advanceTo(0.4);
    expect(h.fake.getSoundingSources().every((source) => !old.includes(source))).toBe(true);
  });

  it('pause/resume chases sustains without restarting audio at the file beginning', async () => {
    const h = harness();
    await h.engine.play();
    h.advanceTo(0.5); // step 28
    h.engine.pause();
    h.fake.advanceTo(2);
    expect(h.fake.getSoundingSources()).toHaveLength(0);
    await h.engine.play();
    expect(h.engine.getPositionSteps()).toBeCloseTo(28, 9);
    const audio = h.records.filter((timing) => timing.event.kind === 'audio').at(-1)!;
    expect(audio.time).toBe(2);
    expect(audio.sourceOffsetSeconds).toBeCloseTo(1.5, 9);
  });

  it('integrates marker tempo changes inside notes, source offsets, and event onset times', async () => {
    const project = createTestArrangement();
    const h = harness(project);
    await h.engine.play();
    h.advanceTo(2.5);
    const downbeat = h.records.find((timing) => timing.event.clipId === 'clip-a' && timing.event.kind === 'note' && timing.event.step === 32 && timing.event.channelId === 'channel-bass')!;
    expect(downbeat.time).toBeCloseTo(1, 9);
    expect(downbeat.durationSeconds).toBeCloseTo(16 * 60 / 90 / 4, 9);
    const harmony = h.records.find((timing) => timing.event.clipId === 'clip-c' && timing.event.step === 40 && timing.event.kind === 'note')!;
    expect(harmony.time).toBeCloseTo(1 + 8 * 60 / 90 / 4, 9);
    expect(harmony.durationSeconds).toBeLessThanOrEqual(8 * 60 / 90 / 4 + 1e-9);
  });

  it('changing a tempo map during playback preserves the step and reschedules active notes exactly once', async () => {
    const project = createTestArrangement();
    const h = harness(project);
    await h.engine.play();
    h.advanceTo(0.4);
    const position = h.engine.getPositionSteps();
    const sources = [...h.fake.sources];
    const edited = applyProjectCommand(project, { type: 'project.tempo.set', tempo: 60 });
    h.configure(edited);
    expect(h.engine.getPositionSteps()).toBeCloseTo(position, 9);
    const newVoices = h.fake.sources.filter((source) => !sources.includes(source));
    expect(newVoices.length).toBeGreaterThan(0);
    h.advanceTo(0.5);
    expect(h.fake.getSoundingSources().every((source) => !sources.includes(source))).toBe(true);
    const nextKick = h.records.filter((timing) => timing.event.kind === 'sample' && timing.event.step === 32).at(-1);
    h.advanceTo(1.7);
    const actual = h.records.filter((timing) => timing.event.kind === 'sample' && timing.event.step === 32).at(-1)!;
    expect(nextKick).toBeUndefined();
    expect(actual.time).toBeCloseTo(0.4 + (32 - position) * 0.25, 9);
  });

  it('muting/deleting a playing clip immediately retires its active voices and leaves other lanes playing', async () => {
    const project = createTestArrangement();
    const h = harness(project);
    await h.engine.play();
    h.advanceTo(0.2);
    const count = h.records.length;
    const edited = applyProjectCommand(project, { type: 'playlist.track.mute.set', trackId: 'track-audio', muted: true });
    h.configure(edited);
    expect(h.records.slice(count).some((timing) => timing.event.kind === 'audio')).toBe(false);
    h.advanceTo(0.4);
    expect(h.fake.getSoundingSources().filter((source) => 'buffer' in source && source.buffer === h.fake.bufferSources[0]?.buffer)).toHaveLength(0);
    expect(h.fake.getSoundingSources().length).toBeGreaterThan(0);
  });

  it('stop cancels future lookahead voices before they can sound and parks at the mid-song loop start', async () => {
    const h = harness(createTestArrangement(), 0.06);
    await h.engine.play();
    expect(h.fake.sources.length).toBeGreaterThan(0);
    h.engine.stop();
    h.advanceTo(1);
    expect(h.fake.getSoundingSources()).toHaveLength(0);
    expect(h.fake.sources.every((source) => source.stopAt! < source.startedAt!)).toBe(true);
    expect(h.engine.getPositionSteps()).toBe(24);
  });

  it('cuts audio and synth release tails at clip boundaries, even in non-looping song mode', async () => {
    const project = createTestArrangement();
    project.settings.loop.enabled = false;
    project.playlist = project.playlist.filter((clip) => clip.id === 'clip-audio');
    project.playlist[0].durationTicks = 2 * T;
    const h = harness(project);
    h.engine.seek(20);
    await h.engine.play();
    const source = h.fake.bufferSources[0];
    expect(source.startedAt).toBe(0);
    expect(source.stopAt).toBeCloseTo(0.25, 9);
    h.advanceTo(0.3);
    expect(h.fake.getSoundingSources()).toHaveLength(0);
  });

  it('silent/missing audio assets never fall back to drum voices', async () => {
    const project = createTestArrangement();
    project.audioAssets[0].id = 'missing';
    const clip = project.playlist.find((item) => item.kind === 'audio')!;
    if (clip.kind === 'audio') clip.assetId = 'missing';
    project.playlist = [clip];
    const h = harness(project);
    await h.engine.play();
    expect(h.fake.sources).toHaveLength(0);
    expect(h.engine.lastError).toBeNull();
  });

  it('queries only a small current window in a million-bar arrangement, not a whole-song expansion', async () => {
    const project = createTestArrangement();
    project.settings.loop = { enabled: false, startTick: 0, endTick: 128 * T };
    project.playlist = [{ ...project.playlist[0], startTick: 0, durationTicks: 1_000_000 * 16 * T }];
    const source = new ArrangementEventSource(project);
    const query = vi.spyOn(source, 'queryWindow');
    const h = harness(project);
    h.configure(project, source);
    h.engine.seek(8_000_004);
    await h.engine.play();
    h.advanceTo(0.6);
    expect(query.mock.calls.length).toBeGreaterThan(1);
    expect(query.mock.calls.every(([window]) => window.endStep - window.startStep < 2)).toBe(true);
    expect(h.records.length).toBeLessThan(10);
    expect(h.engine.getPositionSteps()).toBeGreaterThan(8_000_004);
  });

  it('skips stale loops after a timer stall without bursting or duplicating events', async () => {
    const h = harness();
    await h.engine.play();
    h.fake.advanceTo(60);
    h.engine.tick();
    const records = h.records.filter((timing) => timing.time >= 60);
    expect(records.length).toBeLessThan(10);
    expect(records.every((timing) => timing.time < 60.12)).toBe(true);
    expect(new Set(h.records.map((timing) => `${timing.event.id}@${timing.iteration}`)).size).toBe(h.records.length);
  });

  it('latency-compensated Playlist playhead stays in the previous audible pass at a loop boundary', async () => {
    const project = createTestArrangement();
    const h = harness(project);
    await h.engine.play();
    const duration = secondsBetweenSteps(getProjectTempoMap(project), project.settings.timeSignature, 24, 56);
    h.fake.outputLatency = 0.05;
    h.advanceTo(duration + 0.02);
    expect(h.engine.getPositionSteps()).toBeGreaterThanOrEqual(24);
    expect(h.engine.getPositionSteps()).toBeLessThan(25);
    expect(h.engine.getPlayheadSteps()).toBeGreaterThan(55);
    expect(h.engine.getPlayheadSteps()).toBeLessThan(56);
  });

  it('editing during startup headroom cancels old pending voices but does not lose the first downbeat', async () => {
    const project = createTestArrangement();
    const h = harness(project, 0.06);
    await h.engine.play();
    const pending = [...h.fake.sources];
    const before = h.records.length;
    h.configure(applyProjectCommand(project, { type: 'playlist.track.rename', trackId: 'track-main', name: 'Edited in headroom' }));
    expect(pending.every((source) => source.stopAt! < source.startedAt!)).toBe(true);
    expect(h.records.slice(before).filter((timing) => timing.event.kind === 'sample')).toHaveLength(2);
    h.advanceTo(0.08);
    expect(h.fake.getSoundingSources().length).toBeGreaterThan(0);
    expect(h.fake.getSoundingSources().every((source) => !pending.includes(source))).toBe(true);
  });

  it('an edit on a played onset never retriggers it, but a newly inserted coincident clip still sounds', async () => {
    const project = createTestArrangement();
    const h = harness(project);
    await h.engine.play();
    const before = h.records.length;
    const added = applyProjectCommand(project, { type: 'playlist.clip.add', clip: { ...project.playlist[1], id: 'new-overlap' } });
    h.configure(added);
    const hits = h.records.slice(before).filter((timing) => timing.event.kind === 'sample');
    expect(hits).toHaveLength(1);
    expect(hits[0].event.clipId).toBe('new-overlap');
  });

  it('live tempo edits preserve an already-playing audio source phase, not a retroactive new offset', async () => {
    const project = createTestArrangement();
    const h = harness(project);
    await h.engine.play();
    h.advanceTo(0.4);
    h.configure(applyProjectCommand(project, { type: 'project.tempo.set', tempo: 60 }));
    const audio = h.records.filter((timing) => timing.event.kind === 'audio').at(-1)!;
    expect(audio.sourceOffsetSeconds).toBeCloseTo(1.4, 12); // initial offset 1 + 0.4 s of real playback
    expect(audio.time).toBe(0.4);
    h.advanceTo(0.6);
    h.configure(applyProjectCommand(project, { type: 'project.tempo.set', tempo: 80 }));
    expect(h.records.filter((timing) => timing.event.kind === 'audio').at(-1)!.sourceOffsetSeconds).toBeCloseTo(1.6, 12);
  });

  it('changing an audio trim/onset invalidates continuity and resolves the newly edited source position', async () => {
    const project = createTestArrangement();
    const h = harness(project);
    await h.engine.play();
    h.advanceTo(0.4);
    const audio = project.playlist.find((clip) => clip.kind === 'audio')!;
    if (audio.kind !== 'audio') throw new Error('Bad fixture');
    const edited = applyProjectCommand(project, { type: 'playlist.clips.edit', upserts: [{ ...audio, sourceOffsetSeconds: 2 }] });
    h.configure(edited);
    expect(h.records.filter((timing) => timing.event.kind === 'audio').at(-1)!.sourceOffsetSeconds).toBeCloseTo(2.9, 12);
  });

  it('one-tick loops at 300 BPM can cross many cycles per window without missed or duplicate entries', async () => {
    const project = createTestArrangement();
    project.settings.tempo = 300;
    project.settings.tempoChanges = [];
    project.settings.loop = { enabled: true, startTick: 24 * T + 1, endTick: 24 * T + 2 };
    const h = harness(project);
    await h.engine.play();
    h.advanceTo(0.22);
    const ids = h.records.map((timing) => `${timing.event.id}@${timing.iteration}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(h.records.length).toBeGreaterThan(400);
    expect(h.records.every((timing) => timing.durationSeconds <= 60 / 300 / 4 / T + 1e-9)).toBe(true);
    expect(h.engine.getDiagnostics().droppedCount).toBe(0);
  });

  it('onsets exactly at the lookahead horizon are deferred to the next window, then scheduled once', async () => {
    const project = createTestArrangement();
    project.settings.tempoChanges = [];
    project.settings.loop = { enabled: true, startTick: 0, endTick: 8 * T };
    project.playlist = [{ ...project.playlist[0], startTick: 0, durationTicks: 8 * T }];
    project.patterns[0].steps['channel-kick'][1] = true;
    const h = harness(project);
    await h.engine.play();
    h.advanceTo(0.005); // horizon = 0.125 s, the exact time of step 1
    expect(h.records.some((timing) => timing.event.step === 1)).toBe(false);
    h.advanceTo(0.01);
    const hits = h.records.filter((timing) => timing.event.step === 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].time).toBeCloseTo(0.125, 12);
  });


  it('an onset that previously had zero velocity is not incorrectly suppressed as already sounded', async () => {
    const project = createTestArrangement();
    project.patterns[0].velocities['channel-kick'][0] = 0;
    const h = harness(project);
    await h.engine.play();
    expect(h.fake.oscillators).toHaveLength(10); // three note voices + only the nonzero-velocity kick
    const before = h.records.length;
    h.configure(applyProjectCommand(project, { type: 'pattern.step.set', patternId: 'pattern-main', channelId: 'channel-kick', step: 0, active: true, velocity: 1 }));
    const hits = h.records.slice(before).filter((timing) => timing.event.kind === 'sample');
    expect(hits).toHaveLength(1);
    expect(hits[0].event.clipId).toBe('clip-b');
  });

  it('seeking to the exclusive enabled-loop end enters the start immediately, including held audio', async () => {
    const h = harness();
    await h.engine.play();
    const before = h.records.length;
    h.engine.seek(56);
    expect(h.engine.getPositionSteps()).toBe(24);
    const audio = h.records.slice(before).find((timing) => timing.event.kind === 'audio')!;
    expect(audio.time).toBe(0);
    expect(audio.sourceOffsetSeconds).toBe(1);
  });

  it('loop edits which wrap/clamp the current position chase the new source phase instead of preserving the old one', async () => {
    const project = createTestArrangement();
    const h = harness(project);
    await h.engine.play();
    h.advanceTo(0.5); // old position step 28, source offset 1.5
    const edited = applyProjectCommand(project, { type: 'playlist.loop.set', changes: { startTick: 20 * T, endTick: 28 * T } });
    const before = h.records.length;
    h.configure(edited);
    expect(h.engine.getPositionSteps()).toBe(20);
    const next = h.records.slice(before).find((timing) => timing.event.kind === 'audio')!;
    expect(next.time).toBe(0.5);
    expect(next.sourceOffsetSeconds).toBe(0.5); // wrapped to the step-20 trim, not continuous offset 1.5
  });

  it('song mode stops at the last clip end even when unused saved loop markers extend beyond it', async () => {
    const project = createTestArrangement();
    project.settings.loop = { enabled: false, startTick: 200 * T, endTick: 300 * T };
    const h = harness(project);
    expect(h.engine.transport.loop).toEqual({ enabled: false, startStep: 0, endStep: 64 });
    await h.engine.play();
    h.engine.seek(63.9);
    h.advanceTo(0.1);
    expect(h.engine.isPlaying).toBe(false);
    expect(h.engine.getPositionSteps()).toBe(0);
    h.fake.advanceTo(0.12);
    expect(h.fake.getSoundingSources()).toHaveLength(0);
  });

  it('retiming an already-played one-shot to the current boundary is not suppressed under its old onset key', async () => {
    const project = createTestArrangement();
    const h = harness(project);
    await h.engine.play();
    h.advanceTo(0.125); // step 25
    const before = h.records.length;
    const edited = applyProjectCommand(project, { type: 'playlist.clips.edit', upserts: [{ ...project.playlist[1], startTick: 25 * T }] });
    h.configure(edited);
    const hits = h.records.slice(before).filter((timing) => timing.event.kind === 'sample');
    expect(hits).toHaveLength(1);
    expect(hits[0].event.clipId).toBe('clip-b');
    expect(hits[0].time).toBe(0.125);
  });

});
