import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import {
  MAX_SANITIZED_RENDERER_RECOVERY_EVENT_BYTES,
  RENDERER_RECOVERY_E2E_CONNECTION_FILE,
  RENDERER_RECOVERY_E2E_DIAGNOSTIC_FILE,
  resolveRendererRecoveryE2eConfiguration,
  sanitizedMalformedRendererRecoveryEvent,
} from '@main/renderer-recovery-e2e';

describe('isolated renderer recovery E2E hook', () => {
  const profilePath = resolve('test-results', 'aidraw-e2e-recovery-unit');
  const connectionPath = join(profilePath, RENDERER_RECOVERY_E2E_CONNECTION_FILE);
  const diagnosticPath = join(profilePath, RENDERER_RECOVERY_E2E_DIAGNOSTIC_FILE);
  const valid = { nodeEnv: 'test', enabled: '1', userDataPath: profilePath, connectionPath, diagnosticPath };

  it('requires the exact test environment and direct-child recovery paths', () => {
    expect(resolveRendererRecoveryE2eConfiguration(valid)).toEqual({ profilePath, connectionPath, diagnosticPath });
    expect(resolveRendererRecoveryE2eConfiguration({ ...valid, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveRendererRecoveryE2eConfiguration({ ...valid, enabled: '0' })).toBeUndefined();
    expect(resolveRendererRecoveryE2eConfiguration({ ...valid, userDataPath: resolve('test-results', 'aidraw-e2e-other') })).toBeUndefined();
    expect(resolveRendererRecoveryE2eConfiguration({ ...valid, connectionPath: join(profilePath, 'nested', RENDERER_RECOVERY_E2E_CONNECTION_FILE) })).toBeUndefined();
    expect(resolveRendererRecoveryE2eConfiguration({ ...valid, diagnosticPath: join(profilePath, 'nested', RENDERER_RECOVERY_E2E_DIAGNOSTIC_FILE) })).toBeUndefined();
    expect(resolveRendererRecoveryE2eConfiguration({ ...valid, diagnosticPath: join(profilePath, 'other.json') })).toBeUndefined();
  });

  it('builds one fixed, bounded event with no user or secret-bearing fields', () => {
    const probe = sanitizedMalformedRendererRecoveryEvent();
    const encoded = JSON.stringify(probe.event);
    expect(probe.byteLength).toBe(Buffer.byteLength(encoded, 'utf8'));
    expect(probe.byteLength).toBeLessThanOrEqual(MAX_SANITIZED_RENDERER_RECOVERY_EVENT_BYTES);
    expect(probe.event).toEqual({
      type: 'workspace',
      snapshot: {
        workspaceRevision: Number.MAX_SAFE_INTEGER,
        documents: [{ id: 'ux05-sanitized-malformed-document', name: 'Sanitized recovery probe', kind: 'illustration', dirty: false, revision: 0 }],
        activeDocumentId: 'ux05-sanitized-malformed-document',
        activeDocument: { id: 'ux05-sanitized-malformed-document', name: 'Sanitized recovery probe', kind: 'illustration', dirty: false, revision: 0, artboard: null },
        jobs: [],
        mcp: { running: true, sessions: [] },
        canUndo: false,
        canRedo: false,
        agentHistories: [],
        checkpoints: [],
      },
    });
    for (const sensitiveField of ['assets', 'objects', 'prompt', 'result', 'taskId', 'token', 'credential', 'filePath']) {
      expect(encoded.includes(sensitiveField)).toBe(false);
    }
  });
});
