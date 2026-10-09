import { PanelFrame } from '../../components/PanelFrame';

interface BrowserPanelProps {
  collapsed: boolean;
  onToggle: () => void;
}

const LIBRARY_SECTIONS = [
  { name: 'Instruments', description: 'Synths & samplers' },
  { name: 'Samples', description: 'One-shots & loops' },
  { name: 'Presets', description: 'Sound libraries' },
  { name: 'Projects', description: 'Local project files' },
];

export function BrowserPanel({ collapsed, onToggle }: BrowserPanelProps) {
  return (
    <aside className={`browser-aside ${collapsed ? 'browser-aside--collapsed' : ''}`}>
      <PanelFrame
        badge="LIBRARY"
        className="browser-panel"
        collapsed={collapsed}
        id="panel-browser"
        onToggle={onToggle}
        title="Browser"
      >
        <div className="browser-content">
          <div className="browser-intro">
            <span className="eyebrow">LOCAL LIBRARY</span>
            <p>Browse the building blocks for your next idea.</p>
          </div>
          <div className="browser-sections">
            {LIBRARY_SECTIONS.map((section, index) => (
              <div aria-disabled="true" className="browser-entry" key={section.name}>
                <span className={`browser-entry-icon browser-entry-icon--${index}`} aria-hidden="true">{['◈', '▤', '✳', '▣'][index]}</span>
                <span className="browser-entry-copy">
                  <span className="browser-entry-name">{section.name}</span>
                  <span className="browser-entry-description">{section.description}</span>
                </span>
                <span className="browser-entry-lock">LATER</span>
              </div>
            ))}
          </div>
          <div className="browser-empty-state">
            <div className="browser-empty-symbol" aria-hidden="true">⌁</div>
            <strong>Asset browser is not implemented</strong>
            <p>Instrument, sample, and preset loading will be added after the audio engine foundation.</p>
          </div>
          <div className="browser-local-note"><span className="status-light status-light--idle" /> No network library or cloud assets</div>
        </div>
      </PanelFrame>
    </aside>
  );
}
