import { useState } from 'react';
import type { ProjectCommand } from '../../core/commands';
import { SAMPLE_GAIN_MAX, type AudioAsset, type Channel, type SampleTrim } from '../../core/project/model';
import { SynthEditor } from '../instrument/SynthEditor';
import { formatDuration, formatGain, parseSeconds, describeAsset } from './sampleFormat';

interface ChannelInspectorProps {
  channel: Channel | null;
  assets: readonly AudioAsset[];
  isAssetLoaded: (assetId: string) => boolean;
  onCommand: (command: ProjectCommand, options?: { coalesceKey?: string }) => boolean;
  onPreviewChannel: (channelId: string) => void;
  onAuditionSynth: (channelId: string) => void;
  onError: (message: string) => void;
}

/** Smallest region the editor allows, so start and end never collapse onto each other. */
const MIN_REGION_SECONDS = 0.001;

export function ChannelInspector({ channel, assets, isAssetLoaded, onCommand, onPreviewChannel, onAuditionSynth, onError }: ChannelInspectorProps) {
  if (!channel) {
    return (
      <section aria-label="Channel inspector" className="inspector-section">
        <div className="browser-section-head">
          <span className="eyebrow">INSPECTOR</span>
        </div>
        <p className="library-empty">Select a channel in the Channel Rack to edit its sample or synth.</p>
      </section>
    );
  }

  const asset = channel.sampleId ? assets.find((item) => item.id === channel.sampleId) : undefined;
  const missing = Boolean(channel.sampleId) && !isAssetLoaded(channel.sampleId!);

  return (
    <section aria-label="Channel inspector" className="inspector-section">
      <div className="browser-section-head">
        <span className="eyebrow">INSPECTOR</span>
        <span className="browser-count">{channel.name} · {channel.kind === 'instrument' ? 'SYNTH' : 'DRUM'}</span>
      </div>

      <div className="inspector-block">
        <div className="inspector-subhead">
          <span>SAMPLE</span>
          {channel.sampleId ? (
            <button
              aria-label={`Clear sample from ${channel.name}`}
              className="button button--quiet"
              onClick={() => onCommand({ type: 'channel.sample.clear', channelId: channel.id })}
              type="button"
            >
              Clear
            </button>
          ) : null}
        </div>

        {!channel.sampleId ? (
          <p className="library-empty">No sample assigned. Pick one from the library, or drop an audio file on this channel's row.</p>
        ) : !asset ? (
          <p className="inspector-warning" role="alert">The sample "{channel.sampleName}" is not in the library.</p>
        ) : (
          <>
            <div className="inspector-sample-name" title={asset.name}>{asset.name}</div>
            <div className="inspector-meta">{describeAsset(asset)}</div>
            {missing ? (
              <p className="inspector-warning" role="alert">
                This sample is missing from the session. Import the same file to relink it; the region and gain are kept.
              </p>
            ) : (
              <SampleRegionEditor
                // Remount when the assigned asset changes so drafts never carry over.
                key={`${channel.id}:${asset.id}`}
                asset={asset}
                channel={channel}
                onCommand={onCommand}
                onError={onError}
              />
            )}
          </>
        )}

        <div className="inspector-actions">
          <button
            aria-label={`Audition ${channel.name} from inspector`}
            className="button button--quiet"
            disabled={missing}
            onClick={() => onPreviewChannel(channel.id)}
            title={missing ? 'The sample is missing' : `Play ${channel.name} once`}
            type="button"
          >
            Preview
          </button>
          {channel.sampleTrim ? (
            <button
              className="button button--quiet"
              onClick={() => onCommand({ type: 'channel.sample.trim.set', channelId: channel.id, trim: null })}
              type="button"
            >
              Reset region
            </button>
          ) : null}
        </div>
      </div>

      {channel.kind === 'instrument' ? (
        <div className="inspector-block">
          <div className="inspector-subhead"><span>SYNTH</span></div>
          <SynthEditor channel={channel} onAudition={onAuditionSynth} onCommand={onCommand} onError={onError} />
        </div>
      ) : null}
    </section>
  );
}

interface SampleRegionEditorProps {
  asset: AudioAsset;
  channel: Channel;
  onCommand: (command: ProjectCommand, options?: { coalesceKey?: string }) => boolean;
  onError: (message: string) => void;
}

function SampleRegionEditor({ asset, channel, onCommand, onError }: SampleRegionEditorProps) {
  const duration = asset.durationSeconds;
  const trim: SampleTrim = channel.sampleTrim ?? { startSeconds: 0, endSeconds: duration, gain: 1 };
  const [startDraft, setStartDraft] = useState<string | null>(null);
  const [endDraft, setEndDraft] = useState<string | null>(null);

  function writeTrim(next: SampleTrim, coalesceKey?: string) {
    onCommand({ type: 'channel.sample.trim.set', channelId: channel.id, trim: next }, { coalesceKey });
  }

  function commitStart() {
    if (startDraft === null) return;
    const value = parseSeconds(startDraft);
    setStartDraft(null);
    if (value === null) {
      onError('Start must be a number of seconds.');
      return;
    }
    const clamped = Math.min(Math.max(0, value), trim.endSeconds - MIN_REGION_SECONDS);
    writeTrim({ ...trim, startSeconds: clamped }, `trim-start:${channel.id}`);
  }

  function commitEnd() {
    if (endDraft === null) return;
    const value = parseSeconds(endDraft);
    setEndDraft(null);
    if (value === null) {
      onError('End must be a number of seconds.');
      return;
    }
    const clamped = Math.min(duration, Math.max(trim.startSeconds + MIN_REGION_SECONDS, value));
    writeTrim({ ...trim, endSeconds: clamped }, `trim-end:${channel.id}`);
  }

  const gainPercent = Math.round(trim.gain * 100);
  const regionLength = trim.endSeconds - trim.startSeconds;

  return (
    <div className="inspector-region">
      <div className="inspector-grid">
        <label className="inspector-field">
          <span>START (s)</span>
          <input
            aria-label="Sample start in seconds"
            inputMode="decimal"
            onBlur={commitStart}
            onChange={(event) => setStartDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') { setStartDraft(null); event.currentTarget.blur(); }
            }}
            value={startDraft ?? trim.startSeconds.toFixed(3)}
          />
        </label>
        <label className="inspector-field">
          <span>END (s)</span>
          <input
            aria-label="Sample end in seconds"
            inputMode="decimal"
            onBlur={commitEnd}
            onChange={(event) => setEndDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') { setEndDraft(null); event.currentTarget.blur(); }
            }}
            value={endDraft ?? trim.endSeconds.toFixed(3)}
          />
        </label>
      </div>
      <div className="inspector-meta">Region {formatDuration(regionLength)} of {formatDuration(duration)}</div>
      <label className="inspector-slider">
        <span>GAIN</span>
        <input
          aria-label="Sample gain percent"
          max={Math.round(SAMPLE_GAIN_MAX * 100)}
          min={0}
          onChange={(event) => writeTrim({ ...trim, gain: Number(event.target.value) / 100 }, `trim-gain:${channel.id}`)}
          step={1}
          type="range"
          value={gainPercent}
        />
        <output>{formatGain(trim.gain)}</output>
      </label>
    </div>
  );
}
