import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AudioEngineState } from '../../audio/AudioEngine';
import type { ProjectCommand, ProjectHistoryState } from '../../core/commands';
import type { Project } from '../../core/project/model';
import { getMasterChannel } from '../../core/mixer/mixerModel';
import { formatTransportPosition, type TransportState } from '../../core/transport';
import { Icon } from '../../components/Icon';
import type { MeterElementKind, MeterViewRegistry } from '../mixer/meterView';

const METER_ELEMENT_KINDS: MeterElementKind[] = ['fill', 'peak', 'clip', 'readout'];

/**
 * The master bus's output meter, bound straight into the meter registry so it updates without a
 * React render. The fader itself lives in the Mixer panel's master strip.
 */
function MasterOutputMeter({
  channelId,
  muted,
  registry,
  onClearClip,
}: {
  channelId: string;
  muted: boolean;
  registry: MeterViewRegistry;
  onClearClip: (mixerChannelId: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewId = `transport-${channelId}`;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !channelId) return undefined;
    registry.register(viewId, channelId, 'horizontal');
    for (const kind of METER_ELEMENT_KINDS) {
      registry.setElement(viewId, kind, root.querySelector<HTMLElement>(`[data-meter="${kind}"]`));
    }
    return () => registry.unregister(viewId);
  }, [channelId, registry, viewId]);

  return (
    <div aria-label="Master output meter" className={`master-placeholder ${muted ? 'master-placeholder--muted' : ''}`} ref={rootRef} role="group">
      <span className="master-caption">{muted ? 'MASTER · MUTE' : 'MASTER'}</span>
      <div aria-hidden="true" className="master-meter">
        <i className="master-meter-fill" data-meter="fill" />
        <i className="master-meter-peak" data-meter="peak" />
      </div>
      <button
        aria-label="No clipping"
        className="master-clip"
        data-meter="clip"
        onClick={() => onClearClip(channelId)}
        title="Master clip indicator · click to reset"
        type="button"
      />
      <span className="master-state" data-meter="readout" title="Measured master output peak">
        -inf dB
      </span>
    </div>
  );
}

const TIME_SIGNATURE_OPTIONS = [
  { numerator: 2, denominator: 4 },
  { numerator: 3, denominator: 4 },
  { numerator: 4, denominator: 4 },
  { numerator: 5, denominator: 4 },
  { numerator: 6, denominator: 8 },
  { numerator: 7, denominator: 8 },
  { numerator: 12, denominator: 8 },
] as const;

interface TransportBarProps {
  project: Project;
  history: ProjectHistoryState;
  transport: TransportState;
  audioState: AudioEngineState;
  audioBusy: boolean;
  /** Length of the playback region in sixteenth-note steps. */
  cycleSteps: number;
  regionStartStep?: number;
  loopEnabled: boolean;
  onCommand: (command: ProjectCommand) => void;
  onPlayPause: () => void;
  onStop: () => void;
  onSeek: (step: number) => void;
  onToggleLoop: () => void;
  onTestTone: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onEnableAudio: () => void;
  /** Binds the transport's master output meter; the app polls the engine and writes into it. */
  meterRegistry: MeterViewRegistry;
  onClearMeterClip: (mixerChannelId: string) => void;
}

