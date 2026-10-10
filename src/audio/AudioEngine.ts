import type { LoopRange, TransportClockStatus } from '../core/transport/transportClock';
import { TransportClock } from '../core/transport/transportClock';
import type { TimeSignature } from '../core/project/model';
import type { TempoMap } from '../core/time/musicalTime';
import type { MusicalEvent, MusicalEventSink, MusicalEventSource, ScheduledEventTiming } from '../core/events/musicalEvents';
import { sampleOnsetKey } from '../core/events/musicalEvents';
import { AudioGraph, type MixerGraphStats } from './AudioGraph';
import type { MixerState } from '../core/mixer/mixerModel';
import type { MeterReading } from './metering';
import { Scheduler, type SchedulerDiagnostics, type AudioContinuation } from './scheduler';
import { VoicePool, type ChannelVoiceSettings } from './voices';
import type { Channel } from '../core/project/model';
import { createBestAvailableTimer, type RepeatingTimer } from './timer';

/**
 * Browser audio engine: the single owner of the AudioContext, the audio graph, the transport
 * clock, and the scheduler.
 *
 * Lifecycle
 *  - Nothing is created until a user gesture calls `initialize()` or `play()` (autoplay policy).
 *  - `play` / `pause` / `stop` / `restart` / `seek` have fixed semantics (see below).
 *  - Sound timing always comes from `AudioContext.currentTime`; the lookahead timer only decides
 *    how far ahead to queue events.
 *
 * Transport semantics
 *  - start/resume: playback begins at the parked position with a small scheduling offset so the
 *    first event is never queued in the past.
 *  - pause: freezes the musical position and releases every sounding voice (no hanging notes).
 *  - stop: releases all voices, parks at the region start, resets the loop iteration.
 *  - restart: stop followed by start from the region start.
 *  - seek: moves the playhead, re-cursors the scheduler, and releases sounding voices. While
 *    playing, playback continues from the new position.
 *  - loop: when enabled the region wraps; when disabled playback stops at the region end.
 */

export type AudioEngineStatus = 'idle' | 'ready' | 'suspended' | 'unsupported' | 'closed' | 'error';

export type AudioErrorReason =
  | 'unsupported'
  | 'autoplay-blocked'
  | 'device-unavailable'
  | 'context-closed'
  | 'scheduling-failed'
  | 'unknown';

export class AudioEngineError extends Error {
  readonly reason: AudioErrorReason;

  constructor(message: string, reason: AudioErrorReason, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AudioEngineError';
    this.reason = reason;
  }
}

export interface AudioEngineState {
  status: AudioEngineStatus;
  transportStatus: TransportClockStatus;
  positionSteps: number;
  iteration: number;
  message: string | null;
  reason: AudioErrorReason | null;
  sampleRate: number | null;
  /** Reported output latency in seconds, used to align the visual playhead. */
  outputLatencySeconds: number;
  diagnostics: SchedulerDiagnostics | null;
}

/** Lifecycle contract implemented by the browser engine. */
export interface AudioEngine {
  readonly status: AudioEngineStatus;
  initialize(): Promise<AudioEngineStatus>;
  suspend(): Promise<void>;
  resume(): Promise<AudioEngineStatus>;
  dispose(): Promise<void>;
}

export interface BrowserAudioEngineOptions {
  /** Overridable for tests; must only be called from a user gesture in the browser. */
  createContext?: () => AudioContext;
  lookaheadSeconds?: number;
  intervalMs?: number;
  masterGain?: number;
  timer?: RepeatingTimer;
  /** Scheduling headroom applied when playback starts. */
  startDelaySeconds?: number;
  tempoBpm?: number;
  timeSignature?: TimeSignature;
  loop?: Partial<LoopRange>;
  /** Runtime lookup for decoded sample assets; never part of the project document. */
  resolveSample?: (sampleId: string) => AudioBuffer | null;
}

const UNSUPPORTED_MESSAGE =
  'This browser does not provide the Web Audio API, so playback is unavailable. Try a current version of Chrome, Edge, Firefox, or Safari.';
const AUTOPLAY_MESSAGE =
  'The browser blocked audio playback. Press play or Enable audio again to start sound.';
const DEVICE_MESSAGE =
  'The audio output device is unavailable. Check your system sound settings, then enable audio again.';
