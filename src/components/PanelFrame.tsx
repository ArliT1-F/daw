import type { ReactNode } from 'react';
import { Icon } from './Icon';

interface PanelFrameProps {
  id: string;
  title: string;
  className?: string;
  badge?: string;
  toolbar?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function PanelFrame({
  id,
  title,
  className = '',
  badge,
  toolbar,
  collapsed,
  onToggle,
  children,
}: PanelFrameProps) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={`panel-frame ${collapsed ? 'panel-frame--collapsed' : ''} ${className}`.trim()}
      id={id}
      tabIndex={-1}
    >
      <header className="panel-header">
        <button
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
          className="panel-title-button"
          onClick={onToggle}
          title={`${collapsed ? 'Expand' : 'Collapse'} panel`}
          type="button"
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} />
          <h2 id={`${id}-title`}>{title}</h2>
          {badge && <span className="panel-badge">{badge}</span>}
        </button>
        {!collapsed && toolbar && <div className="panel-toolbar">{toolbar}</div>}
      </header>
      <div className="panel-body" hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
