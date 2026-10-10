import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AudioEngineState } from '../../audio/AudioEngine';
import type { ProjectCommand, ProjectHistoryState } from '../../core/commands';
import type { Project } from '../../core/project/model';
import { formatTransportPosition, type TransportState } from '../../core/transport';
import { Icon } from '../../components/Icon';

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
}: TransportBarProps) {
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
        <div aria-label="Master level meter unavailable" className="master-placeholder" role="img" title="Master meter is not implemented">
          <span className="master-caption">MASTER</span>
          <div aria-hidden="true" className="master-meter"><i /><i /><i /><i /><i /><i /></div>
          <span className="master-state">METER OFF</span>
        </div>
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
