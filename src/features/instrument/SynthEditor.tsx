import { useRef, type ChangeEvent } from 'react';
import type { ProjectCommand } from '../../core/commands';
import {
  SYNTH_PARAM_RANGES,
  SYNTH_PRESETS,
  SYNTH_WAVEFORMS,
  createChannelSynth,
  parseSynthPreset,
  serializeSynthPreset,
  clampSynthParam,
  type ChannelSynth,
  type SynthParams,
} from '../../core/instruments/synthModel';
import type { Channel } from '../../core/project/model';

interface SynthEditorProps {
  channel: Channel;
  /** Applies an edit; drags share one coalesce key so a whole gesture is one undo step. */
  onCommand: (command: ProjectCommand, options?: { coalesceKey?: string }) => boolean;
  /** Plays a short note through this channel so the user can hear the patch. */
  onAudition: (channelId: string) => void;
  onError: (message: string) => void;
}

const CUTOFF_MIN = SYNTH_PARAM_RANGES.filterCutoffHz.min;
const CUTOFF_MAX = SYNTH_PARAM_RANGES.filterCutoffHz.max;
const CUTOFF_STEPS = 1000;

/** Logarithmic mapping for the filter so the slider spends equal travel on each octave. */
export function cutoffFromSlider(position: number): number {
  return CUTOFF_MIN * (CUTOFF_MAX / CUTOFF_MIN) ** (position / CUTOFF_STEPS);
}

export function sliderFromCutoff(hz: number): number {
  return Math.round((Math.log(hz / CUTOFF_MIN) / Math.log(CUTOFF_MAX / CUTOFF_MIN)) * CUTOFF_STEPS);
}

function formatSeconds(value: number): string {
  return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
}

