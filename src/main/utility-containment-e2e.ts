import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { AIDrawDocument } from '@aidraw/core';
import type { ExportArtifact } from './export-document';

export const FND09_UTILITY_E2E_PROFILE_PREFIX = 'aidraw-e2e-fnd09-utility-containment-';
export const FND09_UTILITY_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const FND09_UTILITY_E2E_PROBE_FILE = 'fnd09-utility-containment-probe.json';
export const FND09_UTILITY_E2E_NETWORK_SENTINEL_FILE = 'fnd09-forbidden-network.json';

export interface Fnd09UtilityContainmentE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  probePath: string;
  networkSentinelPath: string;
}

interface Fnd09UtilityContainmentE2eConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  workspacePath: string;
  declaredProfilePath?: string;
  userDataPath?: string;
  connectionPath?: string;
  probePath?: string;
  networkSentinelPath?: string;
}

interface ContainmentLane {
  runE2eContainmentProbe(mode: 'crash' | 'hang', control?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  exportDocument(document: AIDrawDocument, format: 'png', options?: { scale?: number }): Promise<ExportArtifact>;
  status(): { running: boolean; pid?: number; queued: number; activeTaskId?: string };
}

export interface Fnd09UtilityContainmentEngine {
  service: {
    getActiveDocumentId(): string | undefined;
    getDocument(documentId: string): AIDrawDocument | undefined;
  };
  rasterUtilities: ContainmentLane;
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

export function resolveFnd09UtilityContainmentE2eConfiguration(
  input: Fnd09UtilityContainmentE2eConfigurationInput,
): Fnd09UtilityContainmentE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath || !input.probePath || !input.networkSentinelPath) return undefined;
  const retainedRoot = resolve(input.workspacePath, 'test-results', 'retained');
  const profilePath = resolve(input.userDataPath);
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (normalizedPath(dirname(profilePath)) !== normalizedPath(retainedRoot)) return undefined;
  if (!basename(profilePath).toLowerCase().startsWith(FND09_UTILITY_E2E_PROFILE_PREFIX)) return undefined;
  if (!isNamedDirectChild(profilePath, input.connectionPath, FND09_UTILITY_E2E_CONNECTION_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.probePath, FND09_UTILITY_E2E_PROBE_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.networkSentinelPath, FND09_UTILITY_E2E_NETWORK_SENTINEL_FILE)) return undefined;
  return {
    profilePath,
    connectionPath: resolve(input.connectionPath),
    probePath: resolve(input.probePath),
    networkSentinelPath: resolve(input.networkSentinelPath),
  };
}

