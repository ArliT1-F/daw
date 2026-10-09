import { describe, expect, it, vi } from 'vitest';
import { AudioEngineError, BrowserAudioEngine } from './AudioEngine';
import { FakeAudioBuffer, createFakeAudioContext, type FakeAudioContext } from './__fixtures__/fakeAudioContext';
import { buildPlaylistEvents } from '../core/events';
import { createInitialProject } from '../core/project/model';
import type { RepeatingTimer } from './timer';
import type { MusicalEvent } from '../core/events/musicalEvents';

const FOUR_FOUR = { numerator: 4, denominator: 4 };

/** Two bars at 120 BPM in 4/4: 32 steps, 0.125 s per step, 4 s per loop. */
const LOOP_END_STEP = 32;

function stepEvents(steps: number[], channelId = 'channel-kick'): MusicalEvent[] {
  return steps.map((step) => ({
    kind: 'sample' as const,
    id: `${channelId}-${step}`,
    step,
    channelId,
    sampleId: 'channel-kick',
    velocity: 0.9,
  }));
}

function noteEvent(step: number, durationSteps: number, pitch = 60): MusicalEvent {
  return {
    kind: 'note',
    id: `note-${step}`,
    step,
    channelId: 'channel-bass',
    pitch,
    velocity: 0.8,
    durationSteps,
  };
}

interface Harness {
  engine: BrowserAudioEngine;
  fake: FakeAudioContext;
  /** Walk the clock forward in 20 ms steps, ticking the scheduler like the real timer would. */
  advanceTo(time: number): void;
}

/** Scheduler timer that only ticks when a test asks it to. */
const manualTimer: RepeatingTimer = {
  kind: 'interval',
  start: () => {},
  stop: () => {},
  dispose: () => {},
};

const TICK_STEP = 0.02;

