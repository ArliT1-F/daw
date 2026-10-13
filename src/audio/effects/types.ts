/**
 * Contracts shared by the Web Audio effect processors.
 *
 * An effect is built from two layers:
 *  - an `EffectCore`: the type-specific nodes (filters, convolver, delay line, compressor). It knows
 *    how its parameters map onto AudioParams and how to tear its nodes down.
 *  - an `AudioEffectProcessor` (see `effectProcessor.ts`): the wrapper the mixer bus sees. It owns
 *    the dry/wet bypass stage, so enabling or disabling an effect is a short gain ramp that never
 *    cuts a tail, and it remembers the parameters it last applied so only changed values are sent.
 *
 * Nothing here knows about the project document or React. Effects receive plain parameter records.
 */

import type { EffectType } from '../../core/effects/effectDefinitions';

/** Parameter record in physical units, keyed by parameter key. */
export type EffectParamValues = Readonly<Record<string, number>>;

/** Effect as the mixer bus sees it: a node pair plus lifecycle, bypass, and parameter control. */
export interface AudioEffectProcessor {
  /** Stable effect id from the project chain. Processors are reused across syncs by this id. */
  readonly id: string;
  readonly type: EffectType;
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** Whether the effect is currently active (the bypass stage has been told so). */
  readonly enabled: boolean;
  /** The parameters the processor last applied. */
  readonly params: EffectParamValues;
  /**
   * Apply the changed parameters, each ramped rather than assigned. Returns the number of
   * parameter writes issued (zero when nothing differs), so callers can prove a change was minimal.
   */
  update(params: EffectParamValues, when: number): number;
  /** Ramp the effect in or out. Returns 1 when a ramp was issued, 0 when already in that state. */
  setEnabled(enabled: boolean, when: number): number;
  /** Disconnect and release every node this processor created, and cancel its pending timers. */
  dispose(): void;
}

/** The type-specific node group inside a processor. */
export interface EffectCore {
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** Apply the named parameters smoothly. Returns the number of writes issued. */
  update(params: EffectParamValues, changed: readonly string[], when: number): number;
  dispose(): void;
}

/** Time constant for ordinary parameter moves (about 60 ms to settle). */
export const EFFECT_PARAM_SMOOTH_SECONDS = 0.02;
/** Time constant for enabling or bypassing an effect (about 40 ms to settle). */
export const EFFECT_GATE_SMOOTH_SECONDS = 0.012;
/**
 * After a bypass ramp has finished, the processing path is disconnected so an idle effect costs no
 * CPU. Long enough that the ramp is fully settled first (about 15 time constants).
 */
export const EFFECT_DISCONNECT_DELAY_MS = 250;
/** Reverb impulse changes are coalesced: the new room is built after the value stops moving. */
export const REVERB_IR_DEBOUNCE_MS = 120;
/** Crossfade between the old and new convolver when the impulse is rebuilt. */
export const REVERB_CROSSFADE_SECONDS = 0.06;
/** How long a replaced convolver is kept alive while its tail fades out. */
export const REVERB_RETIRE_MS = 500;