/** Refuse any unexpected non-loopback Node fetch while the fixed probe is active. */
export function installFnd09UtilityContainmentNetworkBoundary(
  configuration: Fnd09UtilityContainmentE2eConfiguration,
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if ((url.protocol === 'http:' || url.protocol === 'https:') && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
      return originalFetch(input, init);
    }
    await writeFile(configuration.networkSentinelPath, `${JSON.stringify({
      version: 1,
      blocked: true,
      protocol: url.protocol,
      hostname: url.hostname,
      nonLoopbackRequests: 1,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(() => undefined);
    throw new Error('The isolated FND-09 utility probe blocked a non-loopback request.');
  };
  return () => { globalThis.fetch = originalFetch; };
}

function documentSha256(document: AIDrawDocument): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex').toUpperCase();
}

function artifactSummary(artifact: ExportArtifact): { bytes: number; sha256: string; warnings: string[] } {
  return {
    bytes: artifact.data.byteLength,
    sha256: createHash('sha256').update(artifact.data).digest('hex').toUpperCase(),
    warnings: [...artifact.report.warnings],
  };
}

async function waitForActiveWorker(lane: ContainmentLane, label: string): Promise<{ pid: number; taskId: string }> {
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
  throw new Error(`${label} unexpectedly completed instead of failing closed.`);
}

/**
 * Fixed, non-provider packaged probe: crash one raster worker, cancel one hung
 * raster task, and require queued real PNG exports to recover in fresh workers.
 */
export async function runFnd09UtilityContainmentScenario(
  engine: Fnd09UtilityContainmentEngine,
  configuration: Fnd09UtilityContainmentE2eConfiguration,
): Promise<Record<string, unknown>> {
  const documentId = engine.service.getActiveDocumentId();
  const document = documentId ? engine.service.getDocument(documentId) : undefined;
  if (!documentId || !document) throw new Error('The FND-09 utility probe requires one active canonical document.');
  const before = { documentId, revision: document.revision, sha256: documentSha256(document) };
  let retained: Record<string, unknown>;
  try {
    const crashTask = engine.rasterUtilities.runE2eContainmentProbe('crash');
    const crashing = await waitForActiveWorker(engine.rasterUtilities, 'The crash probe');
    const queuedAfterCrash = engine.rasterUtilities.exportDocument(document, 'png', { scale: 1 });
    const crashError = await rejected(crashTask, 'The crash probe');
    const crashArtifact = artifactSummary(await queuedAfterCrash);
    const afterCrash = engine.rasterUtilities.status();
    if (!afterCrash.running || !Number.isInteger(afterCrash.pid) || afterCrash.pid === crashing.pid) throw new Error('The crashed raster utility was not replaced before queued work completed.');

    const controller = new AbortController();
    const hangingTask = engine.rasterUtilities.runE2eContainmentProbe('hang', { signal: controller.signal });
    const cancelling = await waitForActiveWorker(engine.rasterUtilities, 'The cancellation probe');
    if (cancelling.pid !== afterCrash.pid) throw new Error('The cancellation probe did not run in the post-crash worker.');
    const queuedAfterCancel = engine.rasterUtilities.exportDocument(document, 'png', { scale: 1 });
    controller.abort();
    const cancellationError = await rejected(hangingTask, 'The cancellation probe');
    if (cancellationError.name !== 'AbortError') throw new Error('The cancelled raster utility task did not reject with AbortError.');
    const cancelArtifact = artifactSummary(await queuedAfterCancel);
    const afterCancel = engine.rasterUtilities.status();
    if (!afterCancel.running || !Number.isInteger(afterCancel.pid) || afterCancel.pid === cancelling.pid) throw new Error('The cancelled raster utility was not replaced before queued work completed.');
    if (JSON.stringify(crashArtifact) !== JSON.stringify(cancelArtifact)) throw new Error('Real PNG export changed across crash/cancel worker replacement.');

    const current = engine.service.getDocument(documentId);
    if (!current) throw new Error('The canonical document disappeared during utility containment.');
    const after = { documentId, revision: current.revision, sha256: documentSha256(current) };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Utility containment changed canonical document state.');
    retained = {
      version: 1,
      scenario: 'FND-09 packaged raster utility crash/cancel/restart containment',
      result: 'passed',
      canonical: { before, after, unchanged: true },
      crash: { workerPid: crashing.pid, error: crashError, restartPid: afterCrash.pid, queuedExport: crashArtifact },
      cancellation: { workerPid: cancelling.pid, error: cancellationError, restartPid: afterCancel.pid, queuedExport: cancelArtifact },
      workerPidsDistinct: new Set([crashing.pid, afterCrash.pid, afterCancel.pid]).size === 3,
      network: { nonLoopbackRequests: 0 },
    };
    if (retained.workerPidsDistinct !== true) throw new Error('Crash and cancellation did not produce three distinct worker identities.');
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    retained = {
      version: 1,
      scenario: 'FND-09 packaged raster utility crash/cancel/restart containment',
      result: 'failed',
      error: { name: value.name, message: value.message.slice(0, 500) },
      canonical: { before },
      network: { nonLoopbackRequests: 0 },
    };
  }
  await writeFile(configuration.probePath, `${JSON.stringify(retained, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (retained.result !== 'passed') throw new Error(String((retained.error as { message?: string } | undefined)?.message ?? 'FND-09 utility containment failed.'));
  return retained;
}
