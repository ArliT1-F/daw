export type ErrorSource = 'audio' | 'project' | 'persistence' | 'application';

export interface AppError {
  source: ErrorSource;
  message: string;
}

/** Shared event-level error formatting keeps audio and project errors consistent in the UI. */
export function createAppError(source: ErrorSource, error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  return { source, message: message || 'An unexpected error occurred.' };
}
