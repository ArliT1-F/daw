import type { CSSProperties } from 'react';
import type { ProjectCommand } from '../../core/commands';
import { createStableId, type Pattern, type Project } from '../../core/project/model';
import type { TransportState } from '../../core/transport';
import { Icon } from '../../components/Icon';
import { PanelFrame } from '../../components/PanelFrame';

interface ChannelRackProps {
  project: Project;
  pattern: Pattern;
  transport: TransportState;
  collapsed: boolean;
  onToggle: () => void;
  onCommand: (command: ProjectCommand) => void;
}

export function ChannelRack({ project, pattern, transport, collapsed, onToggle, onCommand }: ChannelRackProps) {
  function addChannel() {
    onCommand({
      type: 'channel.add',
      channel: {
        id: createStableId('channel'),
        name: `Channel ${project.channels.length + 1}`,
        kind: 'instrument',
        color: '#7fa8d8',
        mixerChannelId: 'mixer-insert-1',
      },
    });
  }

  const toolbar = (
    <button className="button button--quiet add-channel-button" onClick={addChannel} type="button">
      <Icon name="plus" size={13} /> Add channel
    </button>
  );

  return (
    <PanelFrame
      badge={`${project.channels.length} LANES`}
      className="channel-rack-panel"
      collapsed={collapsed}
      id="panel-channel-rack"
      onToggle={onToggle}
      title="Channel Rack"
      toolbar={toolbar}
    >
      <div className="rack-scroll">
        <div aria-hidden="true" className="rack-grid rack-grid--ruler">
          <div className="rack-channel-heading">CHANNEL</div>
          {Array.from({ length: pattern.lengthSteps }, (_, index) => (
            <div className={`rack-step-number ${index % 4 === 0 ? 'rack-step-number--beat' : ''}`} key={index}>
              {index % 4 === 0 ? String(index + 1).padStart(2, '0') : '·'}
            </div>
          ))}
        </div>
        {project.channels.map((channel) => {
          const steps = pattern.steps[channel.id] ?? [];
          return (
            <div className="rack-grid rack-channel-row" key={channel.id}>
              <div className="rack-channel-info">
                <span className="channel-color-dot" style={{ backgroundColor: channel.color }} />
                <span className="rack-channel-name" title={channel.name}>{channel.name}</span>
                <span className="channel-kind-tag">{channel.kind === 'drum' ? 'DRM' : 'SYN'}</span>
              </div>
              {steps.map((active, index) => (
                <button
                  aria-label={`${active ? 'Disable' : 'Enable'} ${channel.name}, step ${index + 1}`}
                  aria-pressed={active}
                  className={[
                    'rack-step',
                    active ? 'rack-step--active' : '',
                    index % 4 === 0 ? 'rack-step--beat' : '',
                    transport.status === 'playing' && transport.positionStep % pattern.lengthSteps === index ? 'rack-step--playhead' : '',
                  ].filter(Boolean).join(' ')}
                  key={index}
                  onClick={() => onCommand({ type: 'pattern.step.toggle', patternId: pattern.id, channelId: channel.id, step: index })}
                  style={{ '--channel-color': channel.color } as CSSProperties & { '--channel-color': string }}
                  type="button"
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="panel-footnote">
        <span className="footnote-dot" /> Pattern edits are active · sound playback is not implemented
      </div>
    </PanelFrame>
  );
}
