import { describe, expect, it } from 'vitest';
import { applyProjectCommand, type ProjectCommand } from '../commands';
import { createInitialProject, type Project } from '../project/model';
import { arrangementSignature } from './arrangement';
import { DEFAULT_SYNTH_PARAMS } from '../instruments/synthModel';

const DEFAULT_SYNTH_PARAMS_FOR_TEST = DEFAULT_SYNTH_PARAMS;

/**
 * The engine releases sounding voices and refills its lookahead whenever the arrangement signature
 * changes, so the signature must change exactly when generated events or their timing can change —
 * and must stay stable for every mixer edit, or a fader move would cut a held note.
 */

function starter(): Project {
  return createInitialProject();
}

function edit(project: Project, command: ProjectCommand): Project {
  return applyProjectCommand(project, command);
}

describe('arrangement signature', () => {
  it('changes when generated events or their timing can change', () => {
    const project = starter();
    const before = arrangementSignature(project);
    const changed: Array<[string, Project]> = [
      ['a step toggle', edit(project, { type: 'pattern.step.toggle', patternId: 'pattern-main', channelId: 'channel-kick', step: 2 })],
      ['a note edit', edit(project, { type: 'pattern.note.update', patternId: 'pattern-main', channelId: 'channel-bass', noteId: 'note-bass-1', changes: { pitch: 64 } })],
      ['tempo', edit(project, { type: 'project.tempo.set', tempo: 90 })],
      ['swing', edit(project, { type: 'project.swing.set', swing: 0.4 })],
      ['a tempo marker', edit(project, { type: 'project.tempo-changes.set', changes: [{ tick: 96, bpm: 140 }] })],
      ['the loop', edit(project, { type: 'playlist.loop.set', changes: { endTick: 2048 } })],
      ['a clip position', edit(project, { type: 'playlist.clips.edit', upserts: [{ ...project.playlist[0], startTick: 96 }] })],
      ['a channel mute', edit(project, { type: 'channel.mute.set', channelId: 'channel-kick', muted: true })],
      ['a channel solo', edit(project, { type: 'channel.solo.set', channelId: 'channel-kick', solo: true })],
      ['a track mute', edit(project, { type: 'playlist.track.mute.set', trackId: 'track-main', muted: true })],
      ['a new channel', edit(project, { type: 'channel.add', channel: { id: 'channel-new', name: 'New', kind: 'drum', color: '#123456', mixerChannelId: 'mixer-insert-1', muted: false, solo: false } })],
    ];
    for (const [label, next] of changed) {
      expect(arrangementSignature(next), label).not.toBe(before);
    }
  });

  it('stays stable for every mixer edit, so moving a fader never releases a sounding voice', () => {
    const project = starter();
    const before = arrangementSignature(project);
    const stable: Array<[string, Project]> = [
      ['mixer volume', edit(project, { type: 'mixer.channel.volume.set', channelId: 'mixer-insert-1', volumeDb: -6 })],
      ['mixer pan', edit(project, { type: 'mixer.channel.pan.set', channelId: 'mixer-insert-1', pan: 0.5 })],
      ['mixer mute', edit(project, { type: 'mixer.channel.mute.set', channelId: 'mixer-insert-1', muted: true })],
      ['mixer solo', edit(project, { type: 'mixer.channel.solo.set', channelId: 'mixer-insert-1', solo: true })],
      ['mixer route', edit(project, { type: 'mixer.channel.route', channelId: 'mixer-insert-1', outputId: 'mixer-insert-2' })],
      ['mixer reorder', edit(project, { type: 'mixer.channel.reorder', channelId: 'mixer-insert-1', toIndex: 3 })],
      ['mixer rename', edit(project, { type: 'mixer.channel.rename', channelId: 'mixer-insert-1', name: 'Thump' })],
      ['track assignment', edit(project, { type: 'mixer.source.assign', sourceId: 'audio:track-audio', mixerChannelId: 'mixer-insert-2' })],
      ['channel assignment', edit(project, { type: 'mixer.source.assign', sourceId: 'channel-kick', mixerChannelId: 'mixer-insert-3' })],
      ['effect slot', edit(project, { type: 'mixer.channel.effect.set', channelId: 'mixer-insert-1', slot: 0, effect: { id: 'fx', type: 'delay', enabled: true, params: { time: 0.3 } } })],
      ['channel rename', edit(project, { type: 'channel.rename', channelId: 'channel-kick', name: 'Thump' })],
      ['track rename', edit(project, { type: 'playlist.track.rename', trackId: 'track-main', name: 'Lead' })],
      ['clip rename', edit(project, { type: 'playlist.clips.edit', upserts: [{ ...project.playlist[0], name: 'Intro' }] })],
    ];
    for (const [label, next] of stable) {
      expect(arrangementSignature(next), label).toBe(before);
    }
  });
});

describe('arrangement signature and Phase 7 edits', () => {
  it('ignores synth parameter edits, so tweaking a patch never rebuilds the arrangement', () => {
    const project = starter();
    const before = arrangementSignature(project);
    const tweaked = edit(project, {
      type: 'channel.synth.set',
      channelId: 'channel-bass',
      synth: { version: 1, presetName: null, params: { ...DEFAULT_SYNTH_PARAMS_FOR_TEST, filterCutoffHz: 800, waveform: 'square' } },
    });
    expect(arrangementSignature(tweaked)).toBe(before);
  });

  it('ignores sample region and gain edits, which are read when a voice is built', () => {
    const project = edit(starter(), { type: 'audio.asset.add', asset: { id: 'asset-kick', name: 'Kick', durationSeconds: 1 } });
    const assigned = edit(project, { type: 'channel.sample.assign', channelId: 'channel-kick', sampleId: 'asset-kick', sampleName: 'Kick' });
    const before = arrangementSignature(assigned);
    const trimmed = edit(assigned, {
      type: 'channel.sample.trim.set',
      channelId: 'channel-kick',
      trim: { startSeconds: 0.1, endSeconds: 0.5, gain: 1.5 },
    });
    expect(arrangementSignature(trimmed)).toBe(before);
  });

  it('still changes when a sample is assigned, because the channel now references a different asset', () => {
    const project = edit(starter(), { type: 'audio.asset.add', asset: { id: 'asset-kick', name: 'Kick', durationSeconds: 1 } });
    const assigned = edit(project, { type: 'channel.sample.assign', channelId: 'channel-kick', sampleId: 'asset-kick', sampleName: 'Kick' });
    expect(arrangementSignature(assigned)).not.toBe(arrangementSignature(project));
  });
});

