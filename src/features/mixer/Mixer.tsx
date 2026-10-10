import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createAddMixerChannelCommand, type ProjectCommand } from '../../core/commands';
import {
  createStableId,
  MAX_MIXER_INSERTS,
  MIXER_EFFECT_SLOT_COUNT,
  MIXER_MAX_DB,
  MIXER_MIN_DB,
  type MixerChannel,
  type Project,
} from '../../core/project/model';
import {
  formatMixerDb,
  formatPan,
  getInsertChannels,
  getMasterChannel,
  isAnyInsertSoloed,
  listRouteTargets,
  listSourcesForChannel,
  resolveMixerAudibility,
} from '../../core/mixer/mixerModel';
import { Icon } from '../../components/Icon';
import { PanelFrame } from '../../components/PanelFrame';
import type { MeterViewRegistry } from './meterView';

/**
 * Mixer panel.
 *
 * One strip per mixer channel: an editable name, a level meter, a dB fader, a pan control, mute and
 * solo, an output selector that only offers legal destinations, prepared effect slots, and the list
 * of Channel Rack channels and Playlist tracks routed into the strip. The master bus is pinned last
 * and cannot be rerouted or removed.
 *
 * Every control dispatches a project command, so the mixer is undoable, serializable, and applied to
 * the audio graph by the same diffing sync as everything else. Fader and pan drags carry a coalesce
 * key so one gesture is one undo entry instead of one entry per pixel.
 */

interface MixerProps {
  project: Project;
  collapsed: boolean;
  onToggle: () => void;
  /** Applies a mixer edit. `coalesceKey` groups a drag into a single undo entry. */
  onCommand: (command: ProjectCommand, options?: { coalesceKey?: string }) => boolean;
  /** Meter elements bind themselves here; the app polls the engine and writes into them. */
  meterRegistry: MeterViewRegistry;
  /** Clears one meter's latched clip indicator. */
  onClearClip: (mixerChannelId: string) => void;
}

const METER_ELEMENT_KINDS = ['fill', 'peak', 'clip', 'readout'] as const;

export function Mixer({ project, collapsed, onToggle, onCommand, meterRegistry, onClearClip }: MixerProps) {
  const inserts = getInsertChannels(project);
  const master = getMasterChannel(project);
  const anySolo = isAnyInsertSoloed(project);
  const atInsertLimit = inserts.length >= MAX_MIXER_INSERTS;

  function addChannel() {
    // The factory rejects an over-full mixer before a command is built, so stop at the limit here
    // rather than throwing inside a click handler.
    if (atInsertLimit) return;
    onCommand(createAddMixerChannelCommand(project, createStableId('mixer')));
  }

  const toolbar = (
    <div className="mixer-toolbar">
      <button
        aria-label="Add mixer channel"
        className="button add-channel-button"
        disabled={atInsertLimit}
        onClick={addChannel}
        title={atInsertLimit ? `A project supports at most ${MAX_MIXER_INSERTS} mixer channels` : 'Add an insert channel routed to the master bus'}
        type="button"
      >
        <Icon name="plus" size={12} /> Channel
      </button>
      <button
        aria-label="Clear all mixer solos"
        className="button mixer-solo-clear"
        disabled={!anySolo}
        onClick={() => onCommand({ type: 'mixer.solo.clear' })}
        title="Release every soloed mixer channel"
        type="button"
      >
        Clear solos
      </button>
      <span className="mixer-toolbar-hint">
        {anySolo ? 'Solo active · unsoloed channels are gated' : `${inserts.length} insert${inserts.length === 1 ? '' : 's'} → master bus`}
      </span>
    </div>
  );

  return (
    <PanelFrame
      badge={anySolo ? 'SOLO ACTIVE' : 'ROUTING LIVE'}
      className="mixer-panel"
      collapsed={collapsed}
      id="panel-mixer"
      onToggle={onToggle}
      title="Mixer"
      toolbar={toolbar}
    >
      <div className="mixer-scroll">
        {inserts.map((channel, index) => (
          <MixerStrip
            channel={channel}
            index={index}
            insertCount={inserts.length}
            key={channel.id}
            masterName={master?.name ?? 'Master'}
            onClearClip={onClearClip}
            onCommand={onCommand}
            project={project}
            registry={meterRegistry}
          />
        ))}
        {master && (
          <MixerStrip
            channel={master}
            index={inserts.length}
            insertCount={inserts.length}
            key={master.id}
            masterName={master.name}
            onClearClip={onClearClip}
            onCommand={onCommand}
            project={project}
            registry={meterRegistry}
          />
        )}
        <p className="mixer-note">
          <span className="deferred-indicator" />
          <span>
            Faders, pan, mute/solo, metering, and routing are live. The {MIXER_EFFECT_SLOT_COUNT} effect slots per
            channel are wired as unity bypasses; processors arrive next.
          </span>
        </p>
      </div>
    </PanelFrame>
  );
}

