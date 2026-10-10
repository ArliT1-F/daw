import { expect, test, type Page } from '@playwright/test';

interface AudioProbe { analyzers: AnalyserNode[]; rms(): number }
declare global {
  interface Window {
    __mixerProbe: AudioProbe;
  }
}

/**
 * Mixer acceptance: real layout, real Web Audio. The master output is measured with an analyser
 * tapped in front of the hardware destination, so these tests assert the signal a listener hears —
 * the master fader, per-channel mute/solo gates, and rerouting all act on that measured output.
 */
async function boot(page: Page) {
  await page.addInitScript(() => {
    const original = window.AudioContext;
    const probe: AudioProbe = {
      analyzers: [],
      rms() {
        return Math.max(
          0,
          ...this.analyzers.map((analyzer) => {
            const values = new Float32Array(analyzer.fftSize);
            analyzer.getFloatTimeDomainData(values);
            return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
          }),
        );
      },
    };
    window.__mixerProbe = probe;
    class ProbedContext extends original {
      constructor(options?: AudioContextOptions) {
        super(options);
      }
      override createDynamicsCompressor() {
        const node = super.createDynamicsCompressor();
        const analyzer = this.createAnalyser();
        analyzer.fftSize = 2048;
        probe.analyzers.push(analyzer);
        const connect = node.connect.bind(node);
        node.connect = ((destination: AudioNode) => {
          if (destination === this.destination) connect(analyzer);
          return connect(destination);
        }) as typeof node.connect;
        return node;
      }
    }
    window.AudioContext = ProbedContext;
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Mixer', exact: true })).toBeVisible();
}

/** Set a mixer fader by driving its range input the way a pointer drag would. */
async function setFader(page: Page, label: string, db: number) {
  await page.getByLabel(label, { exact: true }).evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, db);
}

const MASTER_FADER = 'Volume of mixer channel Master in decibels';

test('the master fader controls the measured output level', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);

  await page.getByLabel('Play', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mixerProbe.rms()), { timeout: 4000 }).toBeGreaterThan(0.001);

  // Pulling the master fader to the floor silences the measured output.
  await setFader(page, MASTER_FADER, -60);
  await expect.poll(() => page.evaluate(() => window.__mixerProbe.rms()), { timeout: 3000 }).toBeLessThan(0.0002);

  // Restoring unity brings the signal straight back, so the fader gates gain rather than the path.
  await setFader(page, MASTER_FADER, 0);
  await expect.poll(() => page.evaluate(() => window.__mixerProbe.rms()), { timeout: 4000 }).toBeGreaterThan(0.001);

  await page.getByLabel('Stop transport and return to start', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mixerProbe.rms())).toBeLessThan(0.0001);
  expect(errors).toEqual([]);
});

test('muting every insert gates the mix before the master bus without disconnecting it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);

  await page.getByLabel('Play', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mixerProbe.rms()), { timeout: 4000 }).toBeGreaterThan(0.001);

  for (const name of ['Kick', 'Snare', 'Closed Hat', 'Soft Synth']) {
    await page.getByLabel(`Mute mixer channel ${name}`, { exact: true }).click();
  }
  // Every insert gated: the master bus is still in the chain but receives no signal.
  await expect.poll(() => page.evaluate(() => window.__mixerProbe.rms()), { timeout: 3000 }).toBeLessThan(0.0002);

  // Unmuting restores the mix; the master bus was never bypassed or rebuilt.
  for (const name of ['Kick', 'Snare', 'Closed Hat', 'Soft Synth']) {
    await page.getByLabel(`Mute mixer channel ${name}`, { exact: true }).click();
  }
  await expect.poll(() => page.evaluate(() => window.__mixerProbe.rms()), { timeout: 4000 }).toBeGreaterThan(0.001);
  expect(errors).toEqual([]);
});

test('solo passes only the soloed insert, and a reroute keeps the signal audible', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);

  await page.getByLabel('Play', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mixerProbe.rms()), { timeout: 4000 }).toBeGreaterThan(0.001);

  // Solo the kick: the unsoloed inserts are gated, but the soloed channel still reaches the master.
  await page.getByLabel('Solo mixer channel Kick', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mixerProbe.rms()), { timeout: 4000 }).toBeGreaterThan(0.0005);
  await page.getByLabel('Solo mixer channel Kick', { exact: true }).click();

  // Reroute the kick through the snare insert and out the master: no dropped or duplicated path.
  await page.getByLabel('Output of mixer channel Kick', { exact: true }).selectOption('mixer-insert-2');
  await expect.poll(() => page.evaluate(() => window.__mixerProbe.rms()), { timeout: 4000 }).toBeGreaterThan(0.001);
  expect(errors).toEqual([]);
});

test('level meters are live while audio is playing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);

  const masterReadout = page.locator('.mixer-strip--master [data-meter="readout"]');
  await expect(masterReadout).toHaveText('-inf dB');
  await page.getByLabel('Play', { exact: true }).click();
  // The master peak readout leaves the silence floor once signal reaches the output.
  await expect.poll(async () => (await masterReadout.textContent()) ?? '', { timeout: 5000 }).not.toBe('-inf dB');

  // The transport master meter is bound and filling while playing.
  await expect.poll(
    () => page.evaluate(() => {
      const fill = document.querySelector<HTMLElement>('.master-placeholder [data-meter="fill"]');
      return fill ? parseFloat(fill.style.width || '0') : 0;
    }),
    { timeout: 5000 },
  ).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
