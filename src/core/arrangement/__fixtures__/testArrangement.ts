import { applyProjectCommand, createEmptyChannel, createEmptyPattern } from '../../commands';
import { assertValidProject, createInitialProject, type Project } from '../../project/model';
import { TICKS_PER_STEP as T } from '../../time/ticks';

/** Three lanes, two instruments, phase-shifted shared patterns, an audio asset, and tempo automation. */
export function createTestArrangement(): Project {
  let project = createInitialProject();
  project = applyProjectCommand(project, { type: 'channel.add', channel: createEmptyChannel('channel-pad', 'Pad', '#7fa8d8') });
  project.settings.tempo = 120;
  project.settings.tempoChanges = [{ tick: 32 * T, bpm: 90 }, { tick: 48 * T, bpm: 150 }];
  project.settings.loop = { enabled: true, startTick: 24 * T, endTick: 56 * T };
  const main = project.patterns[0];
  for (const channel of project.channels) {
    main.steps[channel.id] = Array(16).fill(false);
    main.notes[channel.id] = [];
  }
  main.steps['channel-kick'][0] = true;
  main.steps['channel-kick'][8] = true;
  main.notes['channel-bass'] = [{ id: 'held-root', pitch: 60, startTick: 0, durationTicks: 16 * T, velocity: 0.7 }];
  main.notes['channel-pad'] = [{ id: 'held-fifth', pitch: 67, startTick: 4 * T, durationTicks: 12 * T, velocity: 0.5 }];
  const harmony = createEmptyPattern('pattern-harmony', 'Harmony', project.channels, 16);
  harmony.notes['channel-pad'] = [{ id: 'held-upper', pitch: 76, startTick: 0, durationTicks: 12 * T, velocity: 0.6 }];
  harmony.notes['channel-bass'] = [{ id: 'held-third', pitch: 64, startTick: 8 * T, durationTicks: 8 * T, velocity: 0.7 }];
  project.patterns.push(harmony);
  project.audioAssets = [{ id: 'asset-texture', name: 'Texture.wav', durationSeconds: 8, peaks: [0.1, 0.7, 0.3, 0.8] }];
  project.playlist = [
    { id: 'clip-a', kind: 'pattern', trackId: 'track-main', patternId: main.id, startTick: 16 * T, durationTicks: 48 * T, sourceOffsetTicks: 0 },
    { id: 'clip-b', kind: 'pattern', trackId: 'track-layer', patternId: main.id, startTick: 24 * T, durationTicks: 16 * T, sourceOffsetTicks: 0 },
    { id: 'clip-c', kind: 'pattern', trackId: 'track-audio', patternId: harmony.id, startTick: 40 * T, durationTicks: 24 * T, sourceOffsetTicks: 8 * T },
    { id: 'clip-audio', kind: 'audio', trackId: 'track-audio', assetId: 'asset-texture', startTick: 20 * T, durationTicks: 32 * T, sourceOffsetSeconds: 0.5, gain: 0.7 },
  ];
  assertValidProject(project);
  return project;
}