interface MixerStripProps {
  channel: MixerChannel;
  /** Position within the insert list; the master bus is rendered last and cannot move. */
  index: number;
  insertCount: number;
  masterName: string;
  project: Project;
  registry: MeterViewRegistry;
  onClearClip: (mixerChannelId: string) => void;
  onCommand: MixerProps['onCommand'];
}

function MixerStrip({ channel, index, insertCount, masterName, project, registry, onClearClip, onCommand }: MixerStripProps) {
  const isMaster = channel.role === 'master';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef(0);
  const [nameDraft, setNameDraft] = useState(channel.name);

  useEffect(() => setNameDraft(channel.name), [channel.name]);

  // Bind this strip's meter nodes once per channel id. The poll loop writes into them directly,
  // so meter updates never re-render React.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    registry.register(channel.id, channel.id, 'vertical');
    for (const kind of METER_ELEMENT_KINDS) {
      registry.setElement(channel.id, kind, root.querySelector<HTMLElement>(`[data-meter="${kind}"]`));
    }
    return () => registry.unregister(channel.id);
  }, [channel.id, registry]);

  const audibility = resolveMixerAudibility(channel, project);
  const sources = listSourcesForChannel(project, channel.id);
  const coalesceKey = (control: string) => `${control}:${channel.id}:${gesture.current}`;

  function commitName() {
    const name = nameDraft.trim();
    if (!name || name === channel.name) {
      setNameDraft(channel.name);
      return;
    }
    if (!onCommand({ type: 'mixer.channel.rename', channelId: channel.id, name })) setNameDraft(channel.name);
  }

  function handleNameKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      setNameDraft(channel.name);
      event.currentTarget.blur();
    }
  }

  /** A fresh pointer or key gesture starts a new undo entry; key repeats keep coalescing into it. */
  function beginGesture(repeat = false) {
    if (!repeat) gesture.current += 1;
  }

  function setVolume(volumeDb: number) {
    onCommand({ type: 'mixer.channel.volume.set', channelId: channel.id, volumeDb }, { coalesceKey: coalesceKey('volume') });
  }

  function setPan(pan: number) {
    onCommand({ type: 'mixer.channel.pan.set', channelId: channel.id, pan }, { coalesceKey: coalesceKey('pan') });
  }

  const classes = [
    'mixer-strip',
    isMaster && 'mixer-strip--master',
    channel.muted && 'mixer-strip--muted',
    channel.solo && 'mixer-strip--solo',
    !audibility.audible && 'mixer-strip--silent',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} ref={rootRef}>
      <div className="mixer-strip-head">
        <span className="mixer-strip-index">{isMaster ? 'M' : String(index + 1).padStart(2, '0')}</span>
        {!isMaster && (
          <span className="mixer-strip-order">
            <button
              aria-label={`Move mixer channel ${channel.name} earlier`}
              className="mixer-order-button"
              disabled={index === 0}
              onClick={() => onCommand({ type: 'mixer.channel.reorder', channelId: channel.id, toIndex: index - 1 })}
              title="Move this channel earlier in the mixer"
              type="button"
            >
              ◀
            </button>
            <button
              aria-label={`Move mixer channel ${channel.name} later`}
              className="mixer-order-button"
              disabled={index === insertCount - 1}
              onClick={() => onCommand({ type: 'mixer.channel.reorder', channelId: channel.id, toIndex: index + 1 })}
              title="Move this channel later in the mixer"
              type="button"
            >
              ▶
            </button>
          </span>
        )}
      </div>

      <input
        aria-label={`Name of mixer channel ${channel.name}`}
        className="mixer-strip-name"
        maxLength={80}
        onBlur={commitName}
        onChange={(event) => setNameDraft(event.target.value)}
        onKeyDown={handleNameKeyDown}
        type="text"
        value={nameDraft}
      />

      <div className="mixer-strip-body">
        <div className="mixer-meter">
          <div aria-hidden="true" className="mixer-meter-track">
            <span className="mixer-meter-fill" data-meter="fill" />
            <span className="mixer-meter-peak" data-meter="peak" />
          </div>
          <button
            aria-label="No clipping"
            className="mixer-meter-clip"
            data-meter="clip"
            onClick={() => onClearClip(channel.id)}
            title="Clip indicator · click to reset"
            type="button"
          />
        </div>
        <div className="mixer-fader">
          <input
            aria-label={`Volume of mixer channel ${channel.name} in decibels`}
            aria-valuetext={formatMixerDb(channel.volumeDb)}
            className="mixer-fader-input"
            max={MIXER_MAX_DB}
            min={MIXER_MIN_DB}
            onChange={(event) => setVolume(Number(event.currentTarget.value))}
            onDoubleClick={() => setVolume(0)}
            onKeyDown={(event) => beginGesture(event.repeat)}
            onPointerDown={() => beginGesture()}
            step={0.5}
            title={`${formatMixerDb(channel.volumeDb)} · double-click for unity`}
            type="range"
            value={channel.volumeDb}
          />
        </div>
      </div>

      <div className="mixer-readouts">
        <span className="mixer-db">{formatMixerDb(channel.volumeDb)}</span>
        <span className="mixer-peak-db" data-meter="readout" title="Measured peak">
          -inf dB
        </span>
      </div>

      <label className="mixer-pan">
        <span className="sr-only-text">Pan of mixer channel {channel.name}</span>
        <input
          aria-label={`Pan of mixer channel ${channel.name}`}
          aria-valuetext={formatPan(channel.pan)}
          className="mixer-pan-input"
          disabled={isMaster}
          max={1}
          min={-1}
          onChange={(event) => setPan(Number(event.currentTarget.value))}
          onDoubleClick={() => setPan(0)}
          onKeyDown={(event) => beginGesture(event.repeat)}
          onPointerDown={() => beginGesture()}
          step={0.02}
          title={isMaster ? 'The master bus is not panned' : `${formatPan(channel.pan)} · double-click for centre`}
          type="range"
          value={channel.pan}
        />
        <span aria-hidden="true" className="mixer-pan-value">{isMaster ? '—' : formatPan(channel.pan)}</span>
      </label>

      <div className="mixer-strip-switches">
        <button
          aria-label={`Mute mixer channel ${channel.name}`}
          aria-pressed={channel.muted}
          className={`mixer-switch ${channel.muted ? 'mixer-switch--muted' : ''}`}
          onClick={() => onCommand({ type: 'mixer.channel.mute.set', channelId: channel.id, muted: !channel.muted })}
          title={channel.muted ? 'Unmute this channel' : 'Mute this channel'}
          type="button"
        >
          M
        </button>
        <button
          aria-label={`Solo mixer channel ${channel.name}`}
          aria-pressed={channel.solo}
          className={`mixer-switch ${channel.solo ? 'mixer-switch--solo' : ''}`}
          disabled={isMaster}
          onClick={() => onCommand({ type: 'mixer.channel.solo.set', channelId: channel.id, solo: !channel.solo })}
          title={isMaster ? 'The master bus sums every channel, so it cannot be soloed' : channel.solo ? 'Release this solo' : 'Solo this channel'}
          type="button"
        >
          S
        </button>
        {!isMaster && (
          <button
            aria-label={`Remove mixer channel ${channel.name}`}
            className="mixer-switch mixer-switch--remove"
            onClick={() => onCommand({ type: 'mixer.channel.remove', channelId: channel.id })}
            title="Remove this channel; everything routed into it moves to its destination"
            type="button"
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>

      {isMaster ? (
        <span className="mixer-route mixer-route--fixed" title="The master bus feeds the safety limiter and the output">
          OUT · LIMITER
        </span>
      ) : (
        <label className="mixer-route">
          <span className="sr-only-text">Output of mixer channel {channel.name}</span>
          <select
            aria-label={`Output of mixer channel ${channel.name}`}
            onChange={(event) => onCommand({ type: 'mixer.channel.route', channelId: channel.id, outputId: event.target.value })}
            title={`Output of ${channel.name} · currently ${masterName}`}
            value={channel.outputId ?? ''}
          >
            {listRouteTargets(project.mixerChannels, channel.id).map((target) => (
              <option key={target.id} value={target.id}>
                {target.role === 'master' ? `▸ ${target.name}` : target.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="mixer-strip-foot">
        <div aria-label={`Effect slots for mixer channel ${channel.name}`} className="mixer-fx" role="group">
          {Array.from({ length: MIXER_EFFECT_SLOT_COUNT }, (_, slot) => {
            const effect = channel.effects[slot];
            const filled = Boolean(effect?.type);
            return (
              <span
                className={`mixer-fx-slot ${filled ? 'mixer-fx-slot--filled' : ''} ${effect && !effect.enabled ? 'mixer-fx-slot--bypassed' : ''}`}
                key={slot}
                title={filled ? `${effect?.type ?? ''}${effect?.enabled ? '' : ' (bypassed)'}` : `Effect slot ${slot + 1} is empty · processors arrive next`}
              >
                {slot + 1}
              </span>
            );
          })}
        </div>

        <details className="mixer-sources">
          <summary title="Channel Rack channels and Playlist tracks routed into this strip">
            {sources.length} src
          </summary>
          <ul className="mixer-source-list">
            {sources.length === 0 && <li className="mixer-source-empty">Nothing is routed here</li>}
            {sources.map((source) => (
              <li key={source.id}>
                <span className="mixer-source-name" title={`${source.kind === 'track' ? 'Playlist track' : 'Channel Rack channel'} ${source.name}`}>
                  {source.kind === 'track' ? '▤' : '♪'} {source.name}
                </span>
                <select
                  aria-label={`Mixer channel for ${source.kind === 'track' ? 'track' : 'channel'} ${source.name}`}
                  onChange={(event) => onCommand({ type: 'mixer.source.assign', sourceId: source.id, mixerChannelId: event.target.value })}
                  value={source.mixerChannelId}
                >
                  {project.mixerChannels.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.role === 'master' ? `▸ ${target.name}` : target.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}
