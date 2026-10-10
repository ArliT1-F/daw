import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { BrowserAudioEngine, type AudioEngineState } from './audio/AudioEngine';
import { SampleStore, buildWaveformPeaks, type LoadedSample, type SampleFile } from './audio/sampleStore';
import { loadSamplePack, parseSamplePackManifest, sha256Hex, type SamplePackManifest } from './audio/samplePack';
import { ErrorNotice } from './components/ErrorNotice';
import { createAppError, type AppError, type ErrorSource } from './core/errors';
import { applyProjectCommand, createProjectHistory, projectHistoryReducer, type ProjectCommand } from './core/commands';
import { createInitialProject, createStableId, type AudioAsset } from './core/project/model';
import { buildMixerState, mixerStateSignature } from './core/mixer/mixerModel';
import { ArrangementEventSource, buildPatternEvents } from './core/events';
import { arrangementSignature, audioDurationTicks, getPlaybackRegion, getProjectTempoMap, getSongEndTick, patternStepAtSongPosition, songStepForPatternTick } from './core/arrangement/arrangement';
import { TICKS_PER_STEP, ticksToSteps } from './core/time/ticks';
import {
  createTransportState,
  transportReducer,
} from './core/transport';
import { BrowserPanel } from './features/browser/BrowserPanel';
import type { LibraryNotice } from './features/browser/SampleLibrary';
import { ChannelRack, type ChannelSampleStatus } from './features/channel-rack/ChannelRack';
import { MeterViewRegistry } from './features/mixer/meterView';
import { Mixer } from './features/mixer/Mixer';
import { useMixerMeters } from './features/mixer/useMixerMeters';
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

/** Initial engine range; the serializable project loop is applied before the first gesture. */
const DEFAULT_LOOP_STEPS = 128;

const PANEL_HOTKEYS: Record<string, string> = {
  '1': PANEL_IDS[0],
  '2': PANEL_IDS[1],
  '3': PANEL_IDS[2],
  '4': PANEL_IDS[3],
  '5': PANEL_IDS[4],
};

/** Public folder of the bundled 808 starter kit (manifest, WAVs, and license). */
const STARTER_PACK_DIR = 'samples/808/';

/** Middle C: the pitch used when auditioning a synth patch from the inspector. */
const SYNTH_AUDITION_PITCH = 60;

interface ImportedSample {
  sample: LoadedSample;
  /** True when identical bytes were already decoded, so no new buffer was created. */
  reused: boolean;
  /** True when a missing project asset was matched by content hash and brought back. */
  relinked: boolean;
  /** True when this import added a new library entry. */
  added: boolean;
}

function assetFromSample(sample: LoadedSample): AudioAsset {
  return {
    id: sample.id,
    name: sample.name,
    durationSeconds: sample.durationSeconds,
    peaks: buildWaveformPeaks(sample.buffer),
    contentHash: sample.contentHash,
    format: sample.format,
    bytes: sample.bytes,
    sampleRate: sample.sampleRate || undefined,
    channels: sample.channels || undefined,
  };
}

function describeImport(result: ImportedSample): string {
  const name = result.sample.name;
  if (result.relinked) return `Relinked "${name}" to its missing library entry.`;
  if (result.reused) return `"${name}" is already in the library; its decoded audio was reused.`;
  return `Added "${name}".`;
}

