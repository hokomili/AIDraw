import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { AIDrawDocument } from '@aidraw/core';
import type { BatchCloseRequest, BatchDirectoryRequest, BatchExportFormat } from './batch-document-workflows';

export const UX11_BATCH_E2E_PROFILE_PREFIX = 'aidraw-e2e-ux11-batch-';
export const UX11_BATCH_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const UX11_BATCH_E2E_AUDIT_FILE = 'ux11-batch-dialog-audit.json';
export const UX11_BATCH_E2E_NETWORK_SENTINEL_FILE = 'ux11-forbidden-external-request.json';
export const UX11_BATCH_E2E_SAVE_DIRECTORY = 'ux11-saved-documents';
export const UX11_BATCH_E2E_EXPORT_DIRECTORY = 'ux11-batch-exports';
export const UX11_BATCH_E2E_EVIDENCE_FILE = 'ux11-batch-evidence.json';
export const UX11_BATCH_E2E_SCREENSHOTS = [
  'ux11-save-all-result.png',
  'ux11-batch-export-result.png',
  'ux11-close-all-result.png',
] as const;
export const UX11_BATCH_E2E_SHARED_DOCUMENT_NAME = 'UX-11 Shared';
export const UX11_BATCH_E2E_FAILURE_DOCUMENT_NAME = 'UX-11 Export Failure';

export interface Ux11BatchE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  auditPath: string;
  networkSentinelPath: string;
  saveDirectory: string;
  exportDirectory: string;
}

interface Ux11BatchE2eConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  workspacePath: string;
  declaredProfilePath?: string;
  userDataPath?: string;
  connectionPath?: string;
}

interface Ux11BatchAuditEvent {
  kind: 'save-all-directory' | 'batch-export-directory' | 'close-all-confirmation';
  title: string;
  decision: 'cancel' | 'choose-directory' | 'save-all-and-close';
  directory?: string;
  message?: string;
  detail?: string;
  buttons?: string[];
}

function normalizedPath(value: string): string {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isDirectChild(parentPath: string, candidatePath: string): boolean {
  return normalizedPath(dirname(resolve(candidatePath))) === normalizedPath(parentPath);
}

/**
 * Resolves the UX-11 package hook only for one explicit, fresh test-results
 * profile. All writable choices are fixed direct children of that profile.
 */
export function resolveUx11BatchE2eConfiguration(input: Ux11BatchE2eConfigurationInput): Ux11BatchE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath) return undefined;
  const profilePath = resolve(input.userDataPath);
  const testResultsRoot = resolve(input.workspacePath, 'test-results');
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (!isDirectChild(testResultsRoot, profilePath) || !basename(profilePath).toLowerCase().startsWith(UX11_BATCH_E2E_PROFILE_PREFIX)) return undefined;
  if (!isDirectChild(profilePath, input.connectionPath) || basename(input.connectionPath).toLowerCase() !== UX11_BATCH_E2E_CONNECTION_FILE) return undefined;
  return {
    profilePath,
    connectionPath: resolve(input.connectionPath),
    auditPath: resolve(profilePath, UX11_BATCH_E2E_AUDIT_FILE),
    networkSentinelPath: resolve(profilePath, UX11_BATCH_E2E_NETWORK_SENTINEL_FILE),
    saveDirectory: resolve(profilePath, UX11_BATCH_E2E_SAVE_DIRECTORY),
    exportDirectory: resolve(profilePath, UX11_BATCH_E2E_EXPORT_DIRECTORY),
  };
}

