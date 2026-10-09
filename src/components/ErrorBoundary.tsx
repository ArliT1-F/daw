import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Gridline Audio application error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal-error" role="alert">
          <div className="fatal-error-mark">!</div>
          <p className="eyebrow">APPLICATION ERROR</p>
          <h1>The studio could not render.</h1>
          <p>{this.state.error.message || 'An unexpected error occurred.'}</p>
          <button className="button button--primary" onClick={() => window.location.reload()} type="button">
            Reload studio
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
