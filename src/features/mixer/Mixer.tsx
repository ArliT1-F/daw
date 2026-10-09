import type { Project } from '../../core/project/model';
import { PanelFrame } from '../../components/PanelFrame';

interface MixerProps {
  project: Project;
  collapsed: boolean;
  onToggle: () => void;
}

export function Mixer({ project, collapsed, onToggle }: MixerProps) {
  return (
    <PanelFrame
      badge="ROUTING NOT IMPLEMENTED"
      className="mixer-panel"
      collapsed={collapsed}
      id="panel-mixer"
      onToggle={onToggle}
      title="Mixer"
    >
      <div className="mixer-scroll">
        {project.mixerChannels.map((channel, index) => (
          <div className={`mixer-strip ${channel.role === 'master' ? 'mixer-strip--master' : ''}`} key={channel.id}>
            <div className="mixer-strip-index">{channel.role === 'master' ? 'M' : String(index).padStart(2, '0')}</div>
            <div className="mixer-strip-name" title={channel.name}>{channel.name}</div>
            <div aria-hidden="true" className="meter-placeholder">
              <span /><span /><span /><span /><span /><span /><span /><span />
            </div>
            <span className="mixer-db">— dB</span>
            <span className="mixer-strip-status">NO SIGNAL</span>
          </div>
        ))}
        <div className="mixer-deferred-note">
          <span className="deferred-indicator" />
          <span>Faders, metering &amp; signal routing arrive with the audio engine</span>
        </div>
      </div>
    </PanelFrame>
  );
}