/** Blocks any unexpected non-loopback Node fetch while the isolated lifecycle is active. */
export function installUx11BatchE2eNetworkBoundary(configuration: Ux11BatchE2eConfiguration): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return originalFetch(input, init);
    await writeFile(configuration.networkSentinelPath, `${JSON.stringify({
      version: 1,
      fixture: 'ux11-batch-workflows',
      blocked: true,
      protocol: url.protocol,
      hostname: url.hostname,
      externalRequests: 1,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(() => undefined);
    throw new Error('The isolated UX-11 fixture blocked an external request.');
  };
  return () => { globalThis.fetch = originalFetch; };
}

/**
 * Deterministic native-dialog and one-document export-failure observer used by
 * the exact packaged regression. Production calls never instantiate it.
 */
export class Ux11BatchE2eController {
  private readonly events: Ux11BatchAuditEvent[] = [];
  private saveDirectoryRequests = 0;
  private exportDirectoryRequests = 0;
  private closeRequests = 0;
  private auditCreated = false;

  constructor(private readonly configuration: Ux11BatchE2eConfiguration) {}

  private async writeAudit(): Promise<void> {
    const text = `${JSON.stringify({
      version: 1,
      fixture: 'ux11-batch-workflows',
      events: this.events,
      exportFailureDocument: UX11_BATCH_E2E_FAILURE_DOCUMENT_NAME,
      externalRequests: 0,
    }, null, 2)}\n`;
    await writeFile(this.configuration.auditPath, text, {
      ...(this.auditCreated ? {} : { flag: 'wx' }),
      mode: 0o600,
    });
    this.auditCreated = true;
  }

  async selectDirectory(request: BatchDirectoryRequest): Promise<string | undefined> {
    if (request.kind === 'save-all') {
      if (!/^Choose a folder for 3 unsaved drawings$/.test(request.title)) throw new Error('The isolated UX-11 save-folder request did not match the exact three-document contract.');
      this.saveDirectoryRequests += 1;
      if (this.saveDirectoryRequests > 2) throw new Error('The isolated UX-11 save-folder sequence was exhausted.');
      const decision = this.saveDirectoryRequests === 1 ? 'cancel' : 'choose-directory';
      if (decision === 'choose-directory') await mkdir(this.configuration.saveDirectory);
      this.events.push({ kind: 'save-all-directory', title: request.title, decision, ...(decision === 'choose-directory' ? { directory: this.configuration.saveDirectory } : {}) });
      await this.writeAudit();
      return decision === 'choose-directory' ? this.configuration.saveDirectory : undefined;
    }

    if (request.title !== 'Choose a batch export folder') throw new Error('The isolated UX-11 export-folder request did not match the product contract.');
    this.exportDirectoryRequests += 1;
    if (this.exportDirectoryRequests > 2) throw new Error('The isolated UX-11 export-folder sequence was exhausted.');
    const decision = this.exportDirectoryRequests === 1 ? 'cancel' : 'choose-directory';
    if (decision === 'choose-directory') await mkdir(this.configuration.exportDirectory);
    this.events.push({ kind: 'batch-export-directory', title: request.title, decision, ...(decision === 'choose-directory' ? { directory: this.configuration.exportDirectory } : {}) });
    await this.writeAudit();
    return decision === 'choose-directory' ? this.configuration.exportDirectory : undefined;
  }

  async confirmCloseAll(request: BatchCloseRequest): Promise<'save-all' | 'cancel'> {
    const expectedDetail = `• ${UX11_BATCH_E2E_SHARED_DOCUMENT_NAME}\n• ${UX11_BATCH_E2E_SHARED_DOCUMENT_NAME}\n• ${UX11_BATCH_E2E_FAILURE_DOCUMENT_NAME}`;
    if (request.title !== 'Close all drawings'
      || request.message !== '3 drawings have unsaved changes.'
      || request.detail !== expectedDetail
      || JSON.stringify(request.buttons) !== JSON.stringify(['Save all and close', 'Cancel', 'Discard all'])) {
      throw new Error('The isolated UX-11 Close All confirmation did not match the exact actor-neutral three-document contract.');
    }
    this.closeRequests += 1;
    if (this.closeRequests > 2) throw new Error('The isolated UX-11 Close All sequence was exhausted.');
    const decision = this.closeRequests === 1 ? 'cancel' : 'save-all-and-close';
    this.events.push({
      kind: 'close-all-confirmation',
      title: request.title,
      decision,
      message: request.message,
      detail: request.detail,
      buttons: [...request.buttons],
    });
    await this.writeAudit();
    return decision === 'cancel' ? 'cancel' : 'save-all';
  }

  shouldFailExport(document: AIDrawDocument, format: BatchExportFormat): boolean {
    return format === 'png' && document.name === UX11_BATCH_E2E_FAILURE_DOCUMENT_NAME;
  }
}
