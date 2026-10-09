import type { ProjectCommand } from '../../core/commands';
import { createStableId, type Pattern, type Project } from '../../core/project/model';
import type { TransportState } from '../../core/transport';
import { PanelFrame } from '../../components/PanelFrame';

const PITCH_CLASSES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const PITCHES = Array.from({ length: 12 }, (_, index) => 71 - index);

function pitchLabel(pitch: number): string {
  return `${PITCH_CLASSES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

interface PianoRollProps {
  project: Project;
  pattern: Pattern;
  selectedChannelId: string;
  onSelectChannel: (channelId: string) => void;
  transport: TransportState;
  collapsed: boolean;
  onToggle: () => void;
  onCommand: (command: ProjectCommand) => void;
}

export function PianoRoll({
  project,
  pattern,
  selectedChannelId,
  onSelectChannel,
  transport,
  collapsed,
  onToggle,
  onCommand,
}: PianoRollProps) {
  const notes = pattern.notes[selectedChannelId] ?? [];
  const toolbar = (
    <label className="inline-select-label">
      <span>LANE</span>
      <select aria-label="Piano roll channel" onChange={(event) => onSelectChannel(event.target.value)} value={selectedChannelId}>
        {project.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
      </select>
    </label>
  );

  function toggleNote(pitch: number, step: number) {
    const existing = notes.find((note) =>
      note.pitch === pitch && step >= note.startStep && step < note.startStep + note.durationSteps,
    );
    const note = existing ?? {
      id: createStableId('note'),
      pitch,
      startStep: step,
      durationSteps: 1,
      velocity: 0.8,
    };
    onCommand({ type: 'pattern.note.toggle', patternId: pattern.id, channelId: selectedChannelId, note });
  }

  return (
    <PanelFrame
      badge={`${notes.length} NOTES`}
      className="piano-roll-panel"
      collapsed={collapsed}
      id="panel-piano-roll"
      onToggle={onToggle}
      title="Piano Roll"
      toolbar={toolbar}
    >
      <div className="piano-roll-scroll">
        <div className="piano-grid">
          <div aria-hidden="true" className="piano-ruler-row">
            <span className="piano-key-heading">PITCH</span>
            {Array.from({ length: pattern.lengthSteps }, (_, index) => (
              <span className={index % 4 === 0 ? 'piano-ruler-beat' : ''} key={index}>
                {index % 4 === 0 ? String(index + 1).padStart(2, '0') : ''}
              </span>
            ))}
          </div>
          {PITCHES.map((pitch) => {
            const label = pitchLabel(pitch);
            const isC = pitch % 12 === 0;
            const isBlackKey = [1, 3, 6, 8, 10].includes(pitch % 12);
            return (
              <div className={`piano-row ${isC ? 'piano-row--c' : ''}`} key={pitch}>
                <span className={`piano-key ${isBlackKey ? 'piano-key--black' : ''} ${isC ? 'piano-key--c' : ''}`}>
                  {label}
                </span>
                {Array.from({ length: pattern.lengthSteps }, (_, step) => {
                  const note = notes.find((item) =>
                    item.pitch === pitch && step >= item.startStep && step < item.startStep + item.durationSteps,
                  );
                  const atPlayhead = transport.status === 'playing' && transport.positionStep % pattern.lengthSteps === step;
                  return (
                    <button
                      aria-label={`${note ? 'Remove note on' : 'Add note on'} ${label}, step ${step + 1}`}
                      aria-pressed={Boolean(note)}
                      className={[
                        'piano-cell',
                        step % 4 === 0 ? 'piano-cell--beat' : '',
                        isBlackKey ? 'piano-cell--black-row' : '',
                        note ? 'piano-cell--note' : '',
                        atPlayhead ? 'piano-cell--playhead' : '',
                      ].filter(Boolean).join(' ')}
                      key={step}
                      onClick={() => toggleNote(pitch, step)}
                      type="button"
                    >
                      {note && <span className="piano-note-mark" />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="panel-footnote">Click a grid cell to add or remove a one-step note · velocity editing is deferred</div>
    </PanelFrame>
  );
}
