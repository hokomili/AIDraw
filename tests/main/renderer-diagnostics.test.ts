import { describe, expect, it } from 'vitest';
import { buildRendererDiagnostics } from '@main/renderer-diagnostics';

describe('renderer diagnostics', () => {
  it('keeps recovery reports local and excludes sensitive workspace/job payloads', () => {
    const report = buildRendererDiagnostics({
      appVersion: '0.1.0-alpha.1', platform: 'win32', architecture: 'x64', electronVersion: '43.2.0', engine: { running: true, uiAttached: true, startsAtLogin: false, startAtLoginSupported: true, mode: 'interactive', platform: { id: 'windows', label: 'Windows', credentialProtection: 'Windows DPAPI' }, secureStorageAvailable: true }, timestamp: '2026-08-04T00:00:00.000Z',
      detail: { message: 'Malformed event', stack: 'stack', componentStack: 'component', userAgent: 'AIDraw test' },
      snapshot: { workspaceRevision: 4, documents: [{ id: 'doc', name: 'Poster', kind: 'illustration', revision: 4, dirty: true }], activeDocumentId: 'doc', activeDocument: { assets: { secret: { data: 'PRIVATE-ARTWORK' } } } as never, jobs: [{ id: 'job', kind: 'generation', status: 'failed', actor: { id: 'agent', kind: 'agent', name: 'Luna', color: '#fff', client: { model: 'luna', reasoningEffort: 'high', taskId: 'private-task' } }, createdAt: '', updatedAt: '', progress: 0, message: 'PRIVATE-PROMPT', result: { prompt: 'PRIVATE-PROMPT', credential: 'PRIVATE-KEY' }, approval: { title: 'PRIVATE-APPROVAL', description: '', expiresAt: '', options: ['deny'] } }], mcp: { running: true, port: 49152, tokenHint: 'PRIVATE-TOKEN', sessions: [] }, canUndo: false, canRedo: false, agentHistories: [], checkpoints: [] },
    });
    const encoded = JSON.stringify(report); expect(report).toMatchObject({ localOnly: true, workspace: { activeDocumentId: 'doc', mcp: { running: true, port: 49152, sessionCount: 0 } } });
    for (const secret of ['PRIVATE-ARTWORK', 'PRIVATE-PROMPT', 'PRIVATE-KEY', 'PRIVATE-APPROVAL', 'PRIVATE-TOKEN', 'private-task']) expect(encoded).not.toContain(secret);
  });
});
