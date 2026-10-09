import { useEffect, useReducer, useRef, useState } from 'react';
import { BrowserAudioEngine, type AudioEngineStatus } from './audio/AudioEngine';
import { ErrorNotice } from './components/ErrorNotice';
import { createAppError, type AppError, type ErrorSource } from './core/errors';
import { applyProjectCommand, createProjectHistory, projectHistoryReducer, type ProjectCommand } from './core/commands';
import { createInitialProject } from './core/project/model';
import {
  createTransportState,
  getTransportCycleSteps,
  transportReducer,
} from './core/transport';
import { BrowserPanel } from './features/browser/BrowserPanel';
import { ChannelRack } from './features/channel-rack/ChannelRack';
import { Mixer } from './features/mixer/Mixer';
import { PianoRoll } from './features/piano-roll/PianoRoll';
import { Playlist } from './features/playlist/Playlist';
import { TransportBar } from './features/transport/TransportBar';

const PANEL_IDS = [
  'panel-channel-rack',
  'panel-piano-roll',
  'panel-playlist',
  'panel-mixer',
  'panel-browser',
] as const;

type PanelKey = 'channelRack' | 'pianoRoll' | 'playlist' | 'mixer' | 'browser';
type CollapsedPanels = Record<PanelKey, boolean>;

const PANEL_HOTKEYS: Record<string, string> = {
  '1': PANEL_IDS[0],
  '2': PANEL_IDS[1],
  '3': PANEL_IDS[2],
  '4': PANEL_IDS[3],
  '5': PANEL_IDS[4],
};