function formatHz(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz` : `${Math.round(value)} Hz`;
}

const ENVELOPE_CONTROLS = [
  { key: 'attack', step: 0.001, format: formatSeconds },
  { key: 'decay', step: 0.001, format: formatSeconds },
  { key: 'sustain', step: 0.01, format: (value: number) => `${Math.round(value * 100)}%` },
  { key: 'release', step: 0.001, format: formatSeconds },
] as const;

export function SynthEditor({ channel, onCommand, onAudition, onError }: SynthEditorProps) {
  const importRef = useRef<HTMLInputElement>(null);
  const synth: ChannelSynth = channel.synth ?? createChannelSynth();
  const params = synth.params;
  const presetLabel = synth.presetName ?? 'Custom';

  function commitParams(next: SynthParams, presetName: string | null, coalesceKey?: string) {
    onCommand({ type: 'channel.synth.set', channelId: channel.id, synth: { version: synth.version, presetName, params: next } }, { coalesceKey });
  }

  function setParam<K extends keyof SynthParams>(key: K, value: SynthParams[K], coalesceKey = `synth:${channel.id}:${key}`) {
    // Editing any parameter turns a named preset into a custom patch.
    commitParams({ ...params, [key]: value }, null, coalesceKey);
  }

  function setNumber(key: Exclude<keyof SynthParams, 'waveform'>, raw: string) {
    const value = Number(raw);
    setParam(key, clampSynthParam(key, value, params[key]) as never);
  }

  function handleCutoff(raw: string) {
    const hz = cutoffFromSlider(Number(raw));
    setParam('filterCutoffHz', Math.round(hz) as never);
  }

  function handlePresetChange(event: ChangeEvent<HTMLSelectElement>) {
    const preset = SYNTH_PRESETS.find((item) => item.id === event.target.value);
    if (!preset) return;
    commitParams({ ...preset.params }, preset.name);
  }

  function exportPreset() {
    try {
      const text = serializeSynthPreset(presetLabel === 'Custom' ? `${channel.name} patch` : presetLabel, params);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(presetLabel === 'Custom' ? channel.name : presetLabel).replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.gridline-synth.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'The preset could not be exported.');
    }
  }

  async function importPreset(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const preset = parseSynthPreset(await file.text());
      commitParams(preset.params, preset.name);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'The preset file could not be read.');
    }
  }

  const waveformButtons = SYNTH_WAVEFORMS.map((waveform) => (
    <button
      aria-pressed={params.waveform === waveform}
      className={`synth-wave-button ${params.waveform === waveform ? 'synth-wave-button--on' : ''}`}
      key={waveform}
      onClick={() => setParam('waveform', waveform)}
      type="button"
    >
      <span aria-hidden="true" className={`synth-wave-glyph synth-wave-glyph--${waveform}`} />
      {waveform}
    </button>
  ));

  return (
    <div className="synth-editor" aria-label={`Synthesizer for ${channel.name}`} role="group">
      <div className="synth-row">
        <label className="synth-field synth-field--wide">
          <span>PRESET</span>
          <select aria-label="Synth preset" onChange={handlePresetChange} value={synth.presetName ? SYNTH_PRESETS.find((item) => item.name === synth.presetName)?.id ?? '' : ''}>
            {!synth.presetName || !SYNTH_PRESETS.some((item) => item.name === synth.presetName) ? <option value="">Custom</option> : null}
            {SYNTH_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
        </label>
        <button className="button button--quiet" onClick={() => onAudition(channel.id)} title="Play a short note with this patch" type="button">
          Play note
        </button>
      </div>

      <div className="synth-waveforms" role="group" aria-label="Oscillator waveform">
        {waveformButtons}
      </div>

      <div className="synth-grid">
        <label className="synth-field">
          <span>OCTAVE</span>
          <select aria-label="Octave" onChange={(event) => setNumber('octave', event.target.value)} value={params.octave}>
            {[-2, -1, 0, 1, 2].map((value) => (
              <option key={value} value={value}>{value > 0 ? `+${value}` : value}</option>
            ))}
          </select>
        </label>
        <SynthSlider label="Semitone" value={params.semitone} min={SYNTH_PARAM_RANGES.semitone.min} max={SYNTH_PARAM_RANGES.semitone.max} step={1} readout={`${params.semitone > 0 ? '+' : ''}${params.semitone} st`} onChange={(raw) => setNumber('semitone', raw)} />
        <SynthSlider label="Fine tune" value={params.fineCents} min={SYNTH_PARAM_RANGES.fineCents.min} max={SYNTH_PARAM_RANGES.fineCents.max} step={1} readout={`${params.fineCents > 0 ? '+' : ''}${params.fineCents} ct`} onChange={(raw) => setNumber('fineCents', raw)} />
        <SynthSlider label="Tuning (A4)" value={params.tuningHz} min={SYNTH_PARAM_RANGES.tuningHz.min} max={SYNTH_PARAM_RANGES.tuningHz.max} step={1} readout={`${params.tuningHz} Hz`} onChange={(raw) => setNumber('tuningHz', raw)} />
        <SynthSlider label="Detune spread" value={params.spreadCents} min={SYNTH_PARAM_RANGES.spreadCents.min} max={SYNTH_PARAM_RANGES.spreadCents.max} step={1} readout={params.spreadCents === 0 ? 'off' : `±${params.spreadCents} ct`} onChange={(raw) => setNumber('spreadCents', raw)} />
      </div>

      <fieldset className="synth-envelope">
        <legend>AMPLITUDE ENVELOPE</legend>
        {ENVELOPE_CONTROLS.map((control) => {
          const range = SYNTH_PARAM_RANGES[control.key];
          return (
            <SynthSlider
              key={control.key}
              label={range.label}
              value={params[control.key]}
              min={range.min}
              max={range.max}
              step={control.step}
              readout={control.format(params[control.key])}
              onChange={(raw) => setNumber(control.key, raw)}
            />
          );
        })}
      </fieldset>

      <div className="synth-grid">
        <SynthSlider
          label="Filter cutoff"
          value={sliderFromCutoff(params.filterCutoffHz)}
          min={0}
          max={CUTOFF_STEPS}
          step={1}
          readout={formatHz(params.filterCutoffHz)}
          onChange={handleCutoff}
        />
        <SynthSlider label="Resonance" value={params.filterQ} min={SYNTH_PARAM_RANGES.filterQ.min} max={SYNTH_PARAM_RANGES.filterQ.max} step={0.1} readout={params.filterQ.toFixed(1)} onChange={(raw) => setNumber('filterQ', raw)} />
        <SynthSlider label="Level" value={params.level} min={0} max={1} step={0.01} readout={`${Math.round(params.level * 100)}%`} onChange={(raw) => setNumber('level', raw)} />
      </div>

      <div className="synth-actions">
        <button className="button button--quiet" onClick={exportPreset} title="Download this patch as a versioned preset file" type="button">
          Export preset
        </button>
        <button className="button button--quiet" onClick={() => importRef.current?.click()} title="Load a patch from a Gridline synth preset file" type="button">
          Import preset
        </button>
        <input accept=".json,application/json" aria-label="Import synth preset file" className="sr-only-input" onChange={importPreset} ref={importRef} type="file" />
      </div>
    </div>
  );
}

interface SynthSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  readout: string;
  onChange: (raw: string) => void;
}

function SynthSlider({ label, value, min, max, step, readout, onChange }: SynthSliderProps) {
  return (
    <label className="synth-field synth-slider">
      <span className="synth-slider-label">{label.toUpperCase()}</span>
      <input
        aria-label={label}
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.value)}
        step={step}
        type="range"
        value={value}
      />
      <output className="synth-readout">{readout}</output>
    </label>
  );
}