const CLOSED_MESSAGE = 'The audio context was closed. Enable audio again to continue.';
const SCHEDULING_MESSAGE = 'Audio playback stopped because a sound could not be created.';

export class BrowserAudioEngine implements AudioEngine, MusicalEventSink {
  private context: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private pool: VoicePool | null = null;
  private readonly transportClock: TransportClock;
  private readonly scheduler: Scheduler;
  private readonly timer: RepeatingTimer;
  private readonly startDelaySeconds: number;
  private readonly createContext: (() => AudioContext) | undefined;
  private readonly resolveSample: ((sampleId: string) => AudioBuffer | null) | undefined;
  private error: AudioEngineError | null = null;
  private unsupported = false;
  private disposed = false;
  private scheduledSampleOnsets: Array<{ key: string; time: number; iteration: number }> = [];
  private scheduledAudio: ScheduledEventTiming[] = [];
  /** Mixer settings requested before a context exists; applied when the graph is attached. */
  private mixerState: MixerState | null = null;
  /** Live per-channel sample region and synth patch, read at voice-build time. */
  private channelVoices = new Map<string, ChannelVoiceSettings>();
  private readonly listeners = new Set<(state: AudioEngineState) => void>();

  constructor(options: BrowserAudioEngineOptions = {}) {
    this.createContext = options.createContext;
    this.resolveSample = options.resolveSample;
    this.startDelaySeconds = options.startDelaySeconds ?? 0.06;
    this.timer = options.timer ?? createBestAvailableTimer();
    this.transportClock = new TransportClock({
      tempoBpm: options.tempoBpm ?? 120,
      timeSignature: options.timeSignature ?? { numerator: 4, denominator: 4 },
      loop: options.loop,
    });
    this.scheduler = new Scheduler({
      transport: this.transportClock,
      sink: this,
      clock: { now: () => this.now() },
      timer: this.timer,
      lookaheadSeconds: options.lookaheadSeconds,
      intervalMs: options.intervalMs,
      beforeTick: (now) => this.beforeTick(now),
      onError: (error) => this.fail(error, 'scheduling-failed'),
    });
  }

  // ---------------------------------------------------------------- lifecycle

  get status(): AudioEngineStatus {
    if (this.unsupported) return 'unsupported';
    if (this.error) return 'error';
    if (!this.context) return 'idle';
    if (this.context.state === 'closed') return 'closed';
    if (this.context.state === 'running') return 'ready';
    return 'suspended';
  }

  get lastError(): AudioEngineError | null {
    return this.error;
  }

  get transport(): TransportClock {
    return this.transportClock;
  }

  get isPlaying(): boolean {
    return this.transportClock.status === 'playing';
  }

  /** Call only from a user gesture so browser autoplay policies are respected. */
  async initialize(): Promise<AudioEngineStatus> {
    if (!this.hasWebAudioSupport()) {
      this.unsupported = true;
      this.error = null;
      this.emit();
      return 'unsupported';
    }
    try {
      await this.ensureContext();
      this.error = null;
      this.emit();
      return this.status;
    } catch (error) {
      throw this.fail(error);
    }
  }

  /** Suspend the audio hardware. `currentTime` freezes, so the transport keeps its position. */
  async suspend(): Promise<void> {
    if (!this.context || this.context.state !== 'running') return;
    try {
      await this.context.suspend();
    } catch (error) {
      throw this.fail(error);
    }
    this.emit();
  }

