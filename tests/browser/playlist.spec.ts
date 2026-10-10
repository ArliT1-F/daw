import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import type { BrowserAudioEngine } from '../../src/audio/AudioEngine';
import type { ScheduledEventTiming } from '../../src/core/events/musicalEvents';

interface SourceRecord { kind: 'oscillator' | 'buffer'; time: number; offset: number; duration?: number; bufferDuration?: number; stopTime?: number }
interface AudioProbe { contexts: AudioContext[]; analyzers: AnalyserNode[]; starts: SourceRecord[]; rms(): number }
declare global {
  interface Window {
    __playlistProbe: AudioProbe;
    __arrangementVerification: { engine: BrowserAudioEngine; records: ScheduledEventTiming[]; windows: Array<{ startStep: number; endStep: number }> };
  }
}

async function boot(page: Page) {
  await page.addInitScript(() => {
    const original = window.AudioContext;
    const probe: AudioProbe = { contexts: [], analyzers: [], starts: [], rms() {
      return Math.max(0, ...this.analyzers.map((analyzer) => {
        const values = new Float32Array(analyzer.fftSize);
        analyzer.getFloatTimeDomainData(values);
        return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
      }));
    } };
    window.__playlistProbe = probe;
    class ProbedContext extends original {
      constructor(options?: AudioContextOptions) {
        super(options);
        probe.contexts.push(this);
      }
      override createDynamicsCompressor() {
        const node = super.createDynamicsCompressor();
        const analyzer = this.createAnalyser(); analyzer.fftSize = 2048; probe.analyzers.push(analyzer);
        const connect = node.connect.bind(node);
        node.connect = ((destination: AudioNode) => {
          if (destination === this.destination) connect(analyzer);
          return connect(destination);
        }) as typeof node.connect;
        return node;
      }
      override createOscillator() {
        const source = super.createOscillator();
        const start = source.start.bind(source), stop = source.stop.bind(source);
        let record: SourceRecord;
        source.start = (time = 0) => { record = { kind: 'oscillator', time, offset: 0 }; probe.starts.push(record); start(time); };
        source.stop = (time = 0) => { if (record) record.stopTime = time; stop(time); };
        return source;
      }
      override createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source), stop = source.stop.bind(source);
        let record: SourceRecord;
        source.start = (time = 0, offset = 0, duration?: number) => { record = { kind: 'buffer', time, offset, duration, bufferDuration: source.buffer?.duration }; probe.starts.push(record); if (duration === undefined) start(time, offset); else start(time, offset, duration); };
        source.stop = (time = 0) => { if (record) record.stopTime = time; stop(time); };
        return source;
      }
    }
    window.AudioContext = ProbedContext;
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Playlist', exact: true })).toBeVisible();
}

/** Generate a deterministic PCM asset in memory; binary audio never enters the repository. */
function wav(seconds = 3): Buffer {
  const sampleRate = 48000, frames = Math.round(seconds * sampleRate);
  const file = Buffer.alloc(44 + frames * 2);
  file.write('RIFF', 0); file.writeUInt32LE(file.length - 8, 4); file.write('WAVEfmt ', 8);
  file.writeUInt32LE(16, 16); file.writeUInt16LE(1, 20); file.writeUInt16LE(1, 22);
  file.writeUInt32LE(sampleRate, 24); file.writeUInt32LE(sampleRate * 2, 28); file.writeUInt16LE(2, 32); file.writeUInt16LE(16, 34);
  file.write('data', 36); file.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame += 1) file.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * frame / sampleRate) * 8000), 44 + frame * 2);
  return file;
}
async function number(page: Page, label: string, value: string) {
  const input = page.getByLabel(label, { exact: true }); await input.fill(value); await input.press('Enter');
}

