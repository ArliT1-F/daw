import { useRef, type ChangeEvent } from 'react';
import type { ProjectCommand } from '../../core/commands';
import {
  EFFECT_DEFINITIONS,
  effectValueToNormalized,
  formatEffectValue,
  listEffectTypesFor,
  normalizedToEffectValue,
  quantizeEffectValue,
  type EffectParamSpec,
  type EffectType,
} from '../../core/effects/effectDefinitions';
import {
  createStableId,
  MIXER_EFFECT_SLOT_COUNT,
  type MixerChannel,
  type MixerEffectSlot,
  type Project,
} from '../../core/project/model';
import { Icon } from '../../components/Icon';

/**
 * Effects rack for one mixer channel.
 *
 * Presentation only: it reads the project and dispatches commands. It knows nothing about audio
 * nodes, so the same rack works whether the graph is live or offline. A parameter drag carries a
 * coalesce key per effect and parameter, so one gesture is one undo entry.
 */

export interface EffectRackProps {
  project: Project;
  channelId: string;
  onCommand: (command: ProjectCommand, options?: { coalesceKey?: string }) => boolean;
  onClose: () => void;
}

export function EffectRack({ project, channelId, onCommand, onClose }: EffectRackProps) {
  const channel = project.mixerChannels.find((candidate) => candidate.id === channelId);
  // A gesture counter starts a new undo entry per pointer press; keys inside it keep coalescing.
  const gesture = useRef(0);
  if (!channel) return null;

  const effects = channel.effects.filter((slot): slot is MixerEffectSlot & { type: EffectType } => slot.type !== null);
  const availableTypes = listEffectTypesFor(channel.role === 'master' ? 'master' : 'insert');
  const full = effects.length >= MIXER_EFFECT_SLOT_COUNT;

  function addEffect(type: EffectType) {
    onCommand({ type: 'mixer.effect.add', channelId: channel!.id, effectId: createStableId('fx'), effectType: type });
  }

  return (
    <section aria-label={`Effects for mixer channel ${channel.name}`} className="fx-rack" id="fx-rack">
      <header className="fx-rack-head">
        <span className="fx-rack-title">Effects · {channel.name}</span>
        <span className="fx-rack-count">{effects.length}/{MIXER_EFFECT_SLOT_COUNT}</span>
        <label className="fx-rack-add">
          <span className="sr-only-text">Add an effect to {channel.name}</span>
          <select
            aria-label={`Add effect to ${channel.name}`}
            disabled={full}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              const type = event.currentTarget.value as EffectType;
              event.currentTarget.value = '';
              if (type) addEffect(type);
            }}
            title={full ? `A channel holds at most ${MIXER_EFFECT_SLOT_COUNT} effects` : 'Append an effect to the end of the chain'}
            value=""
          >
            <option value="">{full ? 'Chain full' : '+ Add effect'}</option>
            {availableTypes.map((type) => (
              <option key={type} value={type}>{EFFECT_DEFINITIONS[type].label}</option>
            ))}
          </select>
        </label>
        <button aria-label="Close effects rack" className="button fx-rack-close" onClick={onClose} title="Close the effects rack" type="button">
          <Icon name="close" size={11} />
        </button>
      </header>

      {effects.length === 0 && (
        <p className="fx-rack-empty">
          No effects. Signal passes straight to the fader. Add an effect to shape this channel; changes are heard live and included in export.
        </p>
      )}

      <ol className="fx-chain">
        {effects.map((effect, index) => (
          <EffectCard
            channel={channel}
            effect={effect}
            gesture={gesture}
            index={index}
            key={effect.id}
            count={effects.length}
            onCommand={onCommand}
          />
        ))}
      </ol>

      {channel.role === 'master' && (
        <p className="fx-rack-note">
          The master limiter sits before the master fader. Keep the fader at or below 0 dB for it to protect the output.
        </p>
      )}
    </section>
  );
}

interface EffectCardProps {
  channel: MixerChannel;
  effect: MixerEffectSlot & { type: EffectType };
  index: number;
  count: number;
  gesture: { current: number };
  onCommand: EffectRackProps['onCommand'];
}

function EffectCard({ channel, effect, index, count, gesture, onCommand }: EffectCardProps) {
  const definition = EFFECT_DEFINITIONS[effect.type];

  function beginGesture(repeat = false) {
    if (!repeat) gesture.current += 1;
  }

  function setParam(spec: EffectParamSpec, position: number) {
    const value = quantizeEffectValue(spec, normalizedToEffectValue(spec, position));
    onCommand(
      { type: 'mixer.effect.param.set', channelId: channel.id, effectId: effect.id, key: spec.key, value },
      { coalesceKey: `fx-param:${effect.id}:${spec.key}:${gesture.current}` },
    );
  }

  return (
    <li className={`fx-card ${effect.enabled ? '' : 'fx-card--bypassed'}`.trim()} data-effect-type={effect.type}>
      <div className="fx-card-head">
        <span className="fx-card-title" title={definition.description}>{definition.label}</span>
        <label className="fx-card-toggle">
          <input
            aria-label={`Enable ${definition.label} on ${channel.name}`}
            checked={effect.enabled}
            onChange={(event) => onCommand({ type: 'mixer.effect.enabled.set', channelId: channel.id, effectId: effect.id, enabled: event.currentTarget.checked })}
            type="checkbox"
          />
          <span>{effect.enabled ? 'On' : 'Bypass'}</span>
        </label>
        <button
          aria-label={`Move ${definition.label} earlier on ${channel.name}`}
          className="mixer-order-button"
          disabled={index === 0}
          onClick={() => onCommand({ type: 'mixer.effect.move', channelId: channel.id, effectId: effect.id, toIndex: index - 1 })}
          title="Move earlier in the chain"
          type="button"
        >
          ▲
        </button>
        <button
          aria-label={`Move ${definition.label} later on ${channel.name}`}
          className="mixer-order-button"
          disabled={index === count - 1}
          onClick={() => onCommand({ type: 'mixer.effect.move', channelId: channel.id, effectId: effect.id, toIndex: index + 1 })}
          title="Move later in the chain"
          type="button"
        >
          ▼
        </button>
        <button
          aria-label={`Remove ${definition.label} from ${channel.name}`}
          className="mixer-switch mixer-switch--remove"
          onClick={() => onCommand({ type: 'mixer.effect.remove', channelId: channel.id, effectId: effect.id })}
          title="Remove this effect"
          type="button"
        >
          <Icon name="close" size={11} />
        </button>
      </div>

      <div className="fx-params">
        {definition.params.map((spec) => {
          const value = effect.params[spec.key];
          const readout = formatEffectValue(spec, value);
          const label = `${spec.label} of ${definition.label} on ${channel.name}`;
          return (
            <label className="fx-param" key={spec.key}>
              <span className="fx-param-label">{spec.label}</span>
              <input
                aria-label={label}
                aria-valuetext={readout}
                className="fx-param-input"
                max={1}
                min={0}
                onChange={(event) => setParam(spec, Number(event.currentTarget.value))}
                onDoubleClick={() => setParam(spec, effectValueToNormalized(spec, spec.default))}
                onKeyDown={(event) => beginGesture(event.repeat)}
                onPointerDown={() => beginGesture()}
                step={0.001}
                title={`${readout} · double-click for default`}
                type="range"
                value={effectValueToNormalized(spec, value)}
              />
              <span className="fx-param-value" aria-hidden="true">{readout}</span>
            </label>
          );
        })}
      </div>
    </li>
  );
}