export function App() {
  const [history, dispatchProject] = useReducer(
    projectHistoryReducer,
    undefined,
    () => createProjectHistory(createInitialProject()),
  );
  const [transport, dispatchTransport] = useReducer(transportReducer, undefined, createTransportState);
  const [audioStatus, setAudioStatus] = useState<AudioEngineStatus>('idle');
  const [audioBusy, setAudioBusy] = useState(false);
  const [appError, setAppError] = useState<AppError | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState('channel-bass');
  const [collapsed, setCollapsed] = useState<CollapsedPanels>({
    channelRack: false,
    pianoRoll: false,
    playlist: false,
    mixer: false,
    browser: false,
  });
  const audioEngineRef = useRef<BrowserAudioEngine | null>(null);
  if (!audioEngineRef.current) audioEngineRef.current = new BrowserAudioEngine();
  const audioEngine = audioEngineRef.current;

  const project = history.project;
  const pattern = project.patterns[0];
  const activeChannelId = project.channels.some((channel) => channel.id === selectedChannelId)
    ? selectedChannelId
    : project.channels[0]?.id ?? '';

  useEffect(() => {
    if (selectedChannelId !== activeChannelId) setSelectedChannelId(activeChannelId);
  }, [activeChannelId, selectedChannelId]);

  useEffect(() => {
    if (transport.status !== 'playing') return undefined;
    const sixteenthNoteMs = 60_000 / (project.settings.tempo * 4);
    const cycleSteps = getTransportCycleSteps(project.settings.timeSignature);
    const timer = window.setInterval(() => {
      dispatchTransport({ type: 'tick', cycleSteps });
    }, sixteenthNoteMs);
    return () => window.clearInterval(timer);
  }, [project.settings.tempo, project.settings.timeSignature, transport.status]);

  useEffect(() => () => {
    void audioEngine.dispose().catch((error: unknown) => {
      console.error('Could not close browser audio context', error);
    });
  }, [audioEngine]);

  function reportError(source: ErrorSource, error: unknown) {
    setAppError(createAppError(source, error));
  }

  function handleCommand(command: ProjectCommand) {
    try {
      // Preflight outside the reducer so invalid user edits use the same visible error path as audio errors.
      applyProjectCommand(project, command);
      dispatchProject({ type: 'command', command });
      setAppError(null);
    } catch (error) {
      reportError('project', error);
    }
  }

  function handleUndo() {
    dispatchProject({ type: 'undo' });
    setAppError(null);
  }

  function handleRedo() {
    dispatchProject({ type: 'redo' });
    setAppError(null);
  }

  function handlePlayPause() {
    dispatchTransport({ type: transport.status === 'playing' ? 'pause' : 'play' });
  }

  function handleStop() {
    dispatchTransport({ type: 'stop' });
  }

  async function handleEnableAudio() {
    setAudioBusy(true);
    try {
      const status = await audioEngine.initialize();
      setAudioStatus(status);
      if (status === 'unsupported') {
        reportError('audio', new Error('This browser does not provide the Web Audio API.'));
      } else {
        setAppError(null);
      }
    } catch (error) {
      reportError('audio', error);
    } finally {
      setAudioBusy(false);
    }
  }

  function togglePanel(panel: PanelKey) {
    setCollapsed((current) => ({ ...current, [panel]: !current[panel] }));
  }

  useEffect(() => {
    function onGlobalKeyDown(event: KeyboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const isTextEntry = Boolean(target?.isContentEditable || target?.matches('input, textarea, select'));
      if (isTextEntry || event.repeat) return;

      const commandKey = event.metaKey || event.ctrlKey;
      if (commandKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if (commandKey && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        handleRedo();
        return;
      }

      if (event.altKey && !commandKey && PANEL_HOTKEYS[event.key]) {
        event.preventDefault();
        document.getElementById(PANEL_HOTKEYS[event.key])?.focus();
        return;
      }

      const isInteractive = Boolean(target?.closest('button, a, [role="button"]'));
      if (event.code === 'Space' && !isInteractive) {
        event.preventDefault();
        handlePlayPause();
      } else if (event.key === 'Escape') {
        handleStop();
      }
    }

    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [history.future.length, history.past.length, transport.status]);

  const studioClasses = [
    'studio',
    collapsed.channelRack && 'studio--rack-collapsed',
    collapsed.pianoRoll && collapsed.playlist && 'studio--middle-collapsed',
    collapsed.mixer && 'studio--mixer-collapsed',
  ].filter(Boolean).join(' ');

  return (
    <div className="app-shell">
      <TransportBar
        audioBusy={audioBusy}
        audioStatus={audioStatus}
        history={history}
        onCommand={handleCommand}
        onEnableAudio={handleEnableAudio}
        onPlayPause={handlePlayPause}
        onRedo={handleRedo}
        onStop={handleStop}
        onUndo={handleUndo}
        project={project}
        transport={transport}
      />
      <div className={`workspace ${collapsed.browser ? 'workspace--browser-collapsed' : ''}`}>
        <BrowserPanel collapsed={collapsed.browser} onToggle={() => togglePanel('browser')} />
        <main className={studioClasses}>
          <div className="studio-statusbar">
            <div className="session-label">
              <span className="session-icon" aria-hidden="true">▦</span>
              <span className="session-name">{project.name}</span>
              <span className="session-separator">/</span>
              <span className="session-pattern">{pattern.name}</span>
            </div>
            <div className="foundation-notice">
              <span className="foundation-dot" />
              <span>Pattern editing active · audio playback not implemented</span>
            </div>
          </div>

          {appError && <ErrorNotice error={appError} onDismiss={() => setAppError(null)} />}

          <ChannelRack
            collapsed={collapsed.channelRack}
            onCommand={handleCommand}
            onToggle={() => togglePanel('channelRack')}
            pattern={pattern}
            project={project}
            transport={transport}
          />
          <div className="middle-panels">
            <PianoRoll
              collapsed={collapsed.pianoRoll}
              onCommand={handleCommand}
              onSelectChannel={setSelectedChannelId}
              onToggle={() => togglePanel('pianoRoll')}
              pattern={pattern}
              project={project}
              selectedChannelId={activeChannelId}
              transport={transport}
            />
            <Playlist
              collapsed={collapsed.playlist}
              onCommand={handleCommand}
              onToggle={() => togglePanel('playlist')}
              pattern={pattern}
              project={project}
              transport={transport}
            />
          </div>
          <Mixer collapsed={collapsed.mixer} onToggle={() => togglePanel('mixer')} project={project} />
          <footer className="studio-footer">
            <span>LOCAL SESSION · DATA REMAINS IN MEMORY</span>
            <span className="shortcut-guide">Space play/pause&nbsp; · &nbsp;Esc stop&nbsp; · &nbsp;Ctrl/Cmd+Z undo&nbsp; · &nbsp;Alt+1–5 focus panels</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
