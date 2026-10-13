// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mixer } from './Mixer';
import { MeterViewRegistry } from './meterView';
import { applyProjectCommand, type ProjectCommand } from '../../core/commands';
import { defaultEffectParams } from '../../core/effects/effectDefinitions';
import { createInitialProject, MASTER_MIXER_CHANNEL_ID, type Project } from '../../core/project/model';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const INSERT = 'mixer-insert-1';
const MASTER = MASTER_MIXER_CHANNEL_ID;

let container: HTMLDivElement;
let root: Root;
let registry: MeterViewRegistry;
let recorded: Array<{ command: ProjectCommand; coalesceKey?: string }>;
let latest: Project;

/** Applies every command to a real project, so the rack is tested against the real reducer rules. */
function Harness({ initial }: { initial: Project }) {
  const [project, setProject] = useState(initial);
  latest = project;
  return (
    <Mixer
      collapsed={false}
      meterRegistry={registry}
      onClearClip={() => {}}
      onCommand={(command, options) => {
        recorded.push({ command, coalesceKey: options?.coalesceKey });
        try {
          const next = applyProjectCommand(latest, command);
          if (next !== latest) setProject(next);
          return next !== latest;
        } catch {
          return false;
        }
      }}
      onToggle={() => {}}
      project={project}
    />
  );
}

async function mount(initial: Project = createInitialProject()) {
  await act(async () => {
    root.render(<Harness initial={initial} />);
  });
}

