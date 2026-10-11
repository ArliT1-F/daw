import { describe, expect, it } from 'vitest';
import { buildMixerState, type MixerState } from '../core/mixer/mixerModel';
import { applyProjectCommand } from '../core/commands';
import { createInitialProject, MASTER_MIXER_CHANNEL_ID } from '../core/project/model';
import { createFakeOfflineContext, type FakeAudioContext } from './__fixtures__/fakeAudioContext';
import { renderMixOffline, type OfflineRenderContext } from './offlineRender';

/** Structural checks on the offline path, on the double. Sample accuracy lives in offlineRender.test.ts. */
describe('offline render graph lifecycle', () => {
  it('sizes the offline context from the duration and sample rate and renders through it', async () => {
    let fake: FakeAudioContext | null = null;
    const state: MixerState = buildMixerState(createInitialProject());
    const result = await renderMixOffline({
      mixerState: state,
      sources: [],
      durationSeconds: 0.5,
      sampleRate: 44100,
      createContext: (request) => {
        const bundle = createFakeOfflineContext(request);
        fake = bundle.fake;
        return bundle.context as unknown as OfflineRenderContext;
      },
    });
    expect(fake).not.toBeNull();
    expect(fake!.renderLength).toBe(22050);
    expect(fake!.renderCount).toBe(1);
    expect(result.buffer.length).toBe(22050);
    expect(result.warnings).toEqual([]);
  });

  it('builds the mix with its effects and releases every node it created', async () => {
    let fake: FakeAudioContext | null = null;
    let project = createInitialProject();
    project = applyProjectCommand(project, { type: 'mixer.effect.add', channelId: 'mixer-insert-1', effectId: 'fx-r', effectType: 'reverb' });
    project = applyProjectCommand(project, { type: 'mixer.effect.add', channelId: MASTER_MIXER_CHANNEL_ID, effectId: 'fx-l', effectType: 'limiter' });
    const state = buildMixerState(project);

    await renderMixOffline({
      mixerState: state,
      sources: [],
      durationSeconds: 0.1,
      sampleRate: 48000,
      createContext: (request) => {
        const bundle = createFakeOfflineContext(request);
        fake = bundle.fake;
        return bundle.context as unknown as OfflineRenderContext;
      },
    });

    // The reverb and limiter were built on the offline context, and dispose left nothing connected to the output.
    expect(fake!.convolvers.length).toBeGreaterThan(0);
    expect(fake!.compressors.length).toBeGreaterThan(0);
    for (const convolver of fake!.convolvers) expect(convolver.connectionCount).toBe(0);
    expect(fake!.destination.connectionCount).toBe(0);
  });

  it('validates its inputs before building anything', async () => {
    const state = buildMixerState(createInitialProject());
    const base = { mixerState: state, sources: [], sampleRate: 48000, createContext: () => { throw new Error('should not build'); } };
    await expect(renderMixOffline({ ...base, durationSeconds: 0 })).rejects.toThrow(/positive duration/);
    await expect(renderMixOffline({ ...base, durationSeconds: 1, sampleRate: 1000 })).rejects.toThrow(/sample rate/);
    await expect(renderMixOffline({ ...base, durationSeconds: 1, sampleRate: 48000, channels: 6 })).rejects.toThrow(/mono or stereo/);
  });
});