function hasSubtleCrypto(): boolean {
  return typeof crypto !== 'undefined' && Boolean(crypto.subtle);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
  return response.text();
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

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
  const meterRegistryRef = useRef<MeterViewRegistry | null>(null);
  if (!meterRegistryRef.current) {
    // Meter views bind their DOM nodes here; the poll loop writes levels without a React render.
    meterRegistryRef.current = new MeterViewRegistry();
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
  const meterRegistry = meterRegistryRef.current;

  const [history, dispatchProject] = useReducer(
    projectHistoryReducer,
    undefined,
    () => createProjectHistory(createInitialProject()),
  );
  const [transport, dispatchTransport] = useReducer(transportReducer, undefined, createTransportState);
  const [audioBusy, setAudioBusy] = useState(false);
  const [appError, setAppError] = useState<AppError | null>(null);
  const [audioState, setAudioState] = useState<AudioEngineState>(() => audioEngine.getState());
  const [selectedChannelId, setSelectedChannelId] = useState('channel-bass');
  const [selectedPatternId, setSelectedPatternId] = useState(() => history.project.patterns[0]?.id ?? '');
  const [selectedClipId, setSelectedClipId] = useState<string | undefined>();
  const [sampleStatus, setSampleStatus] = useState<Record<string, ChannelSampleStatus>>({});
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryNotice, setLibraryNotice] = useState<LibraryNotice | null>(null);
  const [collapsed, setCollapsed] = useState<CollapsedPanels>({
    channelRack: false,
    pianoRoll: false,
    playlist: false,
    mixer: false,
    browser: false,
  });
  const project = history.project;
  const projectRef = useRef(project);
  projectRef.current = project;
  const loopEnabled = project.settings.loop.enabled;
  const pattern = project.patterns.find((item) => item.id === selectedPatternId) ?? project.patterns[0];
  const activeChannelId = project.channels.some((channel) => channel.id === selectedChannelId)
    ? selectedChannelId
    : project.channels[0]?.id ?? '';

  useEffect(() => {
    if (selectedChannelId !== activeChannelId) setSelectedChannelId(activeChannelId);
  }, [activeChannelId, selectedChannelId]);

  const cycleSteps = ticksToSteps(getSongEndTick(project));
  /**
   * The arrangement and the mixer are synced to the engine independently. A mixer edit must not
   * rebuild the event source, because that path releases sounding voices and refills the lookahead;
   * conversely an arrangement edit must not be blocked by mixer state. Both signatures exclude
   * everything the other one owns.
   */
  const arrangementKey = useMemo(() => arrangementSignature(project), [project]);
  const mixerKey = useMemo(() => mixerStateSignature(project), [project]);
  const eventSource = useMemo(() => new ArrangementEventSource(project), [arrangementKey]);
  const arrangementSettings = useMemo(
    () => ({
      tempoMap: getProjectTempoMap(project),
      timeSignature: project.settings.timeSignature,
      loop: getPlaybackRegion(project),
    }),
    [arrangementKey],
  );
  const mixerState = useMemo(() => buildMixerState(project), [mixerKey]);
  const patternPosition = patternStepAtSongPosition(project, pattern.id, transport.positionStep, selectedClipId);
  const patternTransport = { ...transport, positionStep: patternPosition ?? 0 };
  const patternPlaybackActive = audioState.transportStatus === 'playing' && patternPosition !== null;
  const activityAtStep = useMemo(() => {
    const map = new Map<number, Set<string>>();
    for (const event of buildPatternEvents(project, pattern)) {
      const index = Math.floor(event.step);
      const channels = map.get(index) ?? new Set<string>();
      channels.add(event.channelId);
      map.set(index, channels);
    }
    return map;
  }, [project, pattern]);

  // One atomic reconfiguration and one window refill, never an entire-song event expansion.
  useEffect(() => {
    audioEngine.setArrangement(eventSource, arrangementSettings);
  }, [audioEngine, eventSource, arrangementSettings]);

  // Mixer settings are diffed inside the graph, so a fader move touches one AudioParam and never
  // rebuilds the graph, restarts the scheduler, or cuts a sounding voice.
  // Channel synth and sample settings reach the voice builder through this registry, not arrangement events.
  useEffect(() => {
    audioEngine.setChannelVoices(project.channels);
  }, [audioEngine, project.channels]);

  useEffect(() => {
    audioEngine.setMixerState(mixerState);
  }, [audioEngine, mixerState]);

  // Level meters poll at a bounded rate and write straight into the bound DOM nodes.
  useMixerMeters(audioEngine, meterRegistry, audioState.status === 'ready');

  useEffect(() => audioEngine.subscribe((state) => {
    setAudioState(state);
    dispatchTransport({ type: 'sync', status: state.transportStatus === 'playing' ? 'playing' : 'stopped', positionStep: state.positionSteps });
    if (state.message) {
      setAppError((current) => current?.message === state.message ? current : { source: 'audio', message: state.message! });
    }
  }), [audioEngine]);

  // Rendering only reads the audio clock. Absolute song positions do not wrap at eight bars.

  useEffect(() => {
    if (transport.status !== 'playing' || audioState.status !== 'ready') return undefined;

    let frame = 0;
    let lastStep = -1;
    const draw = () => {
      const step = Math.floor(audioEngine.getPlayheadSteps());
      if (step !== lastStep) {
        lastStep = step;
        dispatchTransport({ type: 'position', positionStep: step });
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

  /**
   * Apply an edit; returns true only when the project actually changed.
   *
   * `coalesceKey` lets a continuous gesture (a fader or pan drag) emit many commands while staying
   * a single undo entry.
   */
  function handleCommand(command: ProjectCommand, options?: { coalesceKey?: string }): boolean {
    try {
      const changed = commitCommand(command, options);
      setAppError(null);
      return changed;
    } catch (error) {
      reportError('project', error);
      return false;
    }
  }

  /** Preflight and apply an edit; throws on invalid input so callers choose how to report it. */
  function commitCommand(command: ProjectCommand, options?: { coalesceKey?: string }): boolean {
    // Preflight outside the reducer so invalid user edits use the same visible error path as audio errors.
    const current = projectRef.current;
    const next = applyProjectCommand(current, command);
    const changed = next !== current;
    projectRef.current = next;
    dispatchProject({ type: 'command', command, coalesceKey: options?.coalesceKey });
    return changed;
  }

  const handleClearMeterClip = useCallback((mixerChannelId: string) => {
    audioEngine.clearMeterClip(mixerChannelId);
  }, [audioEngine]);

  /**
   * The single import path for every sample source (Channel Rack drop, library, starter pack, and
   * Playlist audio). Identical bytes reuse the decoded buffer; a missing project asset with the same
   * hash is relinked instead of duplicated.
   */
  async function importAudioFile(file: SampleFile, options: { channelId?: string } = {}): Promise<ImportedSample> {
    const store = sampleStoreRef.current!;
    const { sample, reused } = await store.import(file, {
      assetIdForHash: (hash) => projectRef.current.audioAssets.find((asset) => asset.contentHash === hash)?.id,
    });
    const existing = projectRef.current.audioAssets.find((asset) => asset.id === sample.id);
    const relinked = !reused && Boolean(projectRef.current.audioAssets.find((asset) => asset.contentHash === sample.contentHash));
    const commands: ProjectCommand[] = [];
    if (!existing) commands.push({ type: 'audio.asset.add', asset: assetFromSample(sample) });
    if (options.channelId) commands.push({ type: 'channel.sample.assign', channelId: options.channelId, sampleId: sample.id, sampleName: sample.name });
    if (commands.length > 0) {
      commitCommand(commands.length === 1 ? commands[0] : { type: 'project.batch', commands });
    }
    return { sample, reused, relinked, added: !existing };
  }

  async function handleLoadSample(channelId: string, file: File): Promise<void> {
    const displayName = file.name || 'sample';
    setSampleStatus((current) => ({ ...current, [channelId]: { status: 'loading', name: displayName } }));
    try {
      const { sample } = await importAudioFile(file, { channelId });
      setSampleStatus((current) => ({ ...current, [channelId]: { status: 'ready', name: sample.name } }));
    } catch (error) {
      setSampleStatus((current) => ({
        ...current,
        [channelId]: { status: 'error', name: displayName, message: createAppError('application', error).message },
      }));
    }
  }

  async function handleImportFiles(files: File[]): Promise<void> {
    setLibraryBusy(true);
    const messages: string[] = [];
    const errors: string[] = [];
    try {
      for (const file of files) {
        try {
          const result = await importAudioFile(file);
          messages.push(describeImport(result));
        } catch (error) {
          errors.push(`${file.name || 'File'}: ${createAppError('application', error).message}`);
        }
      }
    } finally {
      setLibraryBusy(false);
    }
    setLibraryNotice(errors.length > 0
      ? { tone: 'error', message: [...messages, ...errors].join(' ') }
      : { tone: 'info', message: messages.join(' ') || 'No files were selected.' });
  }

  async function handleLoadStarterPack(): Promise<void> {
    setLibraryBusy(true);
    try {
      // The pack is self-contained: its manifest and every file it lists sit in one folder.
      const baseUrl = `${import.meta.env.BASE_URL}${STARTER_PACK_DIR}`;
      const manifest: SamplePackManifest = parseSamplePackManifest(await fetchText(`${baseUrl}manifest.json`));
      const loaded = await loadSamplePack({
        baseUrl,
        manifest,
        fetchBytes: fetchArrayBuffer,
        importFile: async (file) => (await importAudioFile(file)).sample,
        // Without SubtleCrypto (insecure origins) the checksum step is skipped, and the pack is still decoded and named.
        hash: hasSubtleCrypto() ? sha256Hex : null,
      });
      setLibraryNotice({ tone: 'info', message: `Starter kit ready: ${loaded.length} CC0 samples in the library (${manifest.license.name}).` });
    } catch (error) {
      setLibraryNotice({ tone: 'error', message: `Starter kit not loaded. ${createAppError('application', error).message}` });
    } finally {
      setLibraryBusy(false);
    }
  }

  async function handlePreviewAsset(assetId: string): Promise<void> {
    try {
      await audioEngine.auditionAsset(assetId);
      setAppError(null);
    } catch (error) {
      reportError('audio', error);
    }
  }

  function handleAssignAsset(channelId: string, assetId: string): void {
    const asset = projectRef.current.audioAssets.find((item) => item.id === assetId);
    if (!asset) {
      reportError('project', new Error('That sample is not in the library.'));
      return;
    }
    if (!sampleStoreRef.current!.has(assetId)) {
      reportError('application', new Error(`${asset.name} is missing from this session. Import the same file to relink it.`));
      return;
    }
    handleCommand({ type: 'channel.sample.assign', channelId, sampleId: asset.id, sampleName: asset.name });
  }

  async function handleAuditionSynth(channelId: string): Promise<void> {
    try {
      await audioEngine.auditionNote(channelId, SYNTH_AUDITION_PITCH, 0.8, 0.5);
      setAppError(null);
    } catch (error) {
      reportError('audio', error);
    }
  }

  async function handleLoadPlaylistAudio(file: File, trackId: string, startTick: number): Promise<string | null> {
    try {
      const { sample } = await importAudioFile(file);
      const clipId = createStableId('clip');
      const current = projectRef.current;
      const applied = handleCommand({ type: 'playlist.clip.add', clip: { id: clipId, kind: 'audio', trackId, assetId: sample.id, startTick, durationTicks: audioDurationTicks(current, startTick, sample.durationSeconds), sourceOffsetSeconds: 0, gain: 1 } });
      return applied ? clipId : null;
    } catch (error) {
      reportError('application', error);
      return null;
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
    if (audioEngine.isPlaying) dispatchTransport({ type: 'play' });
  }

  function handleStop() {
    audioEngine.stop();
    dispatchTransport({ type: 'stop', positionStep: audioEngine.getPositionSteps() });
  }

  const handleSeek = useCallback(
    (step: number) => {
      const region = getPlaybackRegion(projectRef.current);
      const target = region.enabled && step >= region.endStep ? region.startStep : Math.max(region.startStep, Math.min(region.endStep - 1 / TICKS_PER_STEP, step));
      audioEngine.seek(target);
      dispatchTransport({ type: 'position', positionStep: audioEngine.getPositionSteps() });
    },
    [audioEngine],
  );

  function handleToggleLoop() {
    handleCommand({ type: 'playlist.loop.set', changes: { enabled: !projectRef.current.settings.loop.enabled } });
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
        cycleSteps={getPlaybackRegion(project).endStep}
        regionStartStep={getPlaybackRegion(project).startStep}
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
        meterRegistry={meterRegistry}
        onClearMeterClip={handleClearMeterClip}
        project={project}
        transport={transport}
      />
      <div className={`workspace ${collapsed.browser ? 'workspace--browser-collapsed' : ''}`}>
        <BrowserPanel
          activeChannel={project.channels.find((channel) => channel.id === activeChannelId) ?? null}
          busy={libraryBusy}
          collapsed={collapsed.browser}
          isAssetLoaded={(assetId) => sampleStoreRef.current!.has(assetId)}
          notice={libraryNotice}
          onAssignAsset={handleAssignAsset}
          onAuditionSynth={(channelId) => void handleAuditionSynth(channelId)}
          onCommand={handleCommand}
          onDismissNotice={() => setLibraryNotice(null)}
          onError={(message) => reportError('application', new Error(message))}
          onImportFiles={(files) => void handleImportFiles(files)}
          onLoadStarterPack={() => void handleLoadStarterPack()}
          onPreviewAsset={(assetId) => void handlePreviewAsset(assetId)}
          onPreviewChannel={(channelId) => void handlePreviewChannel(channelId)}
          onToggle={() => togglePanel('browser')}
          project={project}
        />
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
            onSelectChannel={setSelectedChannelId}
            onSelectPattern={setSelectedPatternId}
            selectedChannelId={activeChannelId}
            isAssetLoaded={(assetId) => sampleStoreRef.current!.has(assetId)}
            onAssignAsset={handleAssignAsset}
            onToggle={() => togglePanel('channelRack')}
            pattern={pattern}
            playbackActive={patternPlaybackActive}
            project={project}
            sampleStatus={sampleStatus}
            selectedPatternId={pattern.id}
            transport={patternTransport}
          />
          <div className="middle-panels">
            <PianoRoll
              collapsed={collapsed.pianoRoll}
              getPlayheadSteps={() => patternStepAtSongPosition(project, pattern.id, audioEngine.getPlayheadSteps(), selectedClipId) ?? 0}
              onCommand={handleCommand}
              onPreviewNote={(pitch, velocity) => {
                const current = project.channels.find((item) => item.id === activeChannelId);
                if (!current || current.kind !== 'instrument') return;
                void audioEngine.auditionNote(activeChannelId, pitch, velocity).catch((error: unknown) => {
                  reportError('audio', error);
                });
              }}
              onSeek={(step) => handleSeek(songStepForPatternTick(project, pattern.id, step * TICKS_PER_STEP, audioEngine.getPlayheadSteps(), selectedClipId))}
              onSelectChannel={setSelectedChannelId}
              onToggle={() => togglePanel('pianoRoll')}
              pattern={pattern}
              playbackActive={patternPlaybackActive}
              project={project}
              selectedChannelId={activeChannelId}
              transport={patternTransport}
            />
            <Playlist
              collapsed={collapsed.playlist}
              onCommand={handleCommand}
              onToggle={() => togglePanel('playlist')}
              onSeek={handleSeek}
              onSelectPattern={setSelectedPatternId}
              onSelectClip={setSelectedClipId}
              onEditPattern={(patternId, clipId) => {
                setSelectedPatternId(patternId);
                setSelectedClipId(clipId);
                setCollapsed((current) => ({ ...current, pianoRoll: false, channelRack: false }));
                document.getElementById('panel-piano-roll')?.focus();
              }}
              onLoadAudio={handleLoadPlaylistAudio}
              isAudioAssetLoaded={(assetId) => sampleStoreRef.current!.has(assetId)}
              playbackActive={audioState.transportStatus === 'playing'}
              getPlayheadSteps={() => audioEngine.getPlayheadSteps()}
              pattern={pattern}
              project={project}
              transport={transport}
            />
          </div>
          <Mixer
            collapsed={collapsed.mixer}
            meterRegistry={meterRegistry}
            onClearClip={handleClearMeterClip}
            onCommand={handleCommand}
            onToggle={() => togglePanel('mixer')}
            project={project}
          />
          <footer className="studio-footer">
            <span>LOCAL SESSION · DATA REMAINS IN MEMORY</span>
            <span className="shortcut-guide">Space play/pause&nbsp; · &nbsp;Esc stop&nbsp; · &nbsp;Ctrl/Cmd+Z undo&nbsp; · &nbsp;Alt+1–5 focus panels</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