  /** Resume a suspended context. Must be called from a user gesture. */
  async resume(): Promise<AudioEngineStatus> {
    if (!this.hasWebAudioSupport()) {
      this.unsupported = true;
      this.emit();
      return 'unsupported';
    }
    try {
      await this.ensureContext();
      this.error = null;
      this.emit();
      return this.status;
    } catch (error) {
      throw this.fail(error);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduledSampleOnsets = [];
    this.scheduledAudio = [];
    this.scheduler.dispose();
    this.timer.dispose();
    this.pool?.clear();
    this.pool = null;
    this.graph?.dispose();
    this.graph = null;
    this.transportClock.stop();
    const context = this.context;
    this.context = null;
    this.listeners.clear();
    if (context && context.state !== 'closed') {
      try {
        await context.close();
      } catch {
        /* context already unusable */
      }
    }
  }

  subscribe(listener: (state: AudioEngineState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): AudioEngineState {
    return {
      status: this.status,
      transportStatus: this.transportClock.status,
      positionSteps: this.getPositionSteps(),
      iteration: this.transportClock.iteration,
      message: this.error?.message ?? null,
      reason: this.error?.reason ?? null,
      sampleRate: this.context?.sampleRate ?? null,
      outputLatencySeconds: this.getOutputLatencySeconds(),
      diagnostics: this.scheduler.getDiagnostics(),
    };
  }

  // ---------------------------------------------------------------- transport

  /** Start or resume playback. Safe to call repeatedly; initializes audio on first use. */
  async play(): Promise<void> {
    const context = await this.ensureContext();
    // Clear the previous error before starting; anything raised while scheduling must survive.
    this.error = null;
    if (this.transportClock.status === 'playing') {
      this.emit();
      return;
    }
    const now = context.currentTime;
    if (this.transportClock.status === 'paused') {
      // Resume continues from the parked position; no offset, so the position never jumps back.
      this.transportClock.resume(now);
    } else {
      const loop = this.transportClock.loop;
      const parked = this.transportClock.parkedPositionSteps;
      this.transportClock.start(now, { fromStep: loop.enabled && parked >= loop.endStep ? loop.startStep : parked, startDelay: this.startDelaySeconds });
    }
    this.scheduler.reset();
    this.scheduler.seekToPosition(this.transportClock.parkedPositionSteps);
    this.scheduler.start();
    // Queue the first window immediately so events at the start position are never late.
    this.scheduler.tick();
    this.emit();
  }

  /** Freeze at the current position and release every sounding voice. */
  pause(): void {
    this.scheduledSampleOnsets = [];
    this.scheduledAudio = [];
    if (this.transportClock.status === 'playing') {
      this.transportClock.pause(this.now());
    }
    this.scheduler.stop();
    this.pool?.releaseAll(this.now());
    this.emit();
  }

  /** Stop playback, release voices, and park at the region start. */
  stop(): void {
    this.scheduledSampleOnsets = [];
    this.scheduledAudio = [];
    const now = this.now();
    this.scheduler.stop();
    this.pool?.releaseAll(now);
    this.transportClock.stop();
    this.emit();
  }

  /** Stop and immediately start again from the region start. */
  async restart(): Promise<void> {
    this.stop();
    await this.play();
  }

  /** Move the playhead to a step position. */
  seek(step: number): void {
    this.scheduledSampleOnsets = [];
    this.scheduledAudio = [];
    const now = this.now();
    const wasPlaying = this.transportClock.status === 'playing';
    this.scheduler.stop();
    this.pool?.releaseAll(now);
    this.transportClock.advanceTo(now);
    const loop = this.transportClock.loop;
    this.transportClock.seek(loop.enabled && step >= loop.endStep ? loop.startStep : step, now);
    this.scheduler.seekToPosition(this.transportClock.parkedPositionSteps);
    this.resumeScheduling(wasPlaying);
    this.emit();
  }

  setTempo(bpm: number): void {
    this.reconfigure((now) => this.transportClock.setTempo(bpm, now));
  }

  /** Replace the saved, piecewise-constant song tempo map. */
  setTempoMap(changes: TempoMap): void {
    this.reconfigure((now) => this.transportClock.setTempoMap(changes, now));
  }

  setTimeSignature(timeSignature: TimeSignature): void {
    this.reconfigure((now) => this.transportClock.setTimeSignature(timeSignature, now));
  }

  setLoop(loop: Partial<LoopRange> & { enabled?: boolean }): void {
    this.reconfigure((now) => this.transportClock.setLoop(loop, now));
  }

  setLoopEnabled(enabled: boolean): void {
    this.setLoop({ enabled });
  }

  /** Replace the musical events to play. Takes effect on the next scheduling window. */
  setSequence(events: readonly MusicalEvent[]): void {
    const hasContext = this.context !== null;
    this.reconfigure((now) => this.scheduler.setEvents(events, hasContext ? now : undefined));
  }

  /** Atomically replace the arrangement and all timing settings; refill only one lookahead. */
  setArrangement(source: MusicalEventSource, settings: {
    tempoMap: TempoMap;
    timeSignature: TimeSignature;
    loop: Partial<LoopRange> & { enabled: boolean };
  }): void {
    this.reconfigure((now) => {
      this.transportClock.setTempoMap(settings.tempoMap, now);
      this.transportClock.setTimeSignature(settings.timeSignature, now);
      this.transportClock.setLoop(settings.loop, now);
      this.scheduler.setEventSource(source);
    });
  }

  // ------------------------------------------------------------------- mixer

  /**
   * Apply the project's mixer settings, routing, and source assignments.
   *
   * The graph diffs this against what is already built, so an individual fader, pan, mute, solo, or
   * route change touches one AudioParam or one connection — it never rebuilds the graph, never
   * restarts the scheduler, and never cuts a sounding voice.
   */
  setMixerState(state: MixerState): void {
    this.mixerState = state;
    this.syncMixerGraph();
  }

  getMixerState(): MixerState | null {
    return this.mixerState;
  }

  /** Cumulative proof of how much work mixer changes did; null before a context exists. */
  getMixerStats(): MixerGraphStats | null {
    return this.graph?.getMixerStats() ?? null;
  }

  getMixerRoutingWarnings(): string[] {
    return this.graph?.getRoutingWarnings() ?? [];
  }

  /**
   * Read every level meter once. Callers poll this at a bounded rate (the Mixer uses ~20 Hz);
   * nothing in the engine schedules meter work on its own.
   */
  sampleMeters(): void {
    this.graph?.sampleMeters(this.now());
  }

  getMeterReading(mixerChannelId: string): MeterReading | null {
    return this.graph?.getMeterReading(mixerChannelId) ?? null;
  }

  getMeterChannelIds(): string[] {
    return this.graph?.getMeterChannelIds() ?? [];
  }

  /** Clear one meter's latched clip indicator. */
  clearMeterClip(mixerChannelId: string): void {
    this.graph?.clearMeterClip(mixerChannelId);
  }

  /** Linear gain of one routed source strip; the mixer state owns the channel faders. */
  setChannelGain(sourceId: string, gain: number): void {
    this.graph?.setChannelGain(sourceId, gain);
  }

  setMasterGain(gain: number): void {
    this.graph?.setMasterGain(gain);
  }

  private syncMixerGraph(): void {
    if (!this.graph || !this.mixerState) return;
    // Orphan strips can only be released while no voice is connected to one.
    this.graph.syncMixer(this.mixerState, { canPruneStrips: (this.pool?.activeCount ?? 0) === 0 });
  }

  /**
   * Replace the per-channel playback settings (assigned sample, sample region and gain, synth
   * patch). These are read whenever a voice is built, so changes apply to the next note or
   * trigger. They never rebuild the arrangement and never cut a sounding voice.
   */
  setChannelVoices(channels: readonly Channel[]): void {
    const next = new Map<string, ChannelVoiceSettings>();
    for (const channel of channels) {
      next.set(channel.id, {
        sampleId: channel.sampleId,
        sampleTrim: channel.sampleTrim,
        synth: channel.synth?.params,
      });
    }
    this.channelVoices = next;
  }

  /** The playback settings currently applied to a channel; null for an unknown channel. */
  getChannelVoices(channelId: string): ChannelVoiceSettings | null {
    return this.channelVoices.get(channelId) ?? null;
  }

  /** Number of voices the pool currently tracks; a diagnostic for polyphony limits. */
  get activeVoiceCount(): number {
    return this.pool?.activeCount ?? 0;
  }

  // ---------------------------------------------------------------- positions

  /** Musical position in steps for the current audio-clock time. */
  getPositionSteps(): number {
    const now = this.now();
    this.transportClock.advanceTo(now);
    return this.transportClock.positionAt(now);
  }

  /**
   * Position used to draw the playhead: the audio-clock position shifted back by the reported
   * output latency, so what is drawn matches what is heard.
   */
  getPlayheadSteps(): number {
    if (!this.context) return this.transportClock.parkedPositionSteps;
    const latency = this.getOutputLatencySeconds();
    return this.transportClock.playheadAt(Math.max(0, this.context.currentTime - latency));
  }

  getOutputLatencySeconds(): number {
    if (!this.context) return 0;
    const outputLatency = (this.context as AudioContext & { outputLatency?: number }).outputLatency;
    const baseLatency = (this.context as AudioContext & { baseLatency?: number }).baseLatency;
    const value = outputLatency ?? baseLatency ?? 0;
    return Number.isFinite(value) ? Math.min(0.25, Math.max(0, value)) : 0;
  }

  getDiagnostics(): SchedulerDiagnostics {
    return this.scheduler.getDiagnostics();
  }

  /** Manual tick for hosts without a timer (tests, offline rendering). */
  tick(): void {
    this.scheduler.tick();
  }

  /** Audition voice: proves the audio path is connected without starting the transport. */
  async auditionTestTone(channelId = 'audition'): Promise<void> {
    const context = await this.ensureContext();
    const time = context.currentTime + 0.02;
    this.scheduleEvent({
      event: {
        kind: 'sample',
        id: `audition-${time}`,
        step: 0,
        channelId,
        sampleId: 'kick',
        velocity: 0.9,
      },
      time,
      durationSeconds: 0,
      iteration: 0,
    });
    this.emit();
  }

  // ---------------------------------------------------------------- sink

  scheduleEvent(timing: ScheduledEventTiming): void {
    if (!this.pool || !this.graph) {
      throw new AudioEngineError(CLOSED_MESSAGE, 'context-closed');
    }
    try {
      if (timing.event.kind === 'sample' && timing.event.velocity > 0) this.scheduledSampleOnsets.push({ key: sampleOnsetKey(timing.event), time: timing.time, iteration: timing.iteration });
      if (timing.event.kind === 'audio') this.scheduledAudio.push(timing);
      this.pool.schedule(timing);
    } catch (error) {
      this.fail(error, 'scheduling-failed');
    }
  }

  cancelPendingFrom(time: number): void {
    this.pool?.cancelPendingFrom(time);
  }

  releaseAll(atTime: number): void {
    this.pool?.releaseAll(atTime);
  }

  // ---------------------------------------------------------------- internals

  /** Runs before each scheduling window: applies loop wraps and loop-disabled auto-stop. */
  private beforeTick(now: number): boolean {
    if (this.transportClock.status !== 'playing') return false;
    const loop = this.transportClock.loop;
    if (!loop.enabled && this.transportClock.positionAt(now) >= loop.endStep) {
      this.stop();
      return false;
    }
    this.transportClock.syncCycles(now);
    this.scheduledSampleOnsets = this.scheduledSampleOnsets.filter((onset) => onset.time >= now - 0.25);
    this.scheduledAudio = this.scheduledAudio.filter((timing) => timing.time + timing.durationSeconds > now);
    return true;
  }

  /** Restart scheduling after a transport change, queueing the current window immediately. */
  private resumeScheduling(wasPlaying: boolean): void {
    if (!wasPlaying) return;
    this.scheduler.start();
    this.scheduler.tick();
  }

  /**
   * Apply a transport or sequence change while playing: drop audio queued with the old settings,
   * re-cursor the scheduler at the current position, and refill the window so nothing is lost.
   */
  private reconfigure(applyChange: (now: number) => void): void {
    const now = this.now();
    const wasPlaying = this.transportClock.status === 'playing';
    this.transportClock.advanceTo(now);
    const outgoingPosition = this.transportClock.positionAt(now);
    const outgoingIteration = this.transportClock.iteration;
    // Only skip onsets that actually sounded. Pending downbeats and newly inserted clips must
    // still play if an edit lands in startup headroom or exactly on a musical boundary.
    const playedSamples = new Set(this.scheduledSampleOnsets.filter((onset) => onset.iteration === this.transportClock.iteration && onset.time <= now).map((onset) => onset.key));
    const continuations = new Map<string, AudioContinuation>();
    for (const timing of this.scheduledAudio) {
      if (timing.event.kind === 'audio' && timing.time <= now && timing.time + timing.durationSeconds > now && timing.iteration === this.transportClock.iteration) {
        continuations.set(timing.event.id, { event: timing.event, sourceOffsetSeconds: (timing.sourceOffsetSeconds ?? timing.event.sourceOffsetSeconds) + now - timing.time });
      }
    }
    this.scheduledSampleOnsets = [];
    this.scheduledAudio = [];
    this.scheduler.stop();
    // Mute/delete/trim edits and new tempo maps must also retire sounding sustained voices.
    this.pool?.releaseAll(now);
    applyChange(now);
    this.transportClock.advanceTo(now);
    const position = this.transportClock.positionAt(now);
    if (Math.abs(position - outgoingPosition) > 1e-8 || outgoingIteration !== this.transportClock.iteration) {
      // Loop edits can implicitly seek/wrap; they enter the new song position, not the old audio phase.
      playedSamples.clear();
      continuations.clear();
    }
    this.scheduler.seekToPosition(position, playedSamples, continuations);
    this.resumeScheduling(wasPlaying);
    this.emit();
  }

  private now(): number {
    return this.context?.currentTime ?? 0;
  }

  private hasWebAudioSupport(): boolean {
    if (this.createContext) return true;
    return typeof window !== 'undefined' && typeof window.AudioContext === 'function';
  }

  private async ensureContext(): Promise<AudioContext> {
    // A disposed engine can be started again: React strict-mode remounts dispose and remount the
    // engine, and the next gesture simply builds a fresh context.
    this.disposed = false;
    if (this.context && this.context.state !== 'closed') {
      if (this.context.state === 'suspended') await this.context.resume();
      if (this.context.state !== 'running') {
        throw new AudioEngineError(AUTOPLAY_MESSAGE, 'autoplay-blocked');
      }
      return this.context;
    }

    if (!this.hasWebAudioSupport()) {
      this.unsupported = true;
      throw new AudioEngineError(UNSUPPORTED_MESSAGE, 'unsupported');
    }

    let context: AudioContext;
    try {
      context = this.createContext
        ? this.createContext()
        : new window.AudioContext({ latencyHint: 'interactive' });
    } catch (error) {
      throw this.fail(error, 'device-unavailable');
    }

    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch (error) {
        throw this.fail(error, 'autoplay-blocked');
      }
    }
    if (context.state === 'closed') throw new AudioEngineError(CLOSED_MESSAGE, 'context-closed');
    if (context.state !== 'running') {
      throw new AudioEngineError(AUTOPLAY_MESSAGE, 'autoplay-blocked');
    }

    this.attachContext(context);
    this.error = null;
    return context;
  }

  /** Own a freshly created context: graph, voice pool, and state-change handling. */
  private attachContext(context: AudioContext): void {
    this.context = context;
    this.graph = new AudioGraph(context, { masterGain: 0.8 });
    this.pool = new VoicePool(
      this.graph,
      (error) => this.fail(error, 'scheduling-failed'),
      this.resolveSample,
      (channelId) => this.channelVoices.get(channelId) ?? null,
    );
    context.onstatechange = () => this.handleContextStateChange();
    // Mixer settings requested before the first gesture are applied to the fresh graph.
    this.syncMixerGraph();
  }

  /**
   * Decode an audio file without requiring a running context (decoding works suspended), so
   * samples can be loaded before the user enables playback. Creates an idle context if none
   * exists yet.
   */
  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.hasWebAudioSupport()) {
      this.unsupported = true;
      this.emit();
      throw new AudioEngineError(UNSUPPORTED_MESSAGE, 'unsupported');
    }
    let context = this.context && this.context.state !== 'closed' ? this.context : null;
    if (!context) {
      try {
        context = this.createContext
          ? this.createContext()
          : new window.AudioContext({ latencyHint: 'interactive' });
      } catch (error) {
        throw this.fail(error, 'device-unavailable');
      }
      this.attachContext(context);
      this.emit();
    }
    return new Promise<AudioBuffer>((resolve, reject) => {
      try {
        // Copy the bytes: decodeAudioData detaches the input buffer in some browsers.
        const result = context!.decodeAudioData(data.slice(0), resolve, (error: unknown) =>
          reject(error ?? new Error('The browser could not decode this audio file.')),
        );
        if (result && typeof (result as Promise<AudioBuffer>).then === 'function') {
          (result as Promise<AudioBuffer>).then(resolve, reject);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Audition a channel's sound once without starting the transport: the loaded sample buffer
   * when one is assigned, otherwise the built-in voice resolved from `sampleId`.
   */
  async auditionSample(channelId: string, sampleId: string): Promise<void> {
    const context = await this.ensureContext();
    const time = context.currentTime + 0.02;
    this.scheduleEvent({
      event: {
        kind: 'sample',
        id: `audition:${channelId}:${time}`,
        step: 0,
        channelId,
        sampleId,
        velocity: 0.9,
      },
      time,
      durationSeconds: 0,
      iteration: 0,
    });
    this.emit();
  }

  /**
   * Preview a whole loaded asset (library audition). Refuses a missing asset instead of letting a
   * synthesized drum stand in for it.
   */
  async auditionAsset(assetId: string, channelId = 'audition'): Promise<void> {
    if (!this.resolveSample?.(assetId)) {
      throw new AudioEngineError('This sample is missing from the session. Import the file again to restore it.', 'unknown');
    }
    const context = await this.ensureContext();
    const time = context.currentTime + 0.02;
    this.scheduleEvent({
      event: {
        kind: 'sample',
        id: `audition-asset:${assetId}:${time}`,
        step: 0,
        channelId,
        sampleId: assetId,
        velocity: 0.9,
      },
      time,
      durationSeconds: 0,
      iteration: 0,
    });
    this.emit();
  }

  /** Preview a pitched note on an instrument channel without starting the transport. */
  async auditionNote(channelId: string, pitch: number, velocity = 0.8, durationSeconds = 0.18): Promise<void> {
    const context = await this.ensureContext();
    const time = context.currentTime + 0.02;
    const safePitch = Math.min(127, Math.max(0, Math.round(pitch)));
    const safeVelocity = Math.min(1, Math.max(0, velocity));
    this.scheduleEvent({
      event: {
        kind: 'note',
        id: `audition-note:${channelId}:${safePitch}:${time}`,
        step: 0,
        channelId,
        pitch: safePitch,
        velocity: safeVelocity,
        durationSteps: 1,
      },
      time,
      durationSeconds: Math.max(0.05, durationSeconds),
      iteration: 0,
    });
    this.emit();
  }

  private handleContextStateChange(): void {
    const context = this.context;
    if (!context) return;
    const state = context.state as AudioContextState | 'interrupted';
    if (state === 'closed') {
      this.scheduler.stop();
      this.pool?.clear();
      this.pool = null;
      this.graph?.dispose();
      this.graph = null;
      this.transportClock.stop();
      this.emit();
      return;
    }
    if (state === 'interrupted') {
      this.scheduler.stop();
      this.pool?.releaseAll(context.currentTime);
      this.transportClock.pause(context.currentTime);
      this.fail(new Error(DEVICE_MESSAGE), 'device-unavailable');
    }
    this.emit();
  }

  private fail(error: unknown, reason?: AudioErrorReason): AudioEngineError {
    const engineError = toAudioEngineError(error, reason);
    this.error = engineError;
    if (engineError.reason === 'scheduling-failed') {
      this.scheduledSampleOnsets = [];
      this.scheduledAudio = [];
      this.scheduler.stop();
      this.pool?.releaseAll(this.now());
      this.transportClock.stop();
    }
    this.emit();
    return engineError;
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const state = this.getState();
    for (const listener of [...this.listeners]) listener(state);
  }
}

/** Message shown for a classified failure. */
function messageForReason(reason: AudioErrorReason): string {
  switch (reason) {
    case 'unsupported':
      return UNSUPPORTED_MESSAGE;
    case 'autoplay-blocked':
      return AUTOPLAY_MESSAGE;
    case 'device-unavailable':
      return DEVICE_MESSAGE;
    case 'context-closed':
      return CLOSED_MESSAGE;
    default:
      return SCHEDULING_MESSAGE;
  }
}

function toAudioEngineError(error: unknown, reason?: AudioErrorReason): AudioEngineError {
  if (error instanceof AudioEngineError) return error;
  if (reason) return new AudioEngineError(messageForReason(reason), reason, { cause: error });
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = String((error as { message?: string } | null)?.message ?? '');
  if (name === 'NotAllowedError' || /gesture|autoplay|user activation/i.test(message)) {
    return new AudioEngineError(AUTOPLAY_MESSAGE, 'autoplay-blocked', { cause: error });
  }
  if (name === 'NotSupportedError' || /device|hardware|output/i.test(message)) {
    return new AudioEngineError(DEVICE_MESSAGE, 'device-unavailable', { cause: error });
  }
  if (name === 'InvalidStateError' || /closed/i.test(message)) {
    return new AudioEngineError(CLOSED_MESSAGE, 'context-closed', { cause: error });
  }
  return new AudioEngineError(SCHEDULING_MESSAGE, 'unknown', { cause: error });
}
