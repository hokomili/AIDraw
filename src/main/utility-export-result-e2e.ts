import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createPixelDocument, type AIDrawDocument } from '@aidraw/core';
import type { ExportArtifact } from './export-document';
import {
  FND09_EXPORT_RESULT_E2E_HOLD_MS,
  type Fnd09ExportResultFault,
} from './utility-export-result-e2e-contract';

export const FND09_EXPORT_RESULT_E2E_PROFILE_PREFIX = 'aidraw-e2e-fnd09-export-result-';
export const FND09_EXPORT_RESULT_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const FND09_EXPORT_RESULT_E2E_PROBE_FILE = 'fnd09-export-result-probe.json';
export const FND09_EXPORT_RESULT_E2E_NETWORK_SENTINEL_FILE = 'fnd09-export-result-forbidden-network.json';

export interface Fnd09ExportResultE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  probePath: string;
  networkSentinelPath: string;
}

interface Fnd09ExportResultE2eConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  workspacePath: string;
  declaredProfilePath?: string;
  userDataPath?: string;
  connectionPath?: string;
  probePath?: string;
  networkSentinelPath?: string;
}

interface ExportResultLane {
  runE2eExportResultProbe(
    document: AIDrawDocument,
    fault: Fnd09ExportResultFault,
    control?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ExportArtifact>;
  exportDocument(
    document: AIDrawDocument,
    format: 'sprite-sheet',
    options: { scale: number },
    control?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ExportArtifact>;
  status(): { running: boolean; pid?: number; queued: number; activeTaskId?: string };
}

export interface Fnd09ExportResultEngine {
  service: {
    getActiveDocumentId(): string | undefined;
    getDocument(documentId: string): AIDrawDocument | undefined;
  };
  rasterUtilities: ExportResultLane;
}

function normalizedPath(value: string): string {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isNamedDirectChild(parentPath: string, candidatePath: string, expectedName: string): boolean {
  const candidate = resolve(candidatePath);
  return normalizedPath(dirname(candidate)) === normalizedPath(parentPath)
    && basename(candidate).toLowerCase() === expectedName;
}

export function resolveFnd09ExportResultE2eConfiguration(
  input: Fnd09ExportResultE2eConfigurationInput,
): Fnd09ExportResultE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath || !input.probePath || !input.networkSentinelPath) return undefined;
  const retainedRoot = resolve(input.workspacePath, 'test-results', 'retained');
  const profilePath = resolve(input.userDataPath);
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (normalizedPath(dirname(profilePath)) !== normalizedPath(retainedRoot)) return undefined;
  if (!basename(profilePath).toLowerCase().startsWith(FND09_EXPORT_RESULT_E2E_PROFILE_PREFIX)) return undefined;
  if (!isNamedDirectChild(profilePath, input.connectionPath, FND09_EXPORT_RESULT_E2E_CONNECTION_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.probePath, FND09_EXPORT_RESULT_E2E_PROBE_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.networkSentinelPath, FND09_EXPORT_RESULT_E2E_NETWORK_SENTINEL_FILE)) return undefined;
  return {
    profilePath,
    connectionPath: resolve(input.connectionPath),
    probePath: resolve(input.probePath),
    networkSentinelPath: resolve(input.networkSentinelPath),
  };
}

function documentSha256(document: AIDrawDocument): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex').toUpperCase();
}

async function waitForActiveWorker(lane: ExportResultLane, label: string): Promise<{ pid: number; taskId: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = lane.status();
    if (status.running && Number.isInteger(status.pid) && status.activeTaskId) return { pid: status.pid!, taskId: status.activeTaskId };
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`${label} did not become active in the supervised utility process.`);
}

async function rejected(promise: Promise<unknown>, label: string): Promise<{ name: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    return { name: value.name, message: value.message.slice(0, 500) };
  }
  throw new Error(`${label} unexpectedly reached its caller.`);
}

function summarizeRecovery(artifact: ExportArtifact) {
  if (artifact.mimeType !== 'image/png' || artifact.extension !== 'png' || !artifact.data.byteLength) {
    throw new Error('Fresh-worker sprite-sheet export returned an unexpected primary artifact.');
  }
  if (!artifact.companion || artifact.companion.mimeType !== 'application/json' || artifact.companion.extension !== 'json' || !artifact.companion.data.byteLength) {
    throw new Error('Fresh-worker sprite-sheet export returned an unexpected companion artifact.');
  }
  if (artifact.companions?.length || artifact.report.warnings.length || artifact.report.rasterized.length) {
    throw new Error('Fresh-worker sprite-sheet export returned unexpected companions or reports.');
  }
  return {
    primary: {
      bytes: artifact.data.byteLength,
      sha256: createHash('sha256').update(artifact.data).digest('hex').toUpperCase(),
      mimeType: artifact.mimeType,
      extension: artifact.extension,
    },
    companion: {
      bytes: artifact.companion.data.byteLength,
      sha256: createHash('sha256').update(artifact.companion.data).digest('hex').toUpperCase(),
      mimeType: artifact.companion.mimeType,
      extension: artifact.companion.extension,
    },
    warnings: artifact.report.warnings,
    rasterized: artifact.report.rasterized,
  };
}

