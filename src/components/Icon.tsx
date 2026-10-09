import type { ReactNode } from 'react';

export type IconName = 'play' | 'pause' | 'stop' | 'undo' | 'redo' | 'chevron-down' | 'chevron-right' | 'plus' | 'close' | 'audio';

const iconPaths: Record<IconName, ReactNode> = {
  play: <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" stroke="none" />,
  pause: <path d="M8 6v12M16 6v12" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1" fill="currentColor" stroke="none" />,
  undo: <><path d="M9 14 5 10l4-4" /><path d="M5 10h8a6 6 0 0 1 6 6v2" /></>,
  redo: <><path d="m15 14 4-4-4-4" /><path d="M19 10h-8a6 6 0 0 0-6 6v2" /></>,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  audio: <><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></>,
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      {iconPaths[name]}
    </svg>
  );
}