// Exact boundary/timing assertions also live in Vitest; these tests use real layout, pointer
// capture, file decoding, the Worker timer, Web Audio voices, and a master-output signal probe.
test('construct, edit, multi-select, duplicate, delete, and undo a multitrack arrangement', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);
  await page.getByLabel('Add Playlist track', { exact: true }).click();
  await number(page, 'Track name Track 4', 'Textures');
  await page.getByLabel('Mute track Textures', { exact: true }).click();
  await expect(page.getByLabel('Mute track Textures', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Solo track Textures', { exact: true }).click();
  await expect(page.getByLabel('Solo track Textures', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Solo track Textures', { exact: true }).click();
  await page.getByLabel('Mute track Textures', { exact: true }).click();
  await page.getByLabel('Move track Textures up', { exact: true }).click();
  await expect(page.locator('.timeline-track-row').nth(2).getByLabel('Track name Textures', { exact: true })).toBeVisible();

  const original = page.locator('[data-clip-id="clip-main-0"]');
  await original.click();
  await number(page, 'Clip start beat', '2');
  await expect(page.getByLabel('Clip start beat', { exact: true })).toHaveValue('2');
  await number(page, 'Clip duration beats', '4');
  await page.getByLabel('Scrollable arrangement timeline', { exact: true }).evaluate((element) => { element.scrollTop = 0; });
  await original.scrollIntoViewIfNeeded();
  const box = await original.boundingBox();
  const lane = await page.getByLabel('Audio arrangement lane', { exact: true }).boundingBox();
  if (!box || !lane) throw new Error('Missing clip/lane layout');
  await page.mouse.move(box.x + 20, box.y + 14); await page.mouse.down();
  await page.mouse.move(box.x + 44, lane.y + 18, { steps: 8 }); await page.mouse.up();
  await expect(page.getByLabel('Clip track', { exact: true })).toHaveValue('track-audio');
  await expect(page.getByLabel('Clip start beat', { exact: true })).toHaveValue('3');

  const edge = original.locator('.playlist-clip-handle--end');
  await edge.scrollIntoViewIfNeeded(); const edgeBox = await edge.boundingBox();
  if (!edgeBox) throw new Error('Missing resize handle');
  await page.mouse.move(edgeBox.x + 3, edgeBox.y + 12); await page.mouse.down();
  await page.mouse.move(edgeBox.x + 27, edgeBox.y + 12, { steps: 8 }); await page.mouse.up();
  await expect(page.getByLabel('Clip duration beats', { exact: true })).toHaveValue('5');
  await page.getByLabel('Duplicate selected clips', { exact: true }).click();
  await expect(page.locator('.playlist-clip')).toHaveCount(2);
  await page.getByLabel('Playlist editor', { exact: true }).focus();
  await page.keyboard.press('Control+a'); await page.keyboard.press('ArrowRight');
  await expect(page.locator('.playlist-clip--selected')).toHaveCount(2);
  await page.keyboard.press('Delete'); await expect(page.locator('.playlist-clip')).toHaveCount(0);
  await page.keyboard.press('Control+z'); await expect(page.locator('.playlist-clip')).toHaveCount(2);
  await expect(page.getByLabel('Selected pattern', { exact: true }).locator('option')).toHaveCount(1);
  await original.dblclick();
  await expect(page.getByTestId('piano-grid')).toBeVisible();
  expect(errors).toEqual([]);
});

test('scroll and zoom past eight bars, place a later clip, seek, and render actual master audio', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);
  await page.getByLabel('Looping is on', { exact: true }).click();
  const scroll = page.getByLabel('Scrollable arrangement timeline', { exact: true });
  await scroll.evaluate((element) => { element.scrollLeft = 8 * 96; });
  await page.getByLabel('Place Pattern 01 clip at bar 12', { exact: true }).click({ position: { x: 4, y: 14 } });
  await expect(page.getByLabel('Clip start beat', { exact: true })).toHaveValue('45');
  await page.getByLabel('Zoom Playlist in', { exact: true }).click();
  await scroll.evaluate((element) => { element.scrollLeft = 11 * 120; });
  await page.getByLabel('Seek to bar 12', { exact: true }).click();
  await expect(page.locator('.position-value')).toHaveText('12 : 01 : 01');
  await page.getByLabel('Play', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__playlistProbe.rms()), { timeout: 4000 }).toBeGreaterThan(0.001);
  await expect(page.locator('.timeline-playhead--playing')).toHaveCount(1);
  await page.getByLabel('Stop transport and return to start', { exact: true }).click();
  await expect(page.locator('.position-value')).toHaveText('01 : 01 : 01');
  await expect.poll(() => page.evaluate(() => window.__playlistProbe.rms())).toBeLessThan(0.0001);
  expect(errors).toEqual([]);
});

test('decode/trim audio, loop a mid-song region with tempo automation, and seek into the source', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);
  await number(page, 'Loop start bar', '2.5'); await number(page, 'Loop end bar', '3.25');
  await page.getByLabel('Tempo marker BPM', { exact: true }).fill('90');
  await page.getByLabel('Set tempo marker at playhead', { exact: true }).click();
  await page.getByLabel('Track name Audio', { exact: true }).click();
  await page.getByLabel('Import an audio file into the Playlist', { exact: true }).setInputFiles({ name: 'texture.wav', mimeType: 'audio/wav', buffer: wav() });
  await expect(page.locator('.playlist-clip--audio')).toHaveCount(1);
  await number(page, 'Audio source start seconds', '0.4');
  await page.getByLabel('Play', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__playlistProbe.starts.filter((record) => record.bufferDuration === 3).length), { timeout: 7500 }).toBeGreaterThanOrEqual(3);
  const starts = await page.evaluate(() => window.__playlistProbe.starts.filter((record) => record.bufferDuration === 3));
  starts.slice(0, 3).forEach((record) => { expect(record.offset).toBeCloseTo(0.4, 8); expect(record.duration).toBeCloseTo(2, 8); });
  expect(starts[1].time - starts[0].time).toBeCloseTo(2, 8);
  expect(starts[2].time - starts[1].time).toBeCloseTo(2, 8);
  await page.getByLabel('Seek to bar 3', { exact: true }).click();
  const chased = await page.evaluate(() => window.__playlistProbe.starts.filter((record) => record.bufferDuration === 3).at(-1)!);
  const targetOffset = 0.4 + 8 * 60 / 90 / 4;
  expect(chased.offset).toBeGreaterThanOrEqual(targetOffset - 1e-8);
  expect(chased.offset).toBeLessThan(targetOffset + 0.03); // real audio clock may advance during seek/voice creation
  expect(chased.offset + (chased.duration ?? 0)).toBeCloseTo(2.4, 8); // fixed source/loop end, no drift
  await page.getByLabel('Stop transport and return to start', { exact: true }).click();
  await expect(page.locator('.position-value')).toHaveText('02 : 03 : 01');
  await expect.poll(() => page.evaluate(() => window.__playlistProbe.rms())).toBeLessThan(0.0001);
  expect(errors).toEqual([]);
});

