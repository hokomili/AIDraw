import type { EngineStatus, WorkspaceSnapshot } from '../common/contracts';

export interface RendererFailureDetail {
  message: string;
  stack?: string;
  componentStack?: string;
  userAgent?: string;
}

function bounded(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.slice(0, maximum);
}

export function buildRendererDiagnostics(input: {
  appVersion: string;
  platform: string;
  architecture: string;
  electronVersion: string;
  engine: EngineStatus;
  snapshot: WorkspaceSnapshot;
  detail: RendererFailureDetail;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    format: 'aidraw-renderer-diagnostic',
    version: 1,
    localOnly: true,
    timestamp: input.timestamp ?? new Date().toISOString(),
    runtime: { appVersion: input.appVersion, platform: input.platform, architecture: input.architecture, electronVersion: input.electronVersion },
    renderer: {
      message: bounded(input.detail.message, 4_096) ?? 'Unknown renderer error',
      stack: bounded(input.detail.stack, 32_768),
      componentStack: bounded(input.detail.componentStack, 32_768),
      userAgent: bounded(input.detail.userAgent, 1_024),
    },
    engine: input.engine,
    workspace: {
      activeDocumentId: input.snapshot.activeDocumentId,
      documents: input.snapshot.documents.map((document) => ({ id: document.id, name: document.name, kind: document.kind, revision: document.revision, dirty: document.dirty })),
      jobs: input.snapshot.jobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status, actor: { kind: job.actor.kind, name: job.actor.name, model: job.actor.client?.model, reasoningEffort: job.actor.client?.reasoningEffort }, progress: job.progress, error: job.error ? { code: job.error.code, retryable: job.error.retryable } : undefined })),
      mcp: { running: input.snapshot.mcp.running, port: input.snapshot.mcp.port, sessionCount: input.snapshot.mcp.sessions.length },
      checkpointCount: input.snapshot.checkpoints.length,
    },
  };
}
