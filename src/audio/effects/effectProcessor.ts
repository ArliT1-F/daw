/**
 * The effect processor the mixer bus sees: a bypass stage around one `EffectCore`.
 *
 *   input ──► dry gain ─────────────────────────────► output
 *      └────► core.input … core.output ──► wet gain ─┘
 *
 * Enabling and disabling only moves the dry/wet gains, so a bypass never cuts a reverb or delay tail
 * and never clicks. Once a bypass has settled, the processing path is disconnected, so an idle effect
 * costs no CPU. Re-enabling reconnects it. A new processor is built already engaged or already
 * bypassed, so nothing is ramped on construction.
 */

import {
  fillEffectParams,
  getEffectDefinition,
  validateEffectParams,
  type EffectType,
} from '../../core/effects/effectDefinitions';
import { createEffectCore } from './effectCores';
import {
  EFFECT_DISCONNECT_DELAY_MS,
  EFFECT_GATE_SMOOTH_SECONDS,
  type AudioEffectProcessor,
  type EffectCore,
  type EffectParamValues,
} from './types';

export interface EffectProcessorSpec {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: EffectParamValues;
}

/** Parameters after completion and validation. Throws with a message for anything out of contract. */
export function resolveEffectParams(type: EffectType, params: EffectParamValues): Record<string, number> {
  const filled = fillEffectParams(type, params);
  const issue = validateEffectParams(type, filled);
  if (issue) throw new Error(issue);
  return filled as Record<string, number>;
}

export class EffectProcessor implements AudioEffectProcessor {
  readonly id: string;
  readonly type: EffectType;
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly core: EffectCore;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private appliedParams: Record<string, number>;
  private appliedEnabled: boolean;
  private engaged = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(context: BaseAudioContext, spec: EffectProcessorSpec) {
    this.id = spec.id;
    this.type = spec.type;
    this.appliedParams = resolveEffectParams(spec.type, spec.params);
    this.appliedEnabled = spec.enabled;
    this.core = createEffectCore(context, spec.type, this.appliedParams);

    this.input = context.createGain();
    this.output = context.createGain();
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.input.gain.value = 1;
    this.output.gain.value = 1;
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.wet.connect(this.output);

    if (spec.enabled) {
      this.engage();
      this.dry.gain.value = 0;
      this.wet.gain.value = 1;
    } else {
      this.dry.gain.value = 1;
      this.wet.gain.value = 0;
    }
  }

  get enabled(): boolean {
    return this.appliedEnabled;
  }

  get params(): Readonly<Record<string, number>> {
    return this.appliedParams;
  }

  /** Human label, used in diagnostics and tests. */
  get label(): string {
    return getEffectDefinition(this.type).label;
  }

  update(params: EffectParamValues, when: number): number {
    if (this.disposed) return 0;
    const changed = Object.keys(params).filter((key) => params[key] !== this.appliedParams[key]);
    if (changed.length === 0) return 0;
    const next = resolveEffectParams(this.type, { ...this.appliedParams, ...params });
    const writes = this.core.update(next, changed, when);
    this.appliedParams = next;
    return writes;
  }

  setEnabled(enabled: boolean, when: number): number {
    if (this.disposed || enabled === this.appliedEnabled) return 0;
    this.appliedEnabled = enabled;
    if (enabled) {
      this.cancelDisconnect();
      this.engage();
      this.dry.gain.setTargetAtTime(0, when, EFFECT_GATE_SMOOTH_SECONDS);
      this.wet.gain.setTargetAtTime(1, when, EFFECT_GATE_SMOOTH_SECONDS);
    } else {
      this.dry.gain.setTargetAtTime(1, when, EFFECT_GATE_SMOOTH_SECONDS);
      this.wet.gain.setTargetAtTime(0, when, EFFECT_GATE_SMOOTH_SECONDS);
      this.cancelDisconnect();
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        if (!this.appliedEnabled) this.disengage();
      }, EFFECT_DISCONNECT_DELAY_MS);
    }
    return 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelDisconnect();
    this.disengage();
    this.core.dispose();
    this.input.disconnect();
    this.dry.disconnect();
    this.wet.disconnect();
    this.output.disconnect();
  }

  /** Connect the processing path. Idempotent: connecting an already-connected pair is skipped. */
  private engage(): void {
    if (this.engaged) return;
    this.engaged = true;
    this.input.connect(this.core.input);
    this.core.output.connect(this.wet);
  }

  private disengage(): void {
    if (!this.engaged) return;
    this.engaged = false;
    try {
      this.input.disconnect(this.core.input);
    } catch {
      /* already detached */
    }
    try {
      this.core.output.disconnect(this.wet);
    } catch {
      /* already detached */
    }
  }

  private cancelDisconnect(): void {
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }
}

/** Build a processor for one project effect. Throws for an invalid spec; the caller reports it. */
export function createEffectProcessor(context: BaseAudioContext, spec: EffectProcessorSpec): EffectProcessor {
  return new EffectProcessor(context, spec);
}
