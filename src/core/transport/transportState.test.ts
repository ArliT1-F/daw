import { describe, expect, it } from 'vitest';
import { createTransportState, formatTransportPosition, getStepsPerBar, transportReducer } from './transportState';

describe('transport state', () => {
  it('starts, advances, pauses, and stops independently of project data', () => {
    let state = createTransportState();
    state = transportReducer(state, { type: 'play' });
    state = transportReducer(state, { type: 'tick', cycleSteps: 32 });
    state = transportReducer(state, { type: 'tick', cycleSteps: 32 });
    expect(state).toEqual({ status: 'playing', positionStep: 2 });

    state = transportReducer(state, { type: 'pause' });
    expect(state.positionStep).toBe(2);
    state = transportReducer(state, { type: 'stop' });
    expect(state).toEqual({ status: 'stopped', positionStep: 0 });
  });

  it('wraps at the requested cycle and formats bars using the active signature', () => {
    let state = transportReducer(createTransportState(), { type: 'play' });
    state = transportReducer(state, { type: 'tick', cycleSteps: 4 });
    state = transportReducer(state, { type: 'tick', cycleSteps: 4 });
    state = transportReducer(state, { type: 'tick', cycleSteps: 4 });
    state = transportReducer(state, { type: 'tick', cycleSteps: 4 });
    expect(state.positionStep).toBe(0);
    expect(getStepsPerBar({ numerator: 6, denominator: 8 })).toBe(12);
    expect(formatTransportPosition({ status: 'playing', positionStep: 16 }, { numerator: 4, denominator: 4 })).toBe('02 : 01 : 01');
  });
});
