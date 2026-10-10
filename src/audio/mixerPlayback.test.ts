import { describe, expect, it } from 'vitest';
import { BrowserAudioEngine } from './AudioEngine';
import { createFakeAudioContext, FakeAudioBuffer, type FakeAudioContext, type FakeAudioNode } from './__fixtures__/fakeAudioContext';
import { applyProjectCommand, type ProjectCommand } from '../core/commands';
import { buildMixerState } from '../core/mixer/mixerModel';
import { createInitialProject, type Project } from '../core/project/model';
import type { MusicalEvent } from '../core/events/musicalEvents';
import type { RepeatingTimer } from './timer';

/**
 * End-to-end mixer behaviour through the real engine: routing reaches the output, mixer edits apply
 * to the live graph without restarting the scheduler or cutting sounding voices, and the graph is
 * cleaned up with the engine.
 */

const FOUR_FOUR = { numerator: 4, denominator: 4 };
const TICK_STEP = 0.02;

const manualTimer: RepeatingTimer = { kind: 'interval', start: () => {}, stop: () => {}, dispose: () => {} };

interface Harness {
  engine: BrowserAudioEngine;
  fake: FakeAudioContext;
  advanceTo(time: number): void;
}

function createHarness(resolveSample?: (sampleId: string) => AudioBuffer | null): Harness {
  const { context, fake } = createFakeAudioContext({ startRunning: true });
  const engine = new BrowserAudioEngine({
    createContext: () => context,
    tempoBpm: 120,
    timeSignature: FOUR_FOUR,
    loop: { startStep: 0, endStep: 32 },
    lookaheadSeconds: 0.12,
    timer: manualTimer,
    resolveSample,
  });
  return {
    engine,
    fake,
    advanceTo(time: number) {
      while (fake.currentTime + TICK_STEP <= time + 1e-9) {
        fake.advanceTo(fake.currentTime + TICK_STEP);
        engine.tick();
      }
      if (fake.currentTime < time) {
        fake.advanceTo(time);
        engine.tick();
      }
    },
  };
}

function kickAt(step: number): MusicalEvent {
  return { kind: 'sample', id: `kick-${step}`, step, channelId: 'channel-kick', sampleId: 'channel-kick', velocity: 0.9 };
}

function edit(project: Project, command: ProjectCommand): Project {
  return applyProjectCommand(project, command);
}

/**
 * The node the first scheduled voice feeds. Following it to the destination proves the whole
 * strip → bus → master path is connected; the master bus's own fader is automated at startup, so
 * the envelope is located from the source's outgoing connection rather than from automation calls.
 */
function voiceOutput(fake: FakeAudioContext): FakeAudioNode {
  const source = fake.oscillators[0] ?? fake.bufferSources[0];
  expect(source).toBeDefined();
  expect(source!.connections).toHaveLength(1);
  return source!.connections[0];
}

