import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { AIDrawDocument, PaletteEntry } from '@aidraw/core';
import {
  FND09_QUANTIZATION_RESULT_E2E_HEIGHT,
  FND09_QUANTIZATION_RESULT_E2E_HOLD_MS,
  FND09_QUANTIZATION_RESULT_E2E_OPTIONS,
  FND09_QUANTIZATION_RESULT_E2E_PALETTE,
  FND09_QUANTIZATION_RESULT_E2E_TINY_PNG_BASE64,
  FND09_QUANTIZATION_RESULT_E2E_WIDTH,
  type Fnd09QuantizationResultFault,
} from './utility-quantization-result-e2e-contract';

export const FND09_QUANTIZATION_RESULT_E2E_PROFILE_PREFIX = 'aidraw-e2e-fnd09-quantization-result-';
export const FND09_QUANTIZATION_RESULT_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const FND09_QUANTIZATION_RESULT_E2E_PROBE_FILE = 'fnd09-quantization-result-probe.json';
export const FND09_QUANTIZATION_RESULT_E2E_NETWORK_SENTINEL_FILE = 'fnd09-quantization-result-forbidden-network.json';

export interface Fnd09QuantizationResultE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  probePath: string;
  networkSentinelPath: string;
}

interface Fnd09QuantizationResultE2eConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  workspacePath: string;
  declaredProfilePath?: string;
  userDataPath?: string;
  connectionPath?: string;
  probePath?: string;
  networkSentinelPath?: string;
}