export function TransportBar({
  project,
  history,
  transport,
  audioState,
  audioBusy,
  cycleSteps,
  regionStartStep = 0,
  loopEnabled,
  onCommand,
  onPlayPause,
  onStop,
  onSeek,
  onToggleLoop,
  onTestTone,
  onUndo,
  onRedo,
  onEnableAudio,
  meterRegistry,
  onClearMeterClip,
}: TransportBarProps) {
  const master = getMasterChannel(project);
  const [tempoDraft, setTempoDraft] = useState(String(project.settings.tempo));

  useEffect(() => setTempoDraft(String(project.settings.tempo)), [project.settings.tempo]);

  function commitTempo() {
    const value = Number(tempoDraft);
    if (Number.isFinite(value) && value >= 20 && value <= 300) {
      onCommand({ type: 'project.tempo.set', tempo: Math.round(value) });
      setTempoDraft(String(Math.round(value)));
    } else {
      setTempoDraft(String(project.settings.tempo));
    }
  }

  function handleTempoKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      setTempoDraft(String(project.settings.tempo));
      event.currentTarget.blur();
    }
  }

  const timeSignature = project.settings.timeSignature;
  const selectedTimeSignature = `${timeSignature.numerator}/${timeSignature.denominator}`;
  const audioStatus = audioState.status;
  const audioLabel = audioStatus === 'ready'
    ? `Audio context ready · ${audioState.sampleRate ?? 0} Hz · ${Math.round(audioState.outputLatencySeconds * 1000)} ms out`
    : audioStatus === 'unsupported'
      ? 'Web Audio is unavailable in this browser'
      : audioStatus === 'suspended'
        ? 'Audio context is suspended · press Enable audio to resume'
        : audioStatus === 'closed'
          ? 'Audio context is closed'
          : audioStatus === 'error'
            ? (audioState.message ?? 'The audio engine reported an error')
            : 'Audio is off · playback will start on first play';

  return (
    <header className="topbar">
      <div className="brand-lockup" aria-label="Gridline Audio">
        <div className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></div>
        <div className="brand-copy">
          <span className="brand-name">GRIDLINE</span>
          <span className="brand-subtitle">AUDIO WORKSPACE</span>
        </div>
      </div>

      <div aria-label="Transport controls" className="transport-controls" role="group">
        <button
          aria-label={transport.status === 'playing' ? 'Pause' : 'Play'}
          className={`transport-play ${transport.status === 'playing' ? 'is-playing' : ''}`}
          onClick={onPlayPause}
          title={`${transport.status === 'playing' ? 'Pause' : 'Play'} · audio is scheduled on the audio clock`}
          type="button"
        >
          <Icon name={transport.status === 'playing' ? 'pause' : 'play'} size={18} />
        </button>
        <button aria-label="Stop transport and return to start" className="transport-stop icon-button" onClick={onStop} title="Stop · Space toggles play, Esc stops" type="button">
          <Icon name="stop" size={15} />
        </button>
        <button
          aria-label={loopEnabled ? 'Looping is on' : 'Looping is off'}
          aria-pressed={loopEnabled}
          className={`transport-loop ${loopEnabled ? 'is-active' : ''}`}
          onClick={onToggleLoop}
          title={loopEnabled ? 'Loop the selected song region' : 'Play the whole arrangement once, then stop'}
          type="button"
        >
          LOOP
        </button>
        <div aria-label={`Position ${formatTransportPosition(transport, timeSignature)}`} className="position-readout">
          <span className="position-label">BAR : BEAT : STEP</span>
          <span className="position-value">{formatTransportPosition(transport, timeSignature)}</span>
        </div>
        <label className="seek-control">
          <span className="sr-only-text">Seek within the region</span>
          <input
            aria-label="Seek within the region"
            max={cycleSteps - 1 / 24}
            min={regionStartStep}
            onChange={(event) => onSeek(Number(event.target.value))}
            step={1 / 24}
            type="range"
            value={Math.max(regionStartStep, Math.min(transport.positionStep, cycleSteps - 1 / 24))}
          />
        </label>
        <div className="transport-divider" />
        <label className="value-control tempo-control">
          <span className="value-label">BPM</span>
          <input
            aria-label="Tempo in beats per minute"
            max={300}
            min={20}
            onBlur={commitTempo}
            onChange={(event) => setTempoDraft(event.target.value)}
            onKeyDown={handleTempoKeyDown}
            step={1}
            type="number"
            value={tempoDraft}
          />
        </label>
        <label className="value-control signature-control">
          <span className="value-label">TIME</span>
          <select
            aria-label="Time signature"
            onChange={(event) => {
              const [numerator, denominator] = event.target.value.split('/').map(Number);
              onCommand({ type: 'project.time-signature.set', timeSignature: { numerator, denominator } });
            }}
            value={selectedTimeSignature}
          >
            {TIME_SIGNATURE_OPTIONS.map((signature) => {
              const key = `${signature.numerator}/${signature.denominator}`;
              return <option key={key} value={key}>{key}</option>;
            })}
          </select>
        </label>
      </div>

      <div className="topbar-tools">
        <MasterOutputMeter
          channelId={master?.id ?? ''}
          muted={Boolean(master?.muted)}
          onClearClip={onClearMeterClip}
          registry={meterRegistry}
        />
        <div className="tool-separator" />
        <button
          aria-label={audioLabel}
          className={`audio-enable ${audioStatus === 'ready' ? 'audio-enable--ready' : ''}`}
          disabled={audioBusy || audioStatus === 'ready'}
          onClick={onEnableAudio}
          title={audioLabel}
          type="button"
        >
          <Icon name="audio" size={15} />
          <span>{audioBusy ? 'Starting…' : audioStatus === 'ready' ? 'Context ready' : 'Enable audio'}</span>
          <span aria-hidden="true" className={`status-light status-light--${audioStatus}`} />
        </button>
        <div className="tool-separator" />
        <button
          aria-label="Play a test tone"
          className="icon-button test-tone-button"
          disabled={audioBusy}
          onClick={onTestTone}
          title="Play a test tone through the audio engine"
          type="button"
        >
          TEST
        </button>
        <button aria-label="Undo" className="icon-button history-button" disabled={history.past.length === 0} onClick={onUndo} title="Undo · Ctrl/Cmd+Z" type="button">
          <Icon name="undo" size={16} />
        </button>
        <button aria-label="Redo" className="icon-button history-button" disabled={history.future.length === 0} onClick={onRedo} title="Redo · Ctrl/Cmd+Shift+Z" type="button">
          <Icon name="redo" size={16} />
        </button>
        <div className="project-state"><span className="project-state-dot" />{project.name}</div>
      </div>
    </header>
  );
}
