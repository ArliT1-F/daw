import type { AppError } from '../core/errors';
import { Icon } from './Icon';

interface ErrorNoticeProps {
  error: AppError;
  onDismiss: () => void;
}

export function ErrorNotice({ error, onDismiss }: ErrorNoticeProps) {
  return (
    <div className="error-notice" role="alert">
      <span className="error-notice__tag">{error.source}</span>
      <span>{error.message}</span>
      <button aria-label="Dismiss error" className="icon-button error-notice__dismiss" onClick={onDismiss} type="button">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
