import type { ProjectCommand } from '../../core/commands';
import { createStableId, type Pattern, type Project } from '../../core/project/model';
import { PanelFrame } from '../../components/PanelFrame';
import { getStepsPerBar, type TransportState } from '../../core/transport';

const VISIBLE_BARS = 8;

interface PlaylistProps {
  project: Project;
  pattern: Pattern;
  transport: TransportState;
  collapsed: boolean;
  onToggle: () => void;
  onCommand: (command: ProjectCommand) => void;
}

export function Playlist({ project, pattern, transport, collapsed, onToggle, onCommand }: PlaylistProps) {
  const toolbar = <span className="toolbar-note">8-BAR VIEW</span>;
  const stepsPerBar = getStepsPerBar(project.settings.timeSignature);
  const playheadStep = transport.positionStep % (VISIBLE_BARS * stepsPerBar);

  return (
    <PanelFrame
      badge="ARRANGEMENT"
      className="playlist-panel"
      collapsed={collapsed}
      id="panel-playlist"
      onToggle={onToggle}
      title="Playlist"
      toolbar={toolbar}
    >
      <div className="playlist-scroll">
        <div className="timeline-ruler">
          <div className="timeline-track-label timeline-track-label--heading">TRACK</div>
          <div className="timeline-bars">
            {Array.from({ length: VISIBLE_BARS }, (_, bar) => (
              <div className="timeline-bar-label" key={bar}><span>{String(bar + 1).padStart(2, '0')}</span></div>
            ))}
          </div>
        </div>
        <div className="timeline-track-row">
          <div className="timeline-track-label">
            <span className="timeline-track-color" />
            <span className="timeline-track-name">{pattern.name}</span>
            <span className="timeline-track-kind">PATTERN</span>
          </div>
          <div aria-label={`${pattern.name} arrangement, eight bars`} className="timeline-lane">
            {Array.from({ length: VISIBLE_BARS }, (_, bar) => {
              const occupied = project.playlist.some((clip) => bar >= clip.startBar && bar < clip.startBar + clip.lengthBars);
              return (
                <button
                  aria-label={occupied ? `Bar ${bar + 1} occupied by a clip` : `Place ${pattern.name} clip at bar ${bar + 1}`}
                  className={`timeline-cell ${bar % 2 === 0 ? 'timeline-cell--accent' : ''}`}
                  disabled={occupied}
                  key={bar}
                  onClick={() => onCommand({
                    type: 'playlist.clip.add',
                    clip: { id: createStableId('clip'), patternId: pattern.id, startBar: bar, lengthBars: 1 },
                  })}
                  title={occupied ? 'This bar already contains a clip' : `Add a one-bar clip at bar ${bar + 1}`}
                  type="button"
                />
              );
            })}
            {project.playlist.filter((clip) => clip.startBar < VISIBLE_BARS).map((clip) => {
              const visibleLength = Math.min(clip.lengthBars, VISIBLE_BARS - clip.startBar);
              return (
                <button
                  aria-label={`Remove ${pattern.name} clip at bar ${clip.startBar + 1}`}
                  className="playlist-clip"
                  key={clip.id}
                  onClick={() => onCommand({ type: 'playlist.clip.remove', clipId: clip.id })}
                  style={{
                    left: `calc(${(clip.startBar / VISIBLE_BARS) * 100}% + 3px)`,
                    width: `calc(${(visibleLength / VISIBLE_BARS) * 100}% - 6px)`,
                  }}
                  title="Click to remove this clip"
                  type="button"
                >
                  <span className="clip-waveform" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>
                  <span className="clip-name">{pattern.name}</span>
                  <span className="clip-hint">×</span>
                </button>
              );
            })}
            {transport.status === 'playing' && (
              <div
                aria-hidden="true"
                className="timeline-playhead"
                style={{ left: `${(playheadStep / (VISIBLE_BARS * stepsPerBar)) * 100}%` }}
              />
            )}
          </div>
        </div>
      </div>
      <div className="panel-footnote">Click an empty bar to place a one-bar clip · click a clip to remove it</div>
    </PanelFrame>
  );
}
