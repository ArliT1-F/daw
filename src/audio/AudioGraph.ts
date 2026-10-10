/**
 * Audio graph ownership.
 *
 * Every node created for playback lives under this graph:
 *
 * ```
 * voices → source strip → mixer bus → … → master bus → safety limiter → destination
 * ```
 *
 * `syncMixer` is the only place that builds or rewires the mixer, and it diffs the requested
 * `MixerState` against what already exists: a fader move touches one `AudioParam`, a reroute touches
 * one connection, and untouched channels are not visited at all. Nothing here knows about the
 * project document — the rest of the app deals in musical events and serializable mixer state.
 *
 * Routing invariants the graph maintains:
 *  - a source strip has exactly one send target, so a source can never reach the master twice;
 *  - a bus has exactly one destination, resolved before it is connected (destinations are created
 *    first), so no feedback path can be built;
 *  - a destination that cannot be resolved falls back to the master bus and is reported, never
 *    dropped or left dangling;
 *  - the master bus always feeds the limiter and the hardware output, and `syncMixer` never
 *    touches that connection, so muting or soloing cannot bypass the master.
 */

import { MASTER_MIXER_CHANNEL_ID } from '../core/project/model';
import {
  dbToLinear,
  orderDestinationsFirst,
  type MixerChannelState,
  type MixerState,
} from '../core/mixer/mixerModel';
import { MeterBank, type MeterReading } from './metering';
import { MixerBus, SourceStrip, type AudioEffectProcessor } from './mixerNodes';

export interface AudioGraphOptions {
  /** Linear master gain, used until a mixer state is applied. */
  masterGain?: number;
  /** Attach in-line analysers for level metering (default true). */
  metering?: boolean;
}

/** Cumulative counters proving how much work a mixer change actually did. */
export interface MixerGraphStats {
  /** Number of `syncMixer` calls. */
  syncs: number;
  busesCreated: number;
  busesDisposed: number;
  stripsCreated: number;
  stripsDisposed: number;
  /** AudioParam automation calls issued while syncing. */
  paramUpdates: number;
  /** Destination connections created or moved while syncing. */
  routeChanges: number;
  /** Times an unresolvable destination fell back to the master bus. */
  routingFallbacks: number;
}

export interface SyncMixerOptions {
  /**
   * True when the engine knows no voice is connected to a source strip any more, so strips whose
   * source disappeared from the mixer state can be released. Dropping a strip while a voice is
   * still connected to it would cut that voice without its release fade.
   */
  canPruneStrips?: boolean;
}

export class AudioGraph {
  readonly context: AudioContext;
  readonly limiter: DynamicsCompressorNode;
  /** The single master bus. Its identity is fixed; only its mixer channel id changes. */
  readonly masterBus: MixerBus;

  private readonly meteringEnabled: boolean;
  private readonly buses = new Map<string, MixerBus>();
  private readonly strips = new Map<string, SourceStrip>();
  private readonly meters = new MeterBank();
  private readonly warnings = new Set<string>();
  private readonly stats: MixerGraphStats = {
    syncs: 0,
    busesCreated: 0,
    busesDisposed: 0,
    stripsCreated: 0,
    stripsDisposed: 0,
    paramUpdates: 0,
    routeChanges: 0,
    routingFallbacks: 0,
  };
  private masterId = MASTER_MIXER_CHANNEL_ID;
  private noiseBuffer: AudioBuffer | null = null;
  private disposed = false;

  constructor(context: AudioContext, options: AudioGraphOptions = {}) {
    this.context = context;
    this.meteringEnabled = options.metering !== false;
    this.limiter = context.createDynamicsCompressor();
    // Safety limiter: keeps stacked voices from clipping the output without colouring quiet mixes.
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    const masterGain = Number.isFinite(options.masterGain) ? Math.min(4, Math.max(0, options.masterGain as number)) : 0.8;
    this.masterBus = new MixerBus(context, {
      id: 'master',
      role: 'master',
      initialVolume: masterGain,
      metering: this.meteringEnabled,
    });
    // Fixed for the graph's lifetime: nothing in the mixer can reroute or bypass this.
    this.masterBus.connectTo(this.limiter);
    this.limiter.connect(context.destination);
    if (this.masterBus.meter) this.meters.attach(this.masterId, this.masterBus.meter);
    this.stats.busesCreated += 1;
  }

  /** Summing point every mixer bus feeds. Kept for callers that want the raw master input. */
  get masterInput(): GainNode {
    return this.masterBus.input;
  }

  /** Master fader gain node. */
  get masterGain(): GainNode {
    return this.masterBus.volume;
  }

