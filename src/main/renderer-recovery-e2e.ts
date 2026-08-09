import { basename, dirname, resolve } from 'node:path';

export const RENDERER_RECOVERY_E2E_PROFILE_PREFIX = 'aidraw-e2e-recovery-';
export const RENDERER_RECOVERY_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const RENDERER_RECOVERY_E2E_DIAGNOSTIC_FILE = 'renderer-recovery-diagnostic.json';
export const MAX_SANITIZED_RENDERER_RECOVERY_EVENT_BYTES = 1_024;

export interface RendererRecoveryE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  diagnosticPath: string;
}

interface RendererRecoveryE2eConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  userDataPath?: string;
  connectionPath?: string;
  diagnosticPath?: string;
}

function normalizedPath(value: string): string {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isNamedDirectChild(profilePath: string, candidatePath: string, expectedName: string): boolean {
  const candidate = resolve(candidatePath);
  return normalizedPath(dirname(candidate)) === normalizedPath(profilePath)
    && basename(candidate).toLowerCase() === expectedName;
}

/**
 * Resolve the packaged renderer-recovery test hook only for a purpose-built,
 * isolated profile. The fixed direct-child paths prevent this hook from being
 * repurposed as a general file writer.
 */
export function resolveRendererRecoveryE2eConfiguration(
  input: RendererRecoveryE2eConfigurationInput,
): RendererRecoveryE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.userDataPath || !input.connectionPath || !input.diagnosticPath) return undefined;
  const profilePath = resolve(input.userDataPath);
  if (!basename(profilePath).toLowerCase().startsWith(RENDERER_RECOVERY_E2E_PROFILE_PREFIX)) return undefined;
  if (!isNamedDirectChild(profilePath, input.connectionPath, RENDERER_RECOVERY_E2E_CONNECTION_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.diagnosticPath, RENDERER_RECOVERY_E2E_DIAGNOSTIC_FILE)) return undefined;
  return {
    profilePath,
    connectionPath: resolve(input.connectionPath),
    diagnosticPath: resolve(input.diagnosticPath),
  };
}

export function sanitizedMalformedRendererRecoveryEvent(): {
  event: Record<string, unknown>;
  byteLength: number;
} {
  const documentId = 'ux05-sanitized-malformed-document';
  const event = {
    type: 'workspace',
    snapshot: {
      documents: [{ id: documentId, name: 'Sanitized recovery probe', kind: 'illustration', dirty: false, revision: 0 }],
      activeDocumentId: documentId,
      // Intentionally invalid. Rendering an illustration requires artboard dimensions.
      activeDocument: { id: documentId, name: 'Sanitized recovery probe', kind: 'illustration', dirty: false, revision: 0, artboard: null },
      jobs: [],
      mcp: { running: true, sessions: [] },
      canUndo: false,
      canRedo: false,
      agentHistories: [],
      checkpoints: [],
    },
  };
  const byteLength = Buffer.byteLength(JSON.stringify(event), 'utf8');
  if (byteLength > MAX_SANITIZED_RENDERER_RECOVERY_EVENT_BYTES) {
    throw new Error('The sanitized renderer recovery event exceeded its fixed size boundary.');
  }
  return { event, byteLength };
}
