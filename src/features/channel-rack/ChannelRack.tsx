import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type { ProjectCommand } from '../../core/commands';
import { createEmptyChannel, createEmptyPattern } from '../../core/commands';
import { DEFAULT_STEP_VELOCITY, createStableId, type Pattern, type Project } from '../../core/project/model';
import type { TransportState } from '../../core/transport';
import { Icon } from '../../components/Icon';
import { PanelFrame } from '../../components/PanelFrame';

/** Runtime loading state for the sample assigned to a channel. Never part of the project. */
export interface ChannelSampleStatus {
  status: 'loading' | 'ready' | 'error';
  name?: string;
  message?: string;
}

interface ChannelRackProps {
  project: Project;
  pattern: Pattern;
  selectedPatternId: string;
  onSelectPattern: (patternId: string) => void;
  transport: TransportState;
  /** True only while the audio engine's transport is genuinely playing scheduled audio. */
  playbackActive: boolean;
  /** Channels with a scheduled event at each step index of the displayed pattern. */
  activityAtStep: Map<number, Set<string>>;
  sampleStatus: Record<string, ChannelSampleStatus>;
  collapsed: boolean;
  onToggle: () => void;
  /** Applies a project edit; returns false when the edit was rejected. */
  onCommand: (command: ProjectCommand) => boolean;
  onLoadSample: (channelId: string, file: File) => void;
  onDismissSampleError: (channelId: string) => void;
  onPreviewChannel: (channelId: string) => void;
}

const CHANNEL_COLORS = ['#7fa8d8', '#c9a26a', '#b98bd9', '#6fc3a8', '#d88b8b', '#9fc36f'];
const VELOCITY_STEP = 0.05;