describe('mixer playback integration', () => {
  it('routes a scheduled voice through its channel strip, its mixer bus, and out the master bus', async () => {
    const harness = createHarness();
    harness.engine.setSequence([kickAt(0)]);
    harness.engine.setMixerState(buildMixerState(createInitialProject()));
    await harness.engine.play();
    harness.advanceTo(0.1);

    expect(harness.fake.oscillators).toHaveLength(1);
    const envelope = voiceOutput(harness.fake);
    // The voice is audible end-to-end: strip → insert bus → master bus → limiter → destination.
    expect(envelope.reaches(harness.fake.destination)).toBe(true);
    // Exactly one send target per source: no duplicated path into the master bus.
    expect(envelope.connectionCount).toBe(1);
  });

  it('applies mixer state requested before a context exists once the engine starts', async () => {
    const harness = createHarness();
    // Ordered before any gesture: the graph does not exist yet.
    harness.engine.setMixerState(buildMixerState(createInitialProject()));
    expect(harness.engine.getMixerStats()).toBeNull();

    harness.engine.setSequence([kickAt(0)]);
    await harness.engine.play();
    harness.advanceTo(0.1);

    expect(harness.engine.getMixerStats()).not.toBeNull();
    expect(harness.engine.getMixerStats()!.stripsCreated).toBeGreaterThan(0);
    expect(voiceOutput(harness.fake).reaches(harness.fake.destination)).toBe(true);
  });

  it('moves a fader live without recreating or re-stopping the sounding voice', async () => {
    const harness = createHarness();
    const project = createInitialProject();
    harness.engine.setSequence([kickAt(0)]);
    harness.engine.setMixerState(buildMixerState(project));
    await harness.engine.play();
    harness.advanceTo(0.1);

    const stopTimesBefore = harness.fake.oscillators.map((osc) => osc.stopAt);
    const voiceCount = harness.fake.oscillators.length;
    const statsBefore = harness.engine.getMixerStats();

    harness.engine.setMixerState(buildMixerState(edit(project, { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -24 })));
    harness.advanceTo(0.2);

    expect(harness.fake.oscillators).toHaveLength(voiceCount);
    expect(harness.fake.oscillators.map((osc) => osc.stopAt)).toEqual(stopTimesBefore);
    // The edit landed as exactly one smoothed parameter change, not a graph rebuild.
    expect(harness.engine.getMixerStats()!.paramUpdates - statsBefore!.paramUpdates).toBe(1);
    expect(harness.engine.getMixerStats()!.busesCreated).toBe(statsBefore!.busesCreated);
  });

  it('mutes an insert with a gain ramp and leaves the voice playing and the master untouched', async () => {
    const harness = createHarness();
    const project = createInitialProject();
    harness.engine.setSequence([kickAt(0)]);
    harness.engine.setMixerState(buildMixerState(project));
    await harness.engine.play();
    harness.advanceTo(0.1);

    const voiceCount = harness.fake.oscillators.length;
    harness.engine.setMixerState(buildMixerState(edit(project, { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-1', muted: true })));
    harness.advanceTo(0.2);

    // The mute is a gain automation to zero, not a disconnect or a voice release.
    const mutedGains = harness.fake.gains.filter((gain) => gain.gain.calls.some((call) => call.method === 'setTargetAtTime' && call.value === 0));
    expect(mutedGains.length).toBe(1);
    expect(harness.fake.oscillators).toHaveLength(voiceCount);
    // The muted bus is still wired to the master: muting gates, it does not bypass.
    expect(voiceOutput(harness.fake).reaches(harness.fake.destination)).toBe(true);
  });

  it('solo gates the unsoloed inserts but never gates the master bus', async () => {
    const harness = createHarness();
    const project = createInitialProject();
    harness.engine.setSequence([kickAt(0)]);
    harness.engine.setMixerState(buildMixerState(project));
    await harness.engine.play();
    harness.advanceTo(0.1);

    harness.engine.setMixerState(buildMixerState(edit(project, { type: 'mixer.channel.solo.set', channelId: 'mixer-insert-2', solo: true })));
    harness.advanceTo(0.2);

    // insert-1 (kick) is soloed-out and gated to zero.
    const gated = harness.fake.gains.filter((gain) => gain.gain.calls.some((call) => call.method === 'setTargetAtTime' && call.value === 0));
    expect(gated.length).toBeGreaterThanOrEqual(1);
    // The voice still exists; solo is a gain gate, not a stop.
    expect(harness.fake.oscillators).toHaveLength(1);
  });

  it('keeps a voice audible when its channel is rerouted mid-playback', async () => {
    const harness = createHarness();
    const project = createInitialProject();
    harness.engine.setSequence([kickAt(0)]);
    harness.engine.setMixerState(buildMixerState(project));
    await harness.engine.play();
    harness.advanceTo(0.1);

    const voiceCount = harness.fake.oscillators.length;
    harness.engine.setMixerState(buildMixerState(edit(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' })));
    harness.advanceTo(0.2);

    expect(harness.fake.oscillators).toHaveLength(voiceCount);
    expect(voiceOutput(harness.fake).reaches(harness.fake.destination)).toBe(true);
    expect(harness.engine.getMixerRoutingWarnings()).toHaveLength(0);
  });

  it('routes a Playlist audio track through its own source strip by track id', async () => {
    const buffer = new FakeAudioBuffer(1, 4800, 48000) as unknown as AudioBuffer;
    const harness = createHarness((sampleId) => (sampleId === 'asset-1' ? buffer : null));
    const project = edit(createInitialProject(), { type: 'mixer.source.assign', sourceId: 'audio:track-main', mixerChannelId: 'mixer-insert-3' });
    const audioEvent: MusicalEvent = {
      kind: 'audio',
      id: 'audio-clip',
      step: 0,
      channelId: 'audio:track-main',
      trackId: 'track-main',
      assetId: 'asset-1',
      sourceOffsetSeconds: 0,
      sourceDurationSeconds: 1,
      durationSteps: 8,
      velocity: 0.8,
    };
    harness.engine.setSequence([audioEvent]);
    harness.engine.setMixerState(buildMixerState(project));
    await harness.engine.play();
    harness.advanceTo(0.1);

    // The audio clip's buffer source is audible through the reassigned strip.
    expect(harness.fake.bufferSources).toHaveLength(1);
    expect(voiceOutput(harness.fake).reaches(harness.fake.destination)).toBe(true);
  });

  it('releases every voice and closes the graph cleanly on stop and dispose', async () => {
    const harness = createHarness();
    harness.engine.setSequence([kickAt(0), kickAt(4)]);
    harness.engine.setMixerState(buildMixerState(createInitialProject()));
    await harness.engine.play();
    harness.advanceTo(0.1);
    expect(harness.fake.getSoundingSources().length).toBeGreaterThan(0);

    harness.engine.stop();
    // Sounding voices are faded out rather than left to ring or hard-cut.
    harness.advanceTo(0.2);
    expect(harness.fake.getSoundingSources()).toHaveLength(0);

    await harness.engine.dispose();
    expect(harness.fake.closeCount).toBe(1);
    expect(harness.engine.getMixerStats()).toBeNull();
    expect(harness.engine.getMeterChannelIds()).toHaveLength(0);
  });

  it('exposes meter readings keyed by mixer channel id while the engine is running', async () => {
    const harness = createHarness();
    harness.engine.setMixerState(buildMixerState(createInitialProject()));
    await harness.engine.play();

    const ids = harness.engine.getMeterChannelIds();
    expect(ids).toContain('mixer-master');
    expect(ids).toContain('mixer-insert-1');
    expect(harness.engine.getMeterReading('mixer-master')).not.toBeNull();
    expect(harness.engine.getMeterReading('ghost')).toBeNull();
    harness.engine.clearMeterClip('mixer-master');
    expect(harness.engine.getMeterReading('mixer-master')?.clipLatched).toBe(false);
  });
});