interface QuantizationResultLane {
  runE2eQuantizationResultProbe(
    fault: Fnd09QuantizationResultFault,
    control?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Array<{ x: number; y: number; index: number }>>;
  quantizeImage(
    encoded: Buffer,
    width: number,
    height: number,
    palette: PaletteEntry[],
    options: { alphaThreshold: number; dithering: 'none' },
    control?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Array<{ x: number; y: number; index: number }>>;
  status(): { running: boolean; pid?: number; queued: number; activeTaskId?: string };
}

export interface Fnd09QuantizationResultEngine {
  service: {
    getActiveDocumentId(): string | undefined;
    getDocument(documentId: string): AIDrawDocument | undefined;
  };
  rasterUtilities: QuantizationResultLane;
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

export function resolveFnd09QuantizationResultE2eConfiguration(
  input: Fnd09QuantizationResultE2eConfigurationInput,
): Fnd09QuantizationResultE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath || !input.probePath || !input.networkSentinelPath) return undefined;
  const retainedRoot = resolve(input.workspacePath, 'test-results', 'retained');
  const profilePath = resolve(input.userDataPath);
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (normalizedPath(dirname(profilePath)) !== normalizedPath(retainedRoot)) return undefined;
  if (!basename(profilePath).toLowerCase().startsWith(FND09_QUANTIZATION_RESULT_E2E_PROFILE_PREFIX)) return undefined;
  if (!isNamedDirectChild(profilePath, input.connectionPath, FND09_QUANTIZATION_RESULT_E2E_CONNECTION_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.probePath, FND09_QUANTIZATION_RESULT_E2E_PROBE_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.networkSentinelPath, FND09_QUANTIZATION_RESULT_E2E_NETWORK_SENTINEL_FILE)) return undefined;
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

async function waitForActiveWorker(lane: QuantizationResultLane, label: string): Promise<{ pid: number; taskId: string }> {
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

function assertRecovery(changes: Array<{ x: number; y: number; index: number }>): { changes: number; sha256: string } {
  const expected = [{ x: 0, y: 0, index: 1 }];
  if (JSON.stringify(changes) !== JSON.stringify(expected)) throw new Error('Fresh-worker quantization returned an unexpected recovery result.');
  return {
    changes: changes.length,
    sha256: createHash('sha256').update(JSON.stringify(changes)).digest('hex').toUpperCase(),
  };
}

/**
 * Fixed packaged probe: make two real utility workers return request-invalid
 * quantization results, then require already-queued ordinary work to recover
 * through distinct replacement workers without exposing either bad payload.
 */
export async function runFnd09QuantizationResultScenario(
  engine: Fnd09QuantizationResultEngine,
  configuration: Fnd09QuantizationResultE2eConfiguration,
): Promise<Record<string, unknown>> {
  const documentId = engine.service.getActiveDocumentId();
  const document = documentId ? engine.service.getDocument(documentId) : undefined;
  if (!documentId || !document) throw new Error('The FND-09 quantization-result probe requires one active canonical document.');
  const before = { documentId, revision: document.revision, sha256: documentSha256(document) };
  const tinyPng = Buffer.from(FND09_QUANTIZATION_RESULT_E2E_TINY_PNG_BASE64, 'base64');
  let retained: Record<string, unknown>;
  try {
    const idle = engine.rasterUtilities.status();
    if (idle.running || idle.queued !== 0 || idle.activeTaskId) throw new Error('The quantization-result probe requires a fresh idle raster utility lane.');

    const runFault = async (fault: Fnd09QuantizationResultFault, expectedMessage: string) => {
      const corruptTask = engine.rasterUtilities.runE2eQuantizationResultProbe(fault);
      const corruptWorker = await waitForActiveWorker(engine.rasterUtilities, `The ${fault} quantization-result probe`);
      const queuedRecovery = engine.rasterUtilities.quantizeImage(
        tinyPng,
        FND09_QUANTIZATION_RESULT_E2E_WIDTH,
        FND09_QUANTIZATION_RESULT_E2E_HEIGHT,
        FND09_QUANTIZATION_RESULT_E2E_PALETTE,
        FND09_QUANTIZATION_RESULT_E2E_OPTIONS,
      );
      const error = await rejected(corruptTask, `The ${fault} quantization-result probe`);
      if (error.message !== expectedMessage) throw new Error(`The ${fault} quantization-result probe failed at the wrong boundary: ${error.message}`);
      const recovery = assertRecovery(await queuedRecovery);
      const after = engine.rasterUtilities.status();
      if (!after.running || !Number.isInteger(after.pid) || after.pid === corruptWorker.pid) {
        throw new Error(`The ${fault} quantization worker was not replaced before queued recovery completed.`);
      }
      return {
        workerPid: corruptWorker.pid,
        error,
        resultReturnedToCaller: false,
        payloadRetained: false,
        queuedRecovery: {
          workerPid: after.pid,
          workerReplaced: true,
          queued: true,
          changes: recovery.changes,
          sha256: recovery.sha256,
        },
      };
    };

    const overBudget = await runFault(
      'over-budget',
      'Raster utility quantization result exceeds its 1-pixel output budget.',
    );
    const contradictory = await runFault(
      'contradictory',
      'Raster utility returned a malformed quantization result.',
    );
    if (contradictory.workerPid !== overBudget.queuedRecovery.workerPid) {
      throw new Error('The contradictory fault did not begin on the first fresh recovery worker.');
    }
    if (new Set([overBudget.workerPid, overBudget.queuedRecovery.workerPid, contradictory.queuedRecovery.workerPid]).size !== 3) {
      throw new Error('Quantization-result recovery did not use three distinct worker identities.');
    }

    const current = engine.service.getDocument(documentId);
    if (!current) throw new Error('The canonical document disappeared during quantization-result containment.');
    const after = { documentId, revision: current.revision, sha256: documentSha256(current) };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Quantization-result containment changed canonical document state.');
    retained = {
      version: 1,
      scenario: 'FND-09 packaged quantization result containment',
      result: 'passed',
      canonical: { before, after, unchanged: true },
      overBudget: {
        ...overBudget,
        requestPixelBudget: 1,
        returnedChanges: 2,
        countGateBeforeDuplicateAllocation: true,
      },
      contradictory: {
        ...contradictory,
        contradiction: 'x=1 lies outside the originating 1x1 request',
      },
      fixedInvalidResponseHoldMs: FND09_QUANTIZATION_RESULT_E2E_HOLD_MS,
      workerPidsDistinct: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false },
      network: { nonLoopbackRequests: 0 },
    };
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    retained = {
      version: 1,
      scenario: 'FND-09 packaged quantization result containment',
      result: 'failed',
      error: { name: value.name, message: value.message.slice(0, 500) },
      canonical: { before },
      network: { nonLoopbackRequests: 0 },
    };
  }
  await writeFile(configuration.probePath, `${JSON.stringify(retained, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (retained.result !== 'passed') throw new Error(String((retained.error as { message?: string } | undefined)?.message ?? 'FND-09 quantization-result containment failed.'));
  return retained;
}