function createEngine(
  options: {
    startRunning?: boolean;
    events?: MusicalEvent[];
    resolveSample?: (sampleId: string) => AudioBuffer | null;
  } = {},
): Harness {
  const { context, fake } = createFakeAudioContext({ startRunning: options.startRunning ?? false });
  const engine = new BrowserAudioEngine({
    createContext: () => context,
    tempoBpm: 120,
    timeSignature: FOUR_FOUR,
    loop: { startStep: 0, endStep: LOOP_END_STEP },
    lookaheadSeconds: 0.12,
    timer: manualTimer,
    resolveSample: options.resolveSample,
  });
  if (options.events) engine.setSequence(options.events);
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

describe('audio engine lifecycle', () => {
  it('stays idle until a user gesture, then reports ready', async () => {
    const harness = createEngine();
    expect(harness.engine.status).toBe('idle');
    expect(harness.engine.getPositionSteps()).toBe(0);

    await expect(harness.engine.initialize()).resolves.toBe('ready');
    expect(harness.engine.status).toBe('ready');
    expect(harness.fake.resumeCount).toBe(1);
    expect(harness.fake.compressors).toHaveLength(1); // the safety limiter exists
  });

  it('reports unsupported when the Web Audio API is missing', async () => {
    const engine = new BrowserAudioEngine();
    await expect(engine.initialize()).resolves.toBe('unsupported');
    expect(engine.status).toBe('unsupported');
    await expect(engine.play()).rejects.toBeInstanceOf(AudioEngineError);
  });

  it('surfaces an autoplay block as a user-facing error', async () => {
    const { context, fake } = createFakeAudioContext();
    fake.failNextResume = true;
    const engine = new BrowserAudioEngine({ createContext: () => context });

    await expect(engine.initialize()).rejects.toBeInstanceOf(AudioEngineError);
    expect(engine.status).toBe('error');
    expect(engine.lastError?.reason).toBe('autoplay-blocked');
    expect(engine.lastError?.message).toMatch(/browser blocked audio playback/i);
  });

  it('reports audio-device failures with an actionable message', async () => {
    const failure = new Error('The requested audio device is not available.');
    failure.name = 'NotSupportedError';
    const engine = new BrowserAudioEngine({
      createContext: () => {
        throw failure;
      },
    });

    await expect(engine.initialize()).rejects.toBeInstanceOf(AudioEngineError);
    expect(engine.lastError?.reason).toBe('device-unavailable');
    expect(engine.lastError?.message).toMatch(/audio output device is unavailable/i);
  });

  it('surfaces voice-creation failures as a scheduling error and stops scheduling', async () => {
    const { context, fake } = createFakeAudioContext();
    const engine = new BrowserAudioEngine({
      createContext: () => context,
      timer: manualTimer,
      loop: { startStep: 0, endStep: LOOP_END_STEP },
    });
    engine.setSequence(stepEvents([0]));
    // A voice that cannot be built must fail the engine, not the whole app.
    fake.createOscillator = () => {
      throw new Error('Node allocation failed.');
    };

    await engine.play();
    expect(engine.lastError?.reason).toBe('scheduling-failed');
    expect(engine.lastError?.message).toMatch(/sound could not be created/i);
    expect(engine.status).toBe('error');
  });

  it('suspends, resumes, and disposes the context', async () => {
    const harness = createEngine({ startRunning: true });
    await harness.engine.initialize();

    await harness.engine.suspend();
    expect(harness.fake.state).toBe('suspended');
    expect(harness.engine.status).toBe('suspended');

    await harness.engine.resume();
    expect(harness.fake.state).toBe('running');
    expect(harness.engine.status).toBe('ready');

    await harness.engine.dispose();
    expect(harness.fake.closeCount).toBe(1);
    expect(harness.engine.status).toBe('idle');
    // Disposal is idempotent.
    await harness.engine.dispose();
    expect(harness.fake.closeCount).toBe(1);
  });

  it('reacts to the context being closed underneath it', async () => {
    const harness = createEngine({ events: stepEvents([0, 4]) });
    await harness.engine.play();
    harness.fake.setState('closed');
    expect(harness.engine.status).toBe('closed');
    expect(harness.engine.transport.status).toBe('stopped');
    expect(harness.fake.getSoundingSources()).toHaveLength(0);
  });

  it('reports an interrupted audio session (iOS/Safari) and stops the transport', async () => {
    const harness = createEngine({ events: stepEvents([0, 4]) });
    await harness.engine.play();
    harness.fake.setState('interrupted');
    expect(harness.engine.lastError?.reason).toBe('device-unavailable');
    expect(harness.engine.transport.status).toBe('paused');
  });

  it('notifies subscribers about status changes', async () => {
    const harness = createEngine();
    const listener = vi.fn();
    const unsubscribe = harness.engine.subscribe(listener);
    await harness.engine.initialize();
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'ready', transportStatus: 'stopped' });
    unsubscribe();
    await harness.engine.suspend();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('audio engine playback', () => {
  it('plays scheduled events at the audio-clock times they were queued for', async () => {
    const harness = createEngine({ events: stepEvents([0, 4, 8, 12]) });
    await harness.engine.play();

    // play() anchors at currentTime + 0.06 s of scheduling headroom.
    harness.advanceTo(0.1);
    expect(harness.fake.oscillators.map((node) => node.startedAt)).toEqual([0.06]);

    harness.advanceTo(0.6);
    // Step 4 sits at 0.06 + 4 * 0.125 = 0.56 s.
    expect(harness.fake.oscillators.map((node) => node.startedAt)).toEqual([0.06, 0.56]);
    expect(harness.engine.getDiagnostics().scheduledCount).toBe(2);
  });

  it('renders sustained notes on a dedicated synth voice', async () => {
    const harness = createEngine({ events: [noteEvent(0, 8)] });
    await harness.engine.play();
    harness.advanceTo(0.1);
    // Two detuned saws plus a sub oscillator.
    expect(harness.fake.oscillators).toHaveLength(3);
    expect(harness.fake.filters).toHaveLength(1);
    const noteEnd = harness.fake.oscillators[0].stopAt ?? 0;
    // 8 steps at 0.125 s plus a 60 ms release.
    expect(noteEnd).toBeCloseTo(0.06 + 1 + 0.06 + 0.02, 6);
  });

  it('keeps events synchronized across repeated loops', async () => {
    const harness = createEngine({ events: stepEvents([0, 8]) });
    await harness.engine.play();

    harness.advanceTo(9.2);

    const starts = harness.fake.oscillators.map((node) => node.startedAt ?? 0);
    // A 32-step loop at 120 BPM lasts 4 s: two events per loop over three loops.
    expect(starts).toHaveLength(6);
    const loopOne = starts.slice(0, 2);
    const loopTwo = starts.slice(2, 4);
    for (let index = 0; index < loopOne.length; index += 1) {
      expect(loopTwo[index] - loopOne[index]).toBeCloseTo(4, 6);
    }
  });

  it('stops without leaving hanging notes or duplicate voices', async () => {
    const harness = createEngine({ events: [...stepEvents([0, 4]), noteEvent(0, 16)] });
    await harness.engine.play();
    harness.advanceTo(0.2);
    expect(harness.fake.getSoundingSources(0.2).length).toBeGreaterThan(0);

    harness.engine.stop();
    expect(harness.engine.transport.status).toBe('stopped');
    expect(harness.engine.getPositionSteps()).toBe(0);

    // Every voice is released with a short fade, so nothing sounds past the release time.
    harness.fake.advanceTo(0.25);
    expect(harness.fake.getSoundingSources(0.25)).toHaveLength(0);

    // Restarting does not replay the events that were already cancelled.
    const countAfterStop = harness.fake.oscillators.length;
    harness.advanceTo(0.3);
    expect(harness.fake.oscillators).toHaveLength(countAfterStop);
  });

  it('pauses at the current position and resumes from it', async () => {
    const harness = createEngine({ events: stepEvents([0, 8, 16]) });
    await harness.engine.play();
    harness.advanceTo(1.06); // 8 steps after the 0.06 s anchor
    expect(harness.engine.getPositionSteps()).toBeCloseTo(8, 6);

    harness.engine.pause();
    expect(harness.engine.transport.status).toBe('paused');
    expect(harness.engine.getPositionSteps()).toBeCloseTo(8, 6);
    harness.fake.advanceTo(1.2);
    expect(harness.fake.getSoundingSources(1.2)).toHaveLength(0);

    harness.fake.advanceTo(2);
    expect(harness.engine.getPositionSteps()).toBeCloseTo(8, 6);

    await harness.engine.play();
    expect(harness.engine.transport.status).toBe('playing');
    expect(harness.engine.getPositionSteps()).toBeCloseTo(8, 6);
    harness.advanceTo(2.06);
    expect(harness.engine.getPositionSteps()).toBeCloseTo(8.48, 6);
  });

  it('restarts from the region start', async () => {
    const harness = createEngine({ events: stepEvents([0, 8, 16, 24]) });
    await harness.engine.play();
    harness.advanceTo(2);
    expect(harness.engine.getPositionSteps()).toBeGreaterThan(8);
    const voicesBefore = harness.fake.oscillators.length;

    await harness.engine.restart();
    expect(harness.engine.transport.status).toBe('playing');
    expect(harness.engine.getPositionSteps()).toBeCloseTo(0, 6);
    harness.advanceTo(2.1);
    // Only the first step of the restarted pass falls inside the lookahead window.
    expect(harness.fake.oscillators).toHaveLength(voicesBefore + 1);
  });

  it('seeking moves the playhead and re-cursors the scheduler', async () => {
    const harness = createEngine({ events: stepEvents([0, 8, 16, 24]) });
    await harness.engine.play();
    harness.advanceTo(0.1);
    expect(harness.fake.oscillators).toHaveLength(1);

    harness.engine.seek(16);
    expect(harness.engine.getPositionSteps()).toBeCloseTo(16, 6);

    harness.advanceTo(0.2);
    // Only the event at the seek target sounds; the note that was ringing was released.
    const sounding = harness.fake.getSoundingSources(0.2);
    expect(sounding).toHaveLength(1);
    expect(sounding[0].startedAt).toBeCloseTo(0.1, 6);
    // Step 16 now starts at 0.1 s; steps 0 and 8 are behind the playhead and are not replayed.
    const starts = harness.fake.oscillators.map((node) => node.startedAt ?? 0);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBeCloseTo(0.06, 6);
    expect(starts[1]).toBeCloseTo(0.1, 6);
  });

  it('applies tempo changes without duplicating or dropping the current position', async () => {
    const harness = createEngine({ events: stepEvents([0, 4, 8]) });
    await harness.engine.play();
    harness.advanceTo(0.1);
    const positionBefore = harness.engine.getPositionSteps();
    expect(harness.fake.oscillators).toHaveLength(1);

    harness.engine.setTempo(60);
    expect(harness.engine.getPositionSteps()).toBeCloseTo(positionBefore, 6);

    // At 60 BPM a step lasts 0.25 s: step 4 is 3.68 steps past position 0.32, i.e. 0.92 s later.
    harness.advanceTo(1.0);
    expect(harness.fake.oscillators.map((node) => node.startedAt)).toEqual([0.06, 0.1 + 3.68 * 0.25]);
    // The step-4 voice queued under the old tempo (0.56 s) was cancelled and never started.
    expect(harness.fake.oscillators.some((node) => Math.abs((node.startedAt ?? 0) - 0.56) < 0.01)).toBe(false);
  });

  it('stops at the region end when looping is disabled', async () => {
    const harness = createEngine({ events: stepEvents([0, 8]) });
    harness.engine.setLoopEnabled(false);
    await harness.engine.play();
    expect(harness.engine.transport.loop.enabled).toBe(false);

    harness.advanceTo(3.9);
    expect(harness.engine.transport.status).toBe('playing');

    // The 32-step region ends 4 s after the anchor.
    harness.advanceTo(4.2);
    expect(harness.engine.transport.status).toBe('stopped');
    expect(harness.engine.getPositionSteps()).toBe(0);
  });

  it('replaces the sequence while playing without replaying what already sounded', async () => {
    const harness = createEngine({ events: stepEvents([0, 4]) });
    await harness.engine.play();
    harness.advanceTo(0.1);

    harness.engine.setSequence(stepEvents([0, 4, 8]));
    harness.advanceTo(0.6);
    const starts = harness.fake.oscillators.map((node) => node.startedAt);
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts).toEqual([0.06, 0.56]);
  });

  it('auditions a test tone without starting the transport', async () => {
    const harness = createEngine();
    await harness.engine.auditionTestTone();
    expect(harness.engine.transport.status).toBe('stopped');
    expect(harness.fake.oscillators).toHaveLength(1);
    expect(harness.fake.oscillators[0].startedAt).toBeCloseTo(0.02, 6);
  });

  it('auditions a loaded sample buffer without starting the transport', async () => {
    const buffer = new FakeAudioBuffer(1, 4800, 48000);
    const harness = createEngine({ resolveSample: () => buffer as unknown as AudioBuffer });
    await harness.engine.auditionSample('channel-kick', 'sample-1');

    expect(harness.engine.transport.status).toBe('stopped');
    expect(harness.fake.bufferSources).toHaveLength(1);
    expect(harness.fake.bufferSources[0].buffer).not.toBeNull();
    expect(harness.fake.bufferSources[0].startedAt).toBeCloseTo(0.02, 6);
    expect(harness.fake.oscillators).toHaveLength(0);
  });

  it('auditions the built-in voice when no sample buffer is loaded', async () => {
    const harness = createEngine({ resolveSample: () => null });
    await harness.engine.auditionSample('channel-kick', 'Kick');
    expect(harness.engine.transport.status).toBe('stopped');
    expect(harness.fake.oscillators).toHaveLength(1);
    expect(harness.fake.bufferSources).toHaveLength(0);
  });

  it('previews a pitched instrument note without starting the transport', async () => {
    const harness = createEngine();
    await harness.engine.auditionNote('channel-bass', 64, 0.7);
    expect(harness.engine.transport.status).toBe('stopped');
    // Two detuned saws plus a sub oscillator.
    expect(harness.fake.oscillators).toHaveLength(3);
    expect(harness.fake.oscillators[0].startedAt).toBeCloseTo(0.02, 6);
  });

  it('decodes sample files without resuming or running the transport', async () => {
    const harness = createEngine();
    const decoded = await harness.engine.decodeAudioData(new ArrayBuffer(128));

    expect(decoded.length).toBeGreaterThan(0);
    expect(harness.fake.decodeCount).toBe(1);
    expect(harness.fake.resumeCount).toBe(0);
    expect(harness.engine.transport.status).toBe('stopped');
    // The idle context is attached so later playback reuses it.
    expect(harness.engine.status).toBe('suspended');
  });

  it('propagates decode failures to the caller', async () => {
    const harness = createEngine();
    harness.fake.failNextDecode = true;
    await expect(harness.engine.decodeAudioData(new ArrayBuffer(64))).rejects.toThrow(/not supported/);
  });

  it('aligns the visual playhead with the reported output latency', async () => {
    const harness = createEngine({ events: stepEvents([0]) });
    await harness.engine.play();
    harness.fake.outputLatency = 0.05;
    harness.fake.advanceTo(1.06);
    expect(harness.engine.getPositionSteps()).toBeCloseTo(8, 6);
    // 0.05 s of latency is 0.4 steps at 120 BPM, so the drawn position trails the audio clock.
    expect(harness.engine.getPlayheadSteps()).toBeCloseTo(7.6, 6);
  });

  it('exposes diagnostics for the scheduling window', async () => {
    const harness = createEngine({ events: stepEvents([0, 4]) });
    await harness.engine.play();
    harness.advanceTo(0.1);
    const diagnostics = harness.engine.getDiagnostics();
    expect(diagnostics).toMatchObject({ scheduledCount: 1, droppedCount: 0, running: true });
    expect(diagnostics.ticks).toBeGreaterThanOrEqual(1);
    expect(diagnostics.lastWindowSeconds).toBeCloseTo(0.12, 6);
  });
});

describe('starter project end to end', () => {
  it('turns project data into audible voices at musical times', async () => {
    const project = createInitialProject();
    const { events, engine, fake } = (() => {
      const harness = createEngine();
      return {
        events: buildPlaylistEvents(project, {
          timeSignature: project.settings.timeSignature,
          endStep: 128,
        }),
        engine: harness.engine,
        fake: harness.fake,
      };
    })();

    expect(events.length).toBeGreaterThan(0);
    engine.setTempo(project.settings.tempo); // 124 BPM
    engine.setSequence(events);
    await engine.play();

    // 124 BPM in 4/4: one sixteenth note lasts 60 / 124 / 4 seconds.
    const stepSeconds = 60 / project.settings.tempo / 4;
    const anchor = 0.06;
    const advanceTo = (time: number) => {
      while (fake.currentTime + TICK_STEP <= time + 1e-9) {
        fake.advanceTo(fake.currentTime + TICK_STEP);
        engine.tick();
      }
      if (fake.currentTime < time) {
        fake.advanceTo(time);
        engine.tick();
      }
    };
    advanceTo(0.5);

    // Steps 0, 2 and 4 of the starter pattern: hats on 0/2/4, kick on 0, bass note on 0,
    // snare on 4. Hats and snares are noise voices; kicks and notes use oscillators.
    const noiseStarts = fake.bufferSources.map((node) => node.startedAt ?? 0);
    expect(noiseStarts).toHaveLength(4);
    expect(noiseStarts[0]).toBeCloseTo(anchor, 9);
    expect(noiseStarts[1]).toBeCloseTo(anchor + 2 * stepSeconds, 9);
    expect(noiseStarts[2]).toBeCloseTo(anchor + 4 * stepSeconds, 9);
    // The snare at step 4 starts together with its hat.
    expect(noiseStarts[3]).toBeCloseTo(noiseStarts[2], 9);
    // kick (1) + bass note on step 0 (3) + snare body (1) + bass note on step 4 (3)
    expect(fake.oscillators).toHaveLength(8);
    expect(engine.getDiagnostics().droppedCount).toBe(0);

    // Every gap is an exact multiple of one step at the project tempo.
    expect(noiseStarts[1] - noiseStarts[0]).toBeCloseTo(2 * stepSeconds, 9);
    expect(noiseStarts[2] - noiseStarts[0]).toBeCloseTo(4 * stepSeconds, 9);
  });

  it('survives two full loops of the starter pattern without drift or duplicates', async () => {
    const project = createInitialProject();
    const harness = createEngine({ events: [] });
    harness.engine.setTempo(project.settings.tempo);
    harness.engine.setSequence(
      buildPlaylistEvents(project, { timeSignature: project.settings.timeSignature, endStep: 128 }),
    );
    harness.engine.setLoop({ startStep: 0, endStep: 128 });
    await harness.engine.play();

    const loopSeconds = (128 * 60) / project.settings.tempo / 4;
    harness.advanceTo(loopSeconds * 2 + 0.2);

    const diagnostics = harness.engine.getDiagnostics();
    expect(diagnostics.droppedCount).toBe(0);
    // Two loops plus the downbeat of the third.
    const starts = harness.fake.sources.map((node) => node.startedAt ?? 0);
    const firstLoop = starts.filter((time) => time < 0.06 + loopSeconds).length;
    const secondLoop = starts.filter(
      (time) => time >= 0.06 + loopSeconds && time < 0.06 + loopSeconds * 2,
    ).length;
    expect(firstLoop).toBeGreaterThan(0);
    expect(secondLoop).toBe(firstLoop);
  });
});
