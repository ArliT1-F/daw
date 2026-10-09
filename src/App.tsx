import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { BrowserAudioEngine, type AudioEngineState } from './audio/AudioEngine';
import { SampleStore } from './audio/sampleStore';
import { ErrorNotice } from './components/ErrorNotice';
import { createAppError, type AppError, type ErrorSource } from './core/errors';
import { applyProjectCommand, createProjectHistory, projectHistoryReducer, type ProjectCommand } from './core/commands';
import { createInitialProject } from './core/project/model';
import { buildPlaylistEvents } from './core/events';
import {
  createTransportState,
  getTransportCycleSteps,
  transportReducer,
} from './core/transport';
import { BrowserPanel } from './features/browser/BrowserPanel';
import { ChannelRack, type ChannelSampleStatus } from './features/channel-rack/ChannelRack';
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

/** The visible arrangement region doubles as the playback loop: eight bars of 4/4. */
const DEFAULT_LOOP_STEPS = 128;

const PANEL_HOTKEYS: Record<string, string> = {
  '1': PANEL_IDS[0],
  '2': PANEL_IDS[1],
  '3': PANEL_IDS[2],
  '4': PANEL_IDS[3],
  '5': PANEL_IDS[4],
};

export function App() {
  const audioEngineRef = useRef<BrowserAudioEngine | null>(null);
  const sampleStoreRef = useRef<SampleStore | null>(null);
  if (!sampleStoreRef.current) {
    // Runtime asset store: decoded buffers live here, never in the project document.
    sampleStoreRef.current = new SampleStore((data) => {
      if (!audioEngineRef.current) throw new Error('The audio engine is not ready to decode samples.');
      return audioEngineRef.current.decodeAudioData(data);
    });
  }
  if (!audioEngineRef.current) {
    audioEngineRef.current = new BrowserAudioEngine({
      tempoBpm: 124,
      timeSignature: { numerator: 4, denominator: 4 },
      loop: { startStep: 0, endStep: DEFAULT_LOOP_STEPS },
      resolveSample: (sampleId) => sampleStoreRef.current?.get(sampleId) ?? null,
    });
  }
  const audioEngine = audioEngineRef.current;

  const [history, dispatchProject] = useReducer(
    projectHistoryReducer,
    undefined,
    () => createProjectHistory(createInitialProject()),
  );
  const [transport, dispatchTransport] = useReducer(transportReducer, undefined, createTransportState);
  const [audioBusy, setAudioBusy] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [appError, setAppError] = useState<AppError | null>(null);
  const [audioState, setAudioState] = useState<AudioEngineState>(() => audioEngine.getState());
  const [selectedChannelId, setSelectedChannelId] = useState('channel-bass');
  const [selectedPatternId, setSelectedPatternId] = useState(() => history.project.patterns[0]?.id ?? '');
  const [sampleStatus, setSampleStatus] = useState<Record<string, ChannelSampleStatus>>({});
  const [collapsed, setCollapsed] = useState<CollapsedPanels>({
    channelRack: false,
    pianoRoll: false,
    playlist: false,
    mixer: false,
    browser: false,
  });
  const project = history.project;
  const pattern = project.patterns.find((item) => item.id === selectedPatternId) ?? project.patterns[0];
  const activeChannelId = project.channels.some((channel) => channel.id === selectedChannelId)
    ? selectedChannelId
    : project.channels[0]?.id ?? '';

  useEffect(() => {
    if (selectedChannelId !== activeChannelId) setSelectedChannelId(activeChannelId);
  }, [activeChannelId, selectedChannelId]);

  // The event list is rebuilt only when the project changes; the scheduler consumes the exact
  // same list the UI uses to derive activity lights, so indicators match scheduled audio.
  const cycleSteps = getTransportCycleSteps(project.settings.timeSignature);
  const sequenceEvents = useMemo(
    () =>
      buildPlaylistEvents(project, {
        timeSignature: project.settings.timeSignature,
        endStep: cycleSteps,
      }),
    [project, cycleSteps],
  );

  // Channels with a scheduled event at each step of the displayed pattern (floor of the
  // possibly-swung step), keyed by step index within the pattern.
  const activityAtStep = useMemo(() => {
    const map = new Map<number, Set<string>>();
    for (const event of sequenceEvents) {
      if (event.patternId !== pattern.id) continue;
      const index = Math.floor(event.step) % Math.max(1, pattern.lengthSteps);
      const channels = map.get(index) ?? new Set<string>();
      channels.add(event.channelId);
      map.set(index, channels);
    }
    return map;
  }, [sequenceEvents, pattern.id, pattern.lengthSteps]);

  // Keep the engine in step with the project: tempo, signature, loop region, and musical events.
  useEffect(() => {
    audioEngine.setTempo(project.settings.tempo);
    audioEngine.setTimeSignature(project.settings.timeSignature);
    audioEngine.setLoop({ enabled: loopEnabled, startStep: 0, endStep: cycleSteps });
    audioEngine.setSequence(sequenceEvents);
  }, [audioEngine, loopEnabled, project.settings.tempo, project.settings.timeSignature, cycleSteps, sequenceEvents]);

  useEffect(
    () =>
      audioEngine.subscribe((state) => {
        setAudioState(state);
        // The engine can stop itself (for example at the end of a non-looping region).
        if (state.transportStatus === 'stopped') dispatchTransport({ type: 'stop' });
        const message = state.message;
        if (message) {
          setAppError((current) => (current?.message === message ? current : { source: 'audio', message }));
        }
      }),
    [audioEngine],
  );

  // The playhead follows the audio clock; rendering never decides when a sound happens.
  // When audio is unavailable no events are scheduled, so no playback indicator moves —
  // a moving playhead must never be disconnected from real scheduled events.
  useEffect(() => {
    if (transport.status !== 'playing' || audioState.status !== 'ready') return undefined;

    let frame = 0;
    let lastStep = -1;
    const draw = () => {
      const step = Math.floor(audioEngine.getPlayheadSteps());
      if (step !== lastStep) {
        lastStep = step;
        dispatchTransport({ type: 'position', positionStep: step, cycleSteps });
      }
      frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [audioEngine, audioState.status, cycleSteps, transport.status]);

  useEffect(() => () => {
    void audioEngine.dispose().catch((error: unknown) => {
      console.error('Could not close browser audio context', error);
    });
  }, [audioEngine]);

  function reportError(source: ErrorSource, error: unknown) {
    setAppError(createAppError(source, error));
  }

  /** Apply an edit; returns true only when the project actually changed. */
  function handleCommand(command: ProjectCommand): boolean {
    try {
      // Preflight outside the reducer so invalid user edits use the same visible error path as audio errors.
      const next = applyProjectCommand(project, command);
      const changed = next !== project;
      dispatchProject({ type: 'command', command });
      setAppError(null);
      return changed;
    } catch (error) {
      reportError('project', error);
      return false;
    }
  }

  async function handleLoadSample(channelId: string, file: File): Promise<void> {
    const displayName = file.name || 'sample';
    setSampleStatus((current) => ({ ...current, [channelId]: { status: 'loading', name: displayName } }));
    try {
      const sample = await sampleStoreRef.current!.add(file);
      const applied = handleCommand({
        type: 'channel.sample.assign',
        channelId,
        sampleId: sample.id,
        sampleName: sample.name,
      });
      if (!applied) throw new Error('The channel is no longer part of the project.');
      setSampleStatus((current) => ({ ...current, [channelId]: { status: 'ready', name: sample.name } }));
    } catch (error) {
      setSampleStatus((current) => ({
        ...current,
        [channelId]: { status: 'error', name: displayName, message: createAppError('application', error).message },
      }));
    }
  }

  function handleDismissSampleError(channelId: string) {
    setSampleStatus((current) => {
      if (current[channelId]?.status !== 'error') return current;
      const next = { ...current };
      delete next[channelId];
      return next;
    });
  }

  async function handlePreviewChannel(channelId: string): Promise<void> {
    const channel = project.channels.find((item) => item.id === channelId);
    if (!channel) return;
    try {
      // Loaded samples audition their buffer; unloaded channels fall back to the built-in voice.
      await audioEngine.auditionSample(channelId, channel.sampleId ?? channel.name);
      setAppError(null);
    } catch (error) {
      reportError('audio', error);
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

  async function handlePlayPause() {
    if (transport.status === 'playing') {
      audioEngine.pause();
      dispatchTransport({ type: 'pause' });
      return;
    }
    // Called straight from a click or key press, so the audio context may be created here.
    try {
      await audioEngine.play();
      setAppError(null);
    } catch (error) {
      reportError('audio', error);
    }
    // The visual transport keeps working even when audio is unavailable.
    dispatchTransport({ type: 'play' });
  }

  function handleStop() {
    audioEngine.stop();
    dispatchTransport({ type: 'stop' });
  }

  const handleSeek = useCallback(
    (step: number) => {
      audioEngine.seek(step);
      dispatchTransport({
        type: 'position',
        positionStep: step,
        cycleSteps: getTransportCycleSteps(project.settings.timeSignature),
      });
    },
    [audioEngine, project.settings.timeSignature],
  );

  function handleToggleLoop() {
    setLoopEnabled((current) => !current);
  }

  async function handleTestTone() {
    setAudioBusy(true);
    try {
      await audioEngine.auditionTestTone();
      setAppError(null);
    } catch (error) {
      reportError('audio', error);
    } finally {
      setAudioBusy(false);
    }
  }

  async function handleEnableAudio() {
    setAudioBusy(true);
    try {
      const status = await audioEngine.initialize();
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
        void handlePlayPause();
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
        audioState={audioState}
        cycleSteps={getTransportCycleSteps(project.settings.timeSignature)}
        history={history}
        loopEnabled={loopEnabled}
        onCommand={handleCommand}
        onEnableAudio={handleEnableAudio}
        onPlayPause={handlePlayPause}
        onRedo={handleRedo}
        onSeek={handleSeek}
        onStop={handleStop}
        onTestTone={handleTestTone}
        onToggleLoop={handleToggleLoop}
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
              <span>Pattern editing active · scheduled audio engine online</span>
            </div>
          </div>

          {appError && <ErrorNotice error={appError} onDismiss={() => setAppError(null)} />}

          <ChannelRack
            activityAtStep={activityAtStep}
            collapsed={collapsed.channelRack}
            onCommand={handleCommand}
            onDismissSampleError={handleDismissSampleError}
            onLoadSample={handleLoadSample}
            onPreviewChannel={handlePreviewChannel}
            onSelectPattern={setSelectedPatternId}
            onToggle={() => togglePanel('channelRack')}
            pattern={pattern}
            playbackActive={audioState.transportStatus === 'playing'}
            project={project}
            sampleStatus={sampleStatus}
            selectedPatternId={pattern.id}
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