  /** Mixer channel id currently used for the master bus. */
  get masterChannelId(): string {
    return this.masterId;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // ------------------------------------------------------------ source strips

  /**
   * Per-source input, created on demand so mixer routing has a single home. Voices connect here;
   * the strip's send node holds the one connection to the assigned mixer bus.
   */
  getChannelBus(sourceId: string): GainNode {
    return this.ensureStrip(sourceId).input;
  }

  getStrip(sourceId: string): SourceStrip | undefined {
    return this.strips.get(sourceId);
  }

  getStripIds(): string[] {
    return [...this.strips.keys()];
  }

  /** Per-source trim, separate from the mixer channel fader. */
  setChannelGain(sourceId: string, gain: number, when = this.context.currentTime): void {
    this.stats.paramUpdates += this.ensureStrip(sourceId).setSendGain(gain, when);
  }

  // --------------------------------------------------------------- master bus

  /** Linear master gain. A later `syncMixer` restores the project's saved master fader. */
  setMasterGain(gain: number, when = this.context.currentTime): void {
    this.stats.paramUpdates += this.masterBus.setVolumeLinear(gain, when);
  }

  setMasterVolumeDb(db: number, when = this.context.currentTime): void {
    this.stats.paramUpdates += this.masterBus.setVolumeDb(db, when);
  }

  // -------------------------------------------------------------- mixer sync

  getBus(mixerChannelId: string): MixerBus | undefined {
    return mixerChannelId === this.masterId ? this.masterBus : this.buses.get(mixerChannelId);
  }

  getBusIds(): string[] {
    return [...this.buses.keys()];
  }

  getMixerStats(): MixerGraphStats {
    return { ...this.stats };
  }

  /** Deduplicated diagnostics for destinations that had to fall back to the master bus. */
  getRoutingWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * Phase 7 hook: install (or clear, with an empty list) a bus's effect-slot chain. The fader, pan,
   * meter, and routing are untouched, so inserting an effect never rebuilds the channel.
   */
  setEffectChain(mixerChannelId: string, processors: readonly AudioEffectProcessor[]): boolean {
    const bus = this.getBus(mixerChannelId);
    return bus ? bus.setEffectChain(processors) : false;
  }

  /**
   * Bring the graph in line with a mixer state, changing only what actually differs.
   *
   * Safe to call on every project change: identical state costs one counter increment and no node
   * or parameter work at all.
   */
  syncMixer(state: MixerState, options: SyncMixerOptions = {}): void {
    if (this.disposed) return;
    this.stats.syncs += 1;
    const now = this.context.currentTime;
    this.adoptMasterChannelId(state.masterChannelId);

    const masterState = state.channels.find((channel) => channel.role === 'master') ?? null;
    // Destinations first, so a bus exists before anything is connected into it.
    const inserts = orderDestinationsFirst(
      state.channels
        .filter((channel) => channel.role === 'insert')
        .map((channel) => ({ ...channel, outputId: channel.outputId ?? this.masterId })),
    );
    const anySolo = inserts.some((channel) => channel.solo);
    const wanted = new Set(inserts.map((channel) => channel.id));

    // Retire removed buses first, repointing their feeders so nothing is left dangling.
    for (const [id, bus] of [...this.buses]) {
      if (wanted.has(id)) continue;
      this.repointFeeders(bus, this.masterBus.input);
      this.meters.detach(id);
      bus.dispose();
      this.buses.delete(id);
      this.stats.busesDisposed += 1;
    }

    for (const channel of inserts) {
      this.applyBusState(channel, anySolo, now);
    }

    if (masterState) {
      this.stats.paramUpdates += this.masterBus.setVolumeDb(masterState.volumeDb, now);
      this.stats.paramUpdates += this.masterBus.setPan(masterState.pan, now);
      this.stats.paramUpdates += this.masterBus.setAudible(!masterState.muted, now);
    }

    const sourceIds = new Set<string>();
    for (const source of state.sources) {
      sourceIds.add(source.id);
      const strip = this.ensureStrip(source.id);
      const bus = this.resolveBus(source.mixerChannelId, `source "${source.id}"`);
      if (strip.connectTo(bus.input)) this.stats.routeChanges += 1;
    }

    // A strip can only be dropped while no voice is still connected to it.
    if (options.canPruneStrips) {
      for (const [id, strip] of [...this.strips]) {
        if (sourceIds.has(id)) continue;
        strip.dispose();
        this.strips.delete(id);
        this.stats.stripsDisposed += 1;
      }
    }
  }

  private adoptMasterChannelId(masterChannelId: string): void {
    if (!masterChannelId || masterChannelId === this.masterId) return;
    // Re-key the master meter so the UI can keep looking readings up by project channel id.
    this.meters.detach(this.masterId);
    this.masterId = masterChannelId;
    if (this.masterBus.meter) this.meters.attach(this.masterId, this.masterBus.meter);
  }

  private applyBusState(channel: MixerChannelState, anySolo: boolean, now: number): void {
    // Mute wins over solo, matching the Channel Rack and Playlist rules. Soloing an insert gates
    // that insert only; the master bus still sums everything, so solo can never bypass it.
    const audible = !channel.muted && (!anySolo || channel.solo);
    const existing = this.buses.get(channel.id);
    if (!existing) {
      // A new bus is silent and unconnected, so its first values are assigned without automation.
      const bus = new MixerBus(this.context, {
        id: channel.id,
        role: 'insert',
        initialVolume: dbToLinear(channel.volumeDb),
        initialPan: channel.pan,
        initialAudible: audible,
        metering: this.meteringEnabled,
      });
      this.buses.set(channel.id, bus);
      if (bus.meter) this.meters.attach(channel.id, bus.meter);
      this.stats.busesCreated += 1;
      if (bus.connectTo(this.resolveBus(channel.outputId ?? this.masterId, `mixer channel "${channel.id}"`).input)) {
        this.stats.routeChanges += 1;
      }
      return;
    }
    const destination = this.resolveBus(channel.outputId ?? this.masterId, `mixer channel "${channel.id}"`);
    if (existing.connectTo(destination.input)) this.stats.routeChanges += 1;
    this.stats.paramUpdates += existing.setVolumeDb(channel.volumeDb, now);
    this.stats.paramUpdates += existing.setPan(channel.pan, now);
    this.stats.paramUpdates += existing.setAudible(audible, now);
  }

  private resolveBus(mixerChannelId: string, description: string): MixerBus {
    if (mixerChannelId === this.masterId) return this.masterBus;
    const bus = this.buses.get(mixerChannelId);
    if (bus) return bus;
    this.stats.routingFallbacks += 1;
    this.warnings.add(`${description} routes to missing mixer channel "${mixerChannelId}"; it falls back to the master bus.`);
    return this.masterBus;
  }

  /** Move everything that fed `removed` onto `destination` before the bus is disposed. */
  private repointFeeders(removed: MixerBus, destination: AudioNode): void {
    for (const bus of this.buses.values()) {
      if (bus === removed) continue;
      if (bus.destinationNode === removed.input && bus.connectTo(destination)) this.stats.routeChanges += 1;
    }
    for (const strip of this.strips.values()) {
      if (strip.destinationNode === removed.input && strip.connectTo(destination)) this.stats.routeChanges += 1;
    }
  }

  private ensureStrip(sourceId: string): SourceStrip {
    const existing = this.strips.get(sourceId);
    if (existing) return existing;
    const strip = new SourceStrip(this.context, sourceId);
    this.strips.set(sourceId, strip);
    this.stats.stripsCreated += 1;
    // An unrouted source still has to be audible: it feeds the master bus until a mixer state says
    // otherwise, and it can never bypass it.
    strip.connectTo(this.masterBus.input);
    this.stats.routeChanges += 1;
    return strip;
  }

  // ----------------------------------------------------------------- metering

  /** Read every attached analyser once. Call at a bounded rate, never per animation frame per strip. */
  sampleMeters(nowSeconds = this.context.currentTime): void {
    if (this.disposed) return;
    this.meters.sample(nowSeconds);
  }

  getMeterReading(mixerChannelId: string): MeterReading | null {
    return this.meters.reading(mixerChannelId);
  }

  getMeterChannelIds(): string[] {
    return this.meters.ids;
  }

  /** Clear a latched clip indicator. */
  clearMeterClip(mixerChannelId: string): void {
    this.meters.clearClip(mixerChannelId);
  }

  // ------------------------------------------------------------------ shared

  /** Shared white-noise buffer for percussion voices. */
  getNoiseBuffer(): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const length = Math.max(1, Math.floor(this.context.sampleRate * 0.5));
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
    return buffer;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const strip of this.strips.values()) strip.dispose();
    this.strips.clear();
    for (const bus of this.buses.values()) bus.dispose();
    this.buses.clear();
    this.masterBus.dispose();
    this.meters.clear();
    this.warnings.clear();
    try {
      this.limiter.disconnect();
    } catch {
      /* already detached */
    }
    this.noiseBuffer = null;
  }
}