function query<T extends Element = HTMLElement>(selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function byLabel(text: string): HTMLElement {
  return query(`[aria-label="${text}"]`);
}

function fxButton(channelName: string): HTMLButtonElement {
  return byLabel(`Effects for mixer channel ${channelName}: ${latest.mixerChannels.find((c) => c.name === channelName)!.effects.filter((s) => s.type).length} loaded`) as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function setRange(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function chooseOption(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  registry = new MeterViewRegistry();
  recorded = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('effects rack', () => {
  it('opens from the strip FX button and reports the loaded count', async () => {
    await mount();
    expect(container.querySelector('#fx-rack')).toBeNull();
    await click(fxButton('Kick'));
    expect(query('#fx-rack').getAttribute('aria-label')).toBe('Effects for mixer channel Kick');
    expect(query('[aria-controls="fx-rack"]').getAttribute('aria-expanded')).toBe('true');
    await click(byLabel('Close effects rack'));
    expect(container.querySelector('#fx-rack')).toBeNull();
  });

  it('adds an effect with a stable id and its defaults', async () => {
    await mount();
    await click(fxButton('Kick'));
    await chooseOption(byLabel('Add effect to Kick') as HTMLSelectElement, 'delay');
    const add = recorded.find((entry) => entry.command.type === 'mixer.effect.add');
    expect(add?.command).toMatchObject({ type: 'mixer.effect.add', channelId: INSERT, effectType: 'delay' });
    const slot = latest.mixerChannels.find((channel) => channel.id === INSERT)!.effects[0];
    expect(slot).toMatchObject({ type: 'delay', enabled: true, params: defaultEffectParams('delay') });
    expect(query('[data-effect-type="delay"]').textContent).toContain('Delay');
  });

  it('does not offer the limiter on an insert channel, but does on master', async () => {
    await mount();
    await click(fxButton('Kick'));
    const insertOptions = [...(byLabel('Add effect to Kick') as HTMLSelectElement).options].map((option) => option.value);
    expect(insertOptions).not.toContain('limiter');
    await click(fxButton('Master'));
    const masterOptions = [...(byLabel('Add effect to Master') as HTMLSelectElement).options].map((option) => option.value);
    expect(masterOptions).toContain('limiter');
  });

  it('sends a param change with a coalesce key per effect and parameter', async () => {
    let project = applyProjectCommand(createInitialProject(), { type: 'mixer.effect.add', channelId: INSERT, effectId: 'fx-dly', effectType: 'delay' });
    await mount(project);
    await click(fxButton('Kick'));
    const slider = byLabel('Feedback of Delay on Kick') as HTMLInputElement;
    // Sliders run over the parameter's own range: position 0.5 is half of 0..0.95, quantised to the 0.01 step.
    await setRange(slider, '0.5');
    const param = recorded.find((entry) => entry.command.type === 'mixer.effect.param.set');
    expect(param?.command).toMatchObject({ channelId: INSERT, effectId: 'fx-dly', key: 'feedback' });
    expect((param?.command as { value: number }).value).toBeCloseTo(0.48, 2);
    expect(param?.coalesceKey).toMatch(/^fx-param:fx-dly:feedback:\d+$/);
    project = latest;
    expect(project.mixerChannels.find((channel) => channel.id === INSERT)!.effects[0].params.feedback).toBeCloseTo(0.48, 2);
  });

  it('toggles bypass and reorders through commands', async () => {
    let project = applyProjectCommand(createInitialProject(), { type: 'mixer.effect.add', channelId: INSERT, effectId: 'fx-a', effectType: 'eq3' });
    project = applyProjectCommand(project, { type: 'mixer.effect.add', channelId: INSERT, effectId: 'fx-b', effectType: 'delay' });
    await mount(project);
    await click(fxButton('Kick'));
    await click(byLabel('Enable 3-Band EQ on Kick'));
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.effect.enabled.set', effectId: 'fx-a', enabled: false });
    // Delay is last, so it can only move earlier; "later" is disabled.
    expect((byLabel('Move Delay later on Kick') as HTMLButtonElement).disabled).toBe(true);
    await click(byLabel('Move Delay earlier on Kick'));
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.effect.move', effectId: 'fx-b', toIndex: 0 });
  });

  it('removes an effect', async () => {
    const project = applyProjectCommand(createInitialProject(), { type: 'mixer.effect.add', channelId: INSERT, effectId: 'fx-a', effectType: 'eq3' });
    await mount(project);
    await click(fxButton('Kick'));
    await click(byLabel('Remove 3-Band EQ from Kick'));
    expect(recorded.at(-1)?.command).toMatchObject({ type: 'mixer.effect.remove', effectId: 'fx-a' });
    expect(latest.mixerChannels.find((channel) => channel.id === INSERT)!.effects).toEqual([]);
  });

  it('disables adding once the chain is full', async () => {
    let project = createInitialProject();
    for (const [index, type] of (['eq3', 'delay', 'reverb', 'compressor'] as const).entries()) {
      project = applyProjectCommand(project, { type: 'mixer.effect.add', channelId: INSERT, effectId: `fx-${index}`, effectType: type });
    }
    await mount(project);
    await click(fxButton('Kick'));
    expect((byLabel('Add effect to Kick') as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows a limiter note on master above 0 dB, and not at or below it', async () => {
    let project = applyProjectCommand(createInitialProject(), { type: 'mixer.effect.add', channelId: MASTER, effectId: 'fx-lim', effectType: 'limiter' });
    project = applyProjectCommand(project, { type: 'mixer.channel.volume.set', channelId: MASTER, volumeDb: 3 });
    await mount(project);
    expect(container.querySelector('.mixer-limiter-warning')?.textContent).toContain('limiter sits before the fader');

    // Bring the master fader back to unity through its own control.
    await setRange(byLabel('Volume of mixer channel Master in decibels') as HTMLInputElement, '0');
    expect(latest.mixerChannels.find((channel) => channel.id === MASTER)!.volumeDb).toBe(0);
    expect(container.querySelector('.mixer-limiter-warning')).toBeNull();
  });

  it('says when there is no master limiter above 0 dB', async () => {
    const project = applyProjectCommand(createInitialProject(), { type: 'mixer.channel.volume.set', channelId: MASTER, volumeDb: 2 });
    await mount(project);
    expect(container.querySelector('.mixer-limiter-warning')?.textContent).toContain('no master limiter');
  });
});
