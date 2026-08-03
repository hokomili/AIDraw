import { Component, type ErrorInfo, type ReactNode } from 'react';

interface RendererErrorBoundaryProps {
  children: ReactNode;
}

interface RendererErrorBoundaryState {
  error?: Error;
}

export class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('AIDraw renderer recovered from a component failure.', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="renderer-recovery" role="alert">
        <section className="renderer-recovery-card">
          <span className="renderer-recovery-mark" aria-hidden="true">!</span>
          <h1>The editor hit a malformed drawing event</h1>
          <p>Your documents and agent work are still running in AIDraw’s engine. Reload only the editor surface to reconnect safely.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload editor</button>
          <details>
            <summary>Technical detail</summary>
            <code>{this.state.error.message || 'Unknown renderer error'}</code>
          </details>
        </section>
      </main>
    );
  }
}
