import type { TimeSignature } from '../project/model';

export type TransportStatus = 'stopped' | 'playing';

export interface TransportState {
  status: TransportStatus;
  /** Absolute sixteenth-note step within the visible eight-bar loop. */
  positionStep: number;
}

export type TransportAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'tick'; cycleSteps?: number }
  /** Set an absolute position, e.g. from a seek or from the audio-clock playhead. */
  | { type: 'position'; positionStep: number; cycleSteps?: number };

export const DEFAULT_VISIBLE_BARS = 8;
export const STEPS_PER_QUARTER_NOTE = 4;

export function createTransportState(): TransportState {
  return { status: 'stopped', positionStep: 0 };
}

export function getStepsPerBar(timeSignature: TimeSignature): number {
  return timeSignature.numerator * (16 / timeSignature.denominator);
}

export function getTransportCycleSteps(timeSignature: TimeSignature): number {
  return getStepsPerBar(timeSignature) * DEFAULT_VISIBLE_BARS;
}

export function transportReducer(state: TransportState, action: TransportAction): TransportState {
  switch (action.type) {
    case 'play':
      return state.status === 'playing' ? state : { ...state, status: 'playing' };
    case 'pause':
      return state.status === 'stopped' ? state : { ...state, status: 'stopped' };
    case 'stop':
      return state.status === 'stopped' && state.positionStep === 0
        ? state
        : { status: 'stopped', positionStep: 0 };
    case 'tick':
      return state.status === 'stopped'
        ? state
        : { ...state, positionStep: (state.positionStep + 1) % Math.max(1, action.cycleSteps ?? 128) };
    case 'position': {
      const cycleSteps = Math.max(1, action.cycleSteps ?? 128);
      const wrapped = ((Math.floor(action.positionStep) % cycleSteps) + cycleSteps) % cycleSteps;
      return state.positionStep === wrapped ? state : { ...state, positionStep: wrapped };
    }
    default: {
      const exhaustiveCheck: never = action;
      return exhaustiveCheck;
    }
  }
}

export function formatTransportPosition(state: TransportState, timeSignature: TimeSignature): string {
  const stepsPerBar = getStepsPerBar(timeSignature);
  const stepsPerBeat = 16 / timeSignature.denominator;
  const bar = Math.floor(state.positionStep / stepsPerBar) + 1;
  const stepInBar = state.positionStep % stepsPerBar;
  const beat = Math.floor(stepInBar / stepsPerBeat) + 1;
  const subdivision = (stepInBar % stepsPerBeat) + 1;
  return `${String(bar).padStart(2, '0')} : ${String(beat).padStart(2, '0')} : ${String(subdivision).padStart(2, '0')}`;
}