/**
 * Fixed packaged probe: corrupt a real sprite-sheet export's serialized
 * primary and companion in separate workers, then require already-queued
 * ordinary exports to recover through distinct replacements.
 */
export async function runFnd09ExportResultScenario(
  engine: Fnd09ExportResultEngine,
  configuration: Fnd09ExportResultE2eConfiguration,
): Promise<Record<string, unknown>> {
  const documentId = engine.service.getActiveDocumentId();
  const document = documentId ? engine.service.getDocument(documentId) : undefined;
  if (!documentId || !document) throw new Error('The FND-09 export-result probe requires one active canonical document.');
  const before = { documentId, revision: document.revision, sha256: documentSha256(document) };
  const fixture = createPixelDocument('sprite', 'FND-09 export-result fixture');
  let retained: Record<string, unknown>;
  try {
    const idle = engine.rasterUtilities.status();
    if (idle.running || idle.queued !== 0 || idle.activeTaskId) throw new Error('The export-result probe requires a fresh idle raster utility lane.');

    const runFault = async (fault: Fnd09ExportResultFault, expectedMessage: string) => {
      const corruptTask = engine.rasterUtilities.runE2eExportResultProbe(fixture, fault);
      const corruptWorker = await waitForActiveWorker(engine.rasterUtilities, `The ${fault} export-result probe`);
      const queuedRecovery = engine.rasterUtilities.exportDocument(fixture, 'sprite-sheet', { scale: 1 });
      const error = await rejected(corruptTask, `The ${fault} export-result probe`);
      if (error.message !== expectedMessage) throw new Error(`The ${fault} export-result probe failed at the wrong boundary: ${error.message}`);
      const recovery = summarizeRecovery(await queuedRecovery);
      const after = engine.rasterUtilities.status();
      if (!after.running || !Number.isInteger(after.pid) || after.pid === corruptWorker.pid) {
        throw new Error(`The ${fault} export worker was not replaced before queued recovery completed.`);
      }
      return {
        workerPid: corruptWorker.pid,
        error,
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforeCallerBase64Decode: true,
        exportTargetWritten: false,
        queuedRecovery: { workerPid: after.pid, workerReplaced: true, queued: true, ...recovery },
      };
    };

    const primary = await runFault('primary-base64', 'Raster utility returned a malformed export artifact.');
    const companion = await runFault('companion-base64', 'Raster utility returned a malformed export companion.');
    if (companion.workerPid !== primary.queuedRecovery.workerPid) {
      throw new Error('The companion fault did not begin on the first fresh recovery worker.');
    }
    if (new Set([primary.workerPid, primary.queuedRecovery.workerPid, companion.queuedRecovery.workerPid]).size !== 3) {
      throw new Error('Export-result recovery did not use three distinct worker identities.');
    }
    if (primary.queuedRecovery.primary.sha256 !== companion.queuedRecovery.primary.sha256
      || primary.queuedRecovery.companion.sha256 !== companion.queuedRecovery.companion.sha256) {
      throw new Error('Fresh-worker export recovery was not byte-deterministic.');
    }

    const current = engine.service.getDocument(documentId);
    if (!current) throw new Error('The canonical document disappeared during export-result containment.');
    const after = { documentId, revision: current.revision, sha256: documentSha256(current) };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Export-result containment changed canonical document state.');
    retained = {
      version: 1,
      scenario: 'FND-09 packaged export artifact result containment',
      result: 'passed',
      canonical: { before, after, unchanged: true },
      realExporter: { format: 'sprite-sheet', primary: 'image/png', companion: 'application/json' },
      primary,
      companion,
      fixedInvalidResponseHoldMs: FND09_EXPORT_RESULT_E2E_HOLD_MS,
      workerPidsDistinct: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false },
      filesystem: { exportTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0 },
    };
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    retained = {
      version: 1,
      scenario: 'FND-09 packaged export artifact result containment',
      result: 'failed',
      error: { name: value.name, message: value.message.slice(0, 500) },
      canonical: { before },
      network: { nonLoopbackRequests: 0 },
    };
  }
  await writeFile(configuration.probePath, `${JSON.stringify(retained, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (retained.result !== 'passed') throw new Error(String((retained.error as { message?: string } | undefined)?.message ?? 'FND-09 export-result containment failed.'));
  return retained;
}