test('real Web Audio plays the multi-instrument overlap/tempo fixture without duplicate scheduling', async ({ page }) => {
  await boot(page);
  // Establish the browser's sticky user activation before constructing a second test-owned engine.
  await page.getByLabel('Play a test tone', { exact: true }).click();
  await page.evaluate(async () => {
    const fixturePath = '/src/core/arrangement/__fixtures__/testArrangement.ts';
    const enginePath = '/src/audio/AudioEngine.ts', eventsPath = '/src/core/events/arrangementEventSource.ts';
    const helpersPath = '/src/core/arrangement/arrangement.ts';
    const [{ createTestArrangement }, { BrowserAudioEngine }, { ArrangementEventSource }, helpers] = await Promise.all([import(fixturePath), import(enginePath), import(eventsPath), import(helpersPath)]);
    const project = createTestArrangement();
    const context = new window.AudioContext();
    const buffer = context.createBuffer(1, context.sampleRate * 8, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.sin(2 * Math.PI * 220 * index / context.sampleRate) * 0.15;
    const engine: BrowserAudioEngine = new BrowserAudioEngine({ createContext: () => context, resolveSample: (id: string) => id === 'asset-texture' ? buffer : null });
    const records: ScheduledEventTiming[] = [], windows: Array<{ startStep: number; endStep: number }> = [];
    const schedule = engine.scheduleEvent.bind(engine);
    engine.scheduleEvent = (timing) => { records.push(timing); schedule(timing); };
    const source = new ArrangementEventSource(project), query = source.queryWindow.bind(source);
    source.queryWindow = (window: { startStep: number; endStep: number }) => { windows.push(window); return query(window); };
    engine.setArrangement(source, { tempoMap: helpers.getProjectTempoMap(project), timeSignature: project.settings.timeSignature, loop: helpers.getPlaybackRegion(project) });
    window.__arrangementVerification = { engine, records, windows };
    await engine.play();
  });
  await expect.poll(() => page.evaluate(() => window.__arrangementVerification.records.some((record) => record.iteration === 1)), { timeout: 7000 }).toBe(true);
  const records = await page.evaluate(() => window.__arrangementVerification.records);
  expect(new Set(records.map((record) => `${record.event.id}@${record.iteration}`)).size).toBe(records.length);
  expect(new Set(records.filter((record) => record.event.kind === 'note').map((record) => record.event.channelId))).toEqual(new Set(['channel-bass', 'channel-pad']));
  expect(new Set(records.map((record) => record.event.clipId))).toEqual(new Set(['clip-a', 'clip-b', 'clip-c', 'clip-audio']));
  const audio = records.filter((record) => record.event.kind === 'audio');
  expect(audio).toHaveLength(2);
  expect(audio[1].time - audio[0].time).toBeCloseTo(1 + 16 * 60 / 90 / 4 + 8 * 60 / 150 / 4, 8);
  await expect.poll(() => page.evaluate(() => window.__playlistProbe.rms())).toBeGreaterThan(0.001);
  expect(await page.evaluate(() => window.__arrangementVerification.windows.every((window) => window.endStep - window.startStep < 2))).toBe(true);
  const seekTime = await page.evaluate(() => { const engine = window.__arrangementVerification.engine; engine.seek(44); return engine.transport.timeAtStep(44); });
  const last = await page.evaluate(() => window.__arrangementVerification.records.filter((record) => record.event.kind === 'audio').at(-1)!);
  expect(last.sourceOffsetSeconds).toBeCloseTo(4 + last.time - seekTime, 8);
  await page.evaluate(() => window.__arrangementVerification.engine.stop());
  await expect.poll(() => page.evaluate(() => window.__playlistProbe.rms())).toBeLessThan(0.0001);
  await page.evaluate(() => window.__arrangementVerification.engine.dispose());
});

test('Playlist remains operable on a narrow viewport with independent toolbar/timeline scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await page.getByRole('heading', { name: 'Playlist', exact: true }).scrollIntoViewIfNeeded();
  await page.getByLabel('Add Playlist track', { exact: true }).click();
  await expect(page.locator('.timeline-track-row')).toHaveCount(4);
  await page.getByLabel('Zoom Playlist in', { exact: true }).click();
  await page.getByLabel('Scrollable arrangement timeline', { exact: true }).evaluate((element) => { element.scrollLeft = 120 * 5; });
  await expect(page.getByLabel('Seek to bar 7', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});
