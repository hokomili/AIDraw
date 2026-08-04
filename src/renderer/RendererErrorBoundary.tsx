import { Component, type ErrorInfo, type ReactNode } from 'react';

interface RendererErrorBoundaryProps {
  children: ReactNode;
}

interface RendererErrorBoundaryState {
  error?: Error;
  componentStack?: string;
  diagnosticStatus?: string;
}

export class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('AIDraw renderer recovered from a component failure.', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="renderer-recovery" role="alert">
        <section className="renderer-recovery-card">
          <span className="renderer-recovery-mark" aria-hidden="true">!</span>
          <h1>The editor hit a malformed drawing event</h1>
          <p>Your documents and agent work are still running in AIDraw’s engine. Reload only the editor surface to reconnect safely.</p>
          <div className="renderer-recovery-actions">
            <button type="button" onClick={() => window.location.reload()}>Reload editor</button>
            <button type="button" onClick={() => void window.aidraw.exportRendererDiagnostics({ message: this.state.error?.message || 'Unknown renderer error', stack: this.state.error?.stack, componentStack: this.state.componentStack, userAgent: navigator.userAgent }).then((result) => this.setState({ diagnosticStatus: result.saved ? `Saved locally to ${result.filePath}` : 'Diagnostic export cancelled.' }), (error) => this.setState({ diagnosticStatus: error instanceof Error ? error.message : String(error) }))}>Save diagnostics…</button>
          </div>
          {this.state.diagnosticStatus && <p role="status">{this.state.diagnosticStatus}</p>}
          <details>
            <summary>Technical detail</summary>
            <code>{this.state.error.message || 'Unknown renderer error'}</code>
          </details>
        </section>
      </main>
    );
  }
}