function clampVelocity(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

export function ChannelRack({
  project,
  pattern,
  selectedPatternId,
  onSelectPattern,
  transport,
  playbackActive,
  activityAtStep,
  sampleStatus,
  collapsed,
  onToggle,
  onCommand,
  onLoadSample,
  onDismissSampleError,
  onPreviewChannel,
}: ChannelRackProps) {
  const [velocityMode, setVelocityMode] = useState(false);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [patternNameDraft, setPatternNameDraft] = useState<string | null>(null);
  const [swingDraft, setSwingDraft] = useState<number | null>(null);
  const [dragOverChannelId, setDragOverChannelId] = useState<string | null>(null);
  const paintingRef = useRef(false);

  // Velocity painting ends on any pointer release, wherever it happens.
  useEffect(() => {
    const stopPainting = () => {
      paintingRef.current = false;
    };
    window.addEventListener('pointerup', stopPainting);
    window.addEventListener('pointercancel', stopPainting);
    return () => {
      window.removeEventListener('pointerup', stopPainting);
      window.removeEventListener('pointercancel', stopPainting);
    };
  }, []);

  const lengthSteps = pattern.lengthSteps;
  const swingPercent = Math.round((swingDraft ?? project.settings.swing ?? 0) * 100);
  const currentStep = playbackActive ? Math.floor(transport.positionStep) % lengthSteps : -1;
  const anySolo = project.channels.some((channel) => channel.solo);
  const anySampleLoading = project.channels.some((channel) => sampleStatus[channel.id]?.status === 'loading');

  // One shared grid template so the ruler and every row line up at any step count and zoom level.
  const gridStyle = {
    gridTemplateColumns: `minmax(200px, 240px) repeat(${lengthSteps}, minmax(var(--step-min, 17px), 1fr))`,
    minWidth: `calc(200px + ${lengthSteps} * (var(--step-min, 17px) + 4px))`,
  } satisfies CSSProperties;

  function channelName(channelId: string): string {
    return project.channels.find((channel) => channel.id === channelId)?.name ?? channelId;
  }

  function commitChannelName(channelId: string) {
    const draft = nameDrafts[channelId];
    if (draft === undefined) return;
    const current = channelName(channelId);
    if (draft.trim() && draft !== current) {
      onCommand({ type: 'channel.rename', channelId, name: draft });
    }
    clearChannelDraft(channelId);
  }

  function clearChannelDraft(channelId: string) {
    setNameDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== channelId)));
  }

  function commitPatternName() {
    if (patternNameDraft === null) return;
    if (patternNameDraft.trim() && patternNameDraft !== pattern.name) {
      onCommand({ type: 'pattern.rename', patternId: pattern.id, name: patternNameDraft });
    }
    setPatternNameDraft(null);
  }

  function commitSwing() {
    if (swingDraft === null) return;
    onCommand({ type: 'project.swing.set', swing: swingDraft });
    setSwingDraft(null);
  }

  function handleNameKeyDown(event: ReactKeyboardEvent<HTMLInputElement>, commit: () => void, reset: () => void) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      reset();
      event.currentTarget.blur();
    }
  }

  function addChannel() {
    const index = project.channels.length;
    onCommand({
      type: 'channel.add',
      channel: createEmptyChannel(
        createStableId('channel'),
        `Channel ${index + 1}`,
        CHANNEL_COLORS[index % CHANNEL_COLORS.length],
        'mixer-insert-1',
        'drum',
      ),
    });
  }

  function addPattern() {
    const id = createStableId('pattern');
    const name = `Pattern ${String(project.patterns.length + 1).padStart(2, '0')}`;
    if (onCommand({ type: 'pattern.add', pattern: createEmptyPattern(id, name, project.channels) })) {
      onSelectPattern(id);
    }
  }

  function duplicatePattern() {
    const id = createStableId('pattern');
    if (onCommand({ type: 'pattern.duplicate', patternId: pattern.id, newPatternId: id })) {
      onSelectPattern(id);
    }
  }

  function setStepVelocity(rowIndex: string, step: number, velocity: number) {
    onCommand({ type: 'pattern.step.set', patternId: pattern.id, channelId: rowIndex, step, active: true, velocity: clampVelocity(velocity) });
  }

  function velocityFromPointer(event: { clientY: number; currentTarget: Element }): number {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = 1 - (event.clientY - rect.top) / Math.max(1, rect.height);
    return clampVelocity(Math.max(0.1, ratio));
  }

  function handleStepClick(channelId: string, index: number, active: boolean, velocity: number, event: ReactMouseEvent<HTMLButtonElement>) {
    if (velocityMode) {
      // pointerdown already painted this cell for pointer gestures; keyboard activation
      // (detail === 0) falls through to the normal toggle so Enter/Space still works.
      if (event.detail > 0) return;
      onCommand({ type: 'pattern.step.set', patternId: pattern.id, channelId, step: index, active: !active, velocity });
      return;
    }
    onCommand({
      type: 'pattern.step.set',
      patternId: pattern.id,
      channelId,
      step: index,
      active: !active,
      velocity: active ? velocity : velocity || DEFAULT_STEP_VELOCITY,
    });
  }

  function handleStepKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, channelId: string, index: number, active: boolean, velocity: number) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (!active) return;
      event.preventDefault();
      const fine = event.shiftKey;
      const delta = event.key === 'ArrowUp' ? (fine ? 0.01 : VELOCITY_STEP) : fine ? -0.01 : -VELOCITY_STEP;
      setStepVelocity(channelId, index, clampVelocity(velocity + delta));
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && active) {
      event.preventDefault();
      onCommand({ type: 'pattern.step.set', patternId: pattern.id, channelId, step: index, active: false });
    }
  }

  function handleStepWheel(event: ReactWheelEvent<HTMLButtonElement>, channelId: string, index: number, active: boolean, velocity: number) {
    if (!active) return;
    event.preventDefault();
    const amount = event.deltaY < 0 ? VELOCITY_STEP : -VELOCITY_STEP;
    setStepVelocity(channelId, index, clampVelocity(velocity + amount));
  }

  function handleDrop(channelId: string, event: ReactDragEvent) {
    event.preventDefault();
    setDragOverChannelId(null);
    const file = event.dataTransfer?.files?.[0];
    if (file) onLoadSample(channelId, file);
  }

  const toolbar = (
    <div className="rack-toolbar">
      <label className="inline-select-label">
        <span>PATTERN</span>
        <select
          aria-label="Selected pattern"
          onChange={(event) => onSelectPattern(event.target.value)}
          value={selectedPatternId}
        >
          {project.patterns.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
      </label>
      <input
        aria-label="Pattern name"
        className="rack-pattern-name"
        maxLength={80}
        onBlur={commitPatternName}
        onChange={(event) => setPatternNameDraft(event.target.value)}
        onKeyDown={(event) => handleNameKeyDown(event, commitPatternName, () => setPatternNameDraft(null))}
        value={patternNameDraft ?? pattern.name}
      />
      <button aria-label="Duplicate current pattern" className="button" onClick={duplicatePattern} title="Duplicate this pattern with a new ID" type="button">
        Duplicate
      </button>
      <button
        aria-label="Clear current pattern"
        className="button"
        onClick={() => onCommand({ type: 'pattern.clear', patternId: pattern.id })}
        title="Remove every step and note from this pattern"
        type="button"
      >
        Clear
      </button>
      <button aria-label="Add a new pattern" className="button" onClick={addPattern} title="Create an empty pattern" type="button">
        <Icon name="plus" size={12} /> New
      </button>
      <button aria-label="Add channel" className="button button--quiet add-channel-button" onClick={addChannel} type="button">
        <Icon name="plus" size={13} /> Add channel
      </button>
    </div>
  );

  return (
    <PanelFrame
      badge={`${project.channels.length} CH · ${lengthSteps} STEPS`}
      className="channel-rack-panel"
      collapsed={collapsed}
      id="panel-channel-rack"
      onToggle={onToggle}
      title="Channel Rack"
      toolbar={toolbar}
    >
      <div className="rack-subtoolbar">
        <label className="rack-swing" title="Delay offbeat steps for a shuffle feel">
          <span className="rack-subtoolbar-label">SWING</span>
          <input
            aria-label="Swing amount percent"
            max={100}
            min={0}
            onBlur={commitSwing}
            onChange={(event) => setSwingDraft(Number(event.target.value) / 100)}
            onPointerUp={commitSwing}
            onKeyUp={(event) => {
              if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') commitSwing();
            }}
            step={1}
            type="range"
            value={swingPercent}
          />
          <span className="rack-swing-value">{swingPercent}%</span>
        </label>
        <button
          aria-label={`Pattern length is ${lengthSteps} steps. Switch to ${lengthSteps === 16 ? 32 : 16} steps`}
          aria-pressed={lengthSteps === 32}
          className="button rack-length-button"
          onClick={() =>
            onCommand({ type: 'pattern.length.set', patternId: pattern.id, lengthSteps: lengthSteps === 16 ? 32 : 16 })
          }
          title="Toggle the sequencer between 16 and 32 steps"
          type="button"
        >
          {lengthSteps} STEPS
        </button>
        <button
          aria-label={velocityMode ? 'Velocity editing mode is on' : 'Velocity editing mode is off'}
          aria-pressed={velocityMode}
          className={`button rack-mode-button ${velocityMode ? 'rack-mode-button--on' : ''}`}
          onClick={() => setVelocityMode((current) => !current)}
          title="In velocity mode, tap or drag on steps to set how hard they hit"
          type="button"
        >
          {velocityMode ? 'VEL' : 'STEP'} MODE
        </button>
        <span className="rack-subtoolbar-hint">
          {velocityMode ? 'Tap steps to set velocity' : 'Click toggles · wheel/arrows adjust velocity'}
        </span>
      </div>

      <div className="rack-scroll">
        <div aria-hidden="true" className="rack-grid rack-grid--ruler" style={gridStyle}>
          <div className="rack-channel-heading">CHANNEL</div>
          {Array.from({ length: lengthSteps }, (_, index) => (
            <div
              className={`rack-step-number ${index % 4 === 0 ? 'rack-step-number--beat' : ''} ${index === currentStep ? 'rack-step-number--playhead' : ''}`}
              key={index}
            >
              {index % 4 === 0 ? String(index + 1).padStart(2, '0') : '·'}
            </div>
          ))}
        </div>

        {project.channels.map((channel) => {
          const steps = pattern.steps[channel.id] ?? [];
          const velocities = pattern.velocities[channel.id] ?? [];
          const status = sampleStatus[channel.id];
          const audible = !channel.muted && (!anySolo || channel.solo);
          const activity = playbackActive && audible && (activityAtStep.get(currentStep)?.has(channel.id) ?? false);
          const isDropTarget = dragOverChannelId === channel.id;
          return (
            <div
              className={`rack-channel-block ${isDropTarget ? 'rack-channel-block--drop' : ''} ${audible ? '' : 'rack-channel-block--silent'}`}
              key={channel.id}
              onDragLeave={() => setDragOverChannelId((current) => (current === channel.id ? null : current))}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverChannelId(channel.id);
              }}
              onDrop={(event) => handleDrop(channel.id, event)}
            >
              <div className="rack-grid rack-channel-row" style={gridStyle}>
                <div className="rack-channel-info">
                  <button
                    aria-label={`${channel.muted ? 'Unmute' : 'Mute'} ${channel.name}`}
                    aria-pressed={channel.muted}
                    className={`rack-audit-button ${channel.muted ? 'rack-audit-button--muted' : ''}`}
                    onClick={() => onCommand({ type: 'channel.mute.set', channelId: channel.id, muted: !channel.muted })}
                    title={channel.muted ? 'Unmute channel' : 'Mute channel'}
                    type="button"
                  >
                    M
                  </button>
                  <button
                    aria-label={`${channel.solo ? 'Unsolo' : 'Solo'} ${channel.name}`}
                    aria-pressed={channel.solo}
                    className={`rack-audit-button ${channel.solo ? 'rack-audit-button--solo' : ''}`}
                    onClick={() => onCommand({ type: 'channel.solo.set', channelId: channel.id, solo: !channel.solo })}
                    title={channel.solo ? 'Unsolo channel' : 'Solo channel'}
                    type="button"
                  >
                    S
                  </button>
                  <span className="channel-color-dot" style={{ backgroundColor: channel.color }} />
                  <input
                    aria-label={`Name of ${channel.name}`}
                    className="rack-channel-name-input"
                    maxLength={80}
                    onBlur={() => commitChannelName(channel.id)}
                    onChange={(event) => setNameDrafts((current) => ({ ...current, [channel.id]: event.target.value }))}
                    onKeyDown={(event) =>
                      handleNameKeyDown(
                        event,
                        () => commitChannelName(channel.id),
                        () => clearChannelDraft(channel.id),
                      )
                    }
                    value={nameDrafts[channel.id] ?? channel.name}
                  />
                  {status?.status === 'loading' ? (
                    <span aria-live="polite" className="rack-sample-chip rack-sample-chip--loading">
                      <span className="rack-sample-name">LOADING…</span>
                    </span>
                  ) : channel.sampleName ? (
                    <span className="rack-sample-chip" title={channel.sampleName}>
                      <span className="rack-sample-name">{channel.sampleName}</span>
                      <button
                        aria-label={`Remove loaded sample from ${channel.name}`}
                        className="rack-sample-clear"
                        onClick={() => {
                          onCommand({ type: 'channel.sample.clear', channelId: channel.id });
                          onDismissSampleError(channel.id);
                        }}
                        title="Return to the built-in voice"
                        type="button"
                      >
                        <Icon name="close" size={9} />
                      </button>
                    </span>
                  ) : (
                    <span className="channel-kind-tag">{channel.kind === 'drum' ? 'DRM' : 'SYN'}</span>
                  )}
                  <button
                    aria-label={`Preview ${channel.name}`}
                    className="rack-preview-button"
                    disabled={status?.status === 'loading'}
                    onClick={() => onPreviewChannel(channel.id)}
                    title={`Play ${channel.sampleName ?? `${channel.name} once`}`}
                    type="button"
                  >
                    <Icon name="play" size={10} />
                  </button>
                  <label className="rack-load-label" title={`Load an audio sample into ${channel.name}`}>
                    <span className="sr-only-text">
                      <input
                        aria-label={`Load an audio sample into ${channel.name}`}
                        accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.opus,.webm,.aif,.aiff"
                        disabled={status?.status === 'loading'}
                        onChange={(event) => {
                          const input = event.currentTarget;
                          const file = input.files?.[0];
                          if (file) onLoadSample(channel.id, file);
                          input.value = '';
                        }}
                        type="file"
                      />
                    </span>
                    <span aria-hidden="true" className="rack-load-text">LOAD</span>
                  </label>
                  <span
                    aria-hidden="true"
                    className={`rack-led ${activity ? 'rack-led--on' : ''}`}
                    style={{ backgroundColor: activity ? channel.color : undefined }}
                    title={activity ? `${channel.name} is playing` : 'Activity light'}
                  />
                </div>
                {steps.map((active, index) => {
                  const velocity = velocities[index] ?? DEFAULT_STEP_VELOCITY;
                  return (
                    <button
                      aria-label={`${channel.name} step ${index + 1}${active ? `, on, velocity ${Math.round(velocity * 100)} percent` : ', off'}`}
                      aria-pressed={active}
                      className={[
                        'rack-step',
                        active ? 'rack-step--active' : '',
                        index % 4 === 0 ? 'rack-step--beat' : '',
                        index === currentStep ? 'rack-step--playhead' : '',
                      ].filter(Boolean).join(' ')}
                      data-velocity={active ? String(Math.round(velocity * 100)) : undefined}
                      key={index}
                      onClick={(event) => handleStepClick(channel.id, index, active, velocity, event)}
                      onKeyDown={(event) => handleStepKeyDown(event, channel.id, index, active, velocity)}
                      onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
                        if (!velocityMode) return;
                        paintingRef.current = true;
                        setStepVelocity(channel.id, index, velocityFromPointer(event));
                      }}
                      onPointerEnter={(event: ReactPointerEvent<HTMLButtonElement>) => {
                        if (velocityMode && paintingRef.current && event.buttons > 0) {
                          setStepVelocity(channel.id, index, velocityFromPointer(event));
                        }
                      }}
                      onWheel={(event) => handleStepWheel(event, channel.id, index, active, velocity)}
                      style={{ '--channel-color': channel.color } as CSSProperties & { '--channel-color': string }}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="rack-step-fill"
                        style={{ height: active ? `${Math.round(velocity * 100)}%` : '0%' }}
                      />
                    </button>
                  );
                })}
              </div>
              {status?.status === 'error' && status.message ? (
                <div className="rack-row-error" role="alert">
                  <span className="rack-row-error-text">{status.message}</span>
                  <button
                    aria-label={`Dismiss sample error for ${channel.name}`}
                    className="rack-row-error-dismiss"
                    onClick={() => onDismissSampleError(channel.id)}
                    type="button"
                  >
                    <Icon name="close" size={10} />
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="panel-footnote">
        <span className="footnote-dot" />
        {anySampleLoading
          ? 'Decoding sample… playback keeps running from the scheduler'
          : 'Steps play on the audio clock · drop audio files onto a row to load samples · M/S mix the pattern'}
      </div>
    </PanelFrame>
  );
}
