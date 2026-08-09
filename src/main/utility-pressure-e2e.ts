import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { AIDrawDocument, PaletteEntry } from '@aidraw/core';
import { MAX_QUANTIZE_UTILITY_SOURCE_BYTES } from './utility-contract';
import { MAX_QUEUED_UTILITY_TASKS } from './utility-supervisor';

export const FND09_UTILITY_PRESSURE_E2E_PROFILE_PREFIX = 'aidraw-e2e-fnd09-utility-pressure-';
export const FND09_UTILITY_PRESSURE_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const FND09_UTILITY_PRESSURE_E2E_PROBE_FILE = 'fnd09-utility-pressure-probe.json';
export const FND09_UTILITY_PRESSURE_E2E_NETWORK_SENTINEL_FILE = 'fnd09-pressure-forbidden-network.json';
export const FND09_UTILITY_PRESSURE_TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZYxAUFPwPAAGdATO384aOAAAAAElFTkSuQmCC';

export interface Fnd09UtilityPressureE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  probePath: string;
  networkSentinelPath: string;
}

interface Fnd09UtilityPressureE2eConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  workspacePath: string;
  declaredProfilePath?: string;
  userDataPath?: string;
  connectionPath?: string;
  probePath?: string;
  networkSentinelPath?: string;
}

interface PressureLane {
  runE2eContainmentProbe(mode: 'pressure-gate', control?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
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

export interface Fnd09UtilityPressureEngine {
  service: {
    getActiveDocumentId(): string | undefined;
    getDocument(documentId: string): AIDrawDocument | undefined;
  };
  rasterUtilities: PressureLane;
  generationUtilities: { status(): { running: boolean } };
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

export function resolveFnd09UtilityPressureE2eConfiguration(
  input: Fnd09UtilityPressureE2eConfigurationInput,
): Fnd09UtilityPressureE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath || !input.probePath || !input.networkSentinelPath) return undefined;
  const retainedRoot = resolve(input.workspacePath, 'test-results', 'retained');
  const profilePath = resolve(input.userDataPath);
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (normalizedPath(dirname(profilePath)) !== normalizedPath(retainedRoot)) return undefined;
  if (!basename(profilePath).toLowerCase().startsWith(FND09_UTILITY_PRESSURE_E2E_PROFILE_PREFIX)) return undefined;
  if (!isNamedDirectChild(profilePath, input.connectionPath, FND09_UTILITY_PRESSURE_E2E_CONNECTION_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.probePath, FND09_UTILITY_PRESSURE_E2E_PROBE_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.networkSentinelPath, FND09_UTILITY_PRESSURE_E2E_NETWORK_SENTINEL_FILE)) return undefined;
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

async function waitForActiveWorker(lane: PressureLane): Promise<{ pid: number; taskId: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = lane.status();
    if (status.running && Number.isInteger(status.pid) && status.activeTaskId) return { pid: status.pid!, taskId: status.activeTaskId };
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('The fixed pressure gate did not become active in the supervised utility process.');
}

async function rejected(promise: Promise<unknown>, label: string): Promise<{ name: string; message: string; code?: string; retryable?: boolean }> {
  try {
    await promise;
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    const metadata = value as Error & { code?: unknown; retryable?: unknown };
    return {
      name: value.name,
      message: value.message.slice(0, 500),
      ...(typeof metadata.code === 'string' ? { code: metadata.code } : {}),
      ...(typeof metadata.retryable === 'boolean' ? { retryable: metadata.retryable } : {}),
    };
  }
  throw new Error(`${label} unexpectedly completed instead of failing closed.`);
}

/** Fixed packaged probe for queue admission and invalid-input pressure only. */
export async function runFnd09UtilityPressureScenario(
  engine: Fnd09UtilityPressureEngine,
  configuration: Fnd09UtilityPressureE2eConfiguration,
): Promise<Record<string, unknown>> {
  const documentId = engine.service.getActiveDocumentId();
  const document = documentId ? engine.service.getDocument(documentId) : undefined;
  if (!documentId || !document) throw new Error('The FND-09 utility pressure probe requires one active canonical document.');
  const before = { documentId, revision: document.revision, sha256: documentSha256(document) };
  let retained: Record<string, unknown>;
  try {
    const idleBefore = engine.rasterUtilities.status();
    if (idleBefore.running || idleBefore.queued !== 0 || idleBefore.activeTaskId) throw new Error('The pressure probe requires a fresh idle raster utility lane.');
    let base64Attempted = false;
    const oversized = Buffer.alloc(MAX_QUANTIZE_UTILITY_SOURCE_BYTES + 1);
    Object.defineProperty(oversized, 'toString', {
      configurable: true,
      value: () => {
        base64Attempted = true;
        throw new Error('The quantization base64 trap was invoked.');
      },
    });
    const oversizedError = await rejected(
      engine.rasterUtilities.quantizeImage(oversized, 1, 1, [
        { id: 'transparent', name: 'Transparent', color: '#00000000' },
        { id: 'ink', name: 'Ink', color: '#111111ff' },
      ], { alphaThreshold: 0.5, dithering: 'none' }),
      'The oversized quantization request',
    );
    const idleAfter = engine.rasterUtilities.status();
    if (base64Attempted || oversizedError.message !== 'Encoded image exceeds the utility input limit.' || JSON.stringify(idleAfter) !== JSON.stringify(idleBefore)) {
      throw new Error('Oversized quantization input crossed its pre-base64 admission boundary.');
    }

    const pressureGate = engine.rasterUtilities.runE2eContainmentProbe('pressure-gate');
    const gate = await waitForActiveWorker(engine.rasterUtilities);
    const tinyPng = Buffer.from(FND09_UTILITY_PRESSURE_TINY_PNG_BASE64, 'base64');
    const palette: PaletteEntry[] = [
      { id: 'transparent', name: 'Transparent', color: '#00000000' },
      { id: 'ink', name: 'Ink', color: '#111111ff' },
    ];
    const completionOrder: string[] = [];
    const enqueue = (label: string, signal?: AbortSignal) => engine.rasterUtilities.quantizeImage(
      tinyPng,
      1,
      1,
      palette,
      { alphaThreshold: 0.5, dithering: 'none' },
      { signal },
    ).then((changes) => {
      if (changes.length !== 1 || changes[0].x !== 0 || changes[0].y !== 0 || changes[0].index !== 1) throw new Error(`Quantization result changed for ${label}.`);
      completionOrder.push(label);
      return changes;
    });
    const queued = Array.from({ length: MAX_QUEUED_UTILITY_TASKS }, (_, index) => {
      const label = `queued-${index}`;
      const controller = new AbortController();
      return { label, controller, pending: enqueue(label, controller.signal) };
    });
    const atLimit = engine.rasterUtilities.status();
    if (atLimit.pid !== gate.pid || atLimit.activeTaskId !== gate.taskId || atLimit.queued !== MAX_QUEUED_UTILITY_TASKS) throw new Error('The real utility lane did not retain the exact 32-waiter boundary.');

    const overflowError = await rejected(enqueue('overflow'), 'The 33rd utility waiter');
    if (overflowError.name !== 'UtilityBackpressureError' || overflowError.code !== 'utility_queue_full' || overflowError.retryable !== true) {
      throw new Error('The 33rd utility waiter did not receive the exact retryable backpressure contract.');
    }
    const cancelled = queued[10];
    const cancelledRejection = rejected(cancelled.pending, 'The selected queued waiter');
    cancelled.controller.abort();
    const cancelledError = await cancelledRejection;
    const afterCancellation = engine.rasterUtilities.status();
    if (cancelledError.name !== 'AbortError' || afterCancellation.pid !== gate.pid || afterCancellation.queued !== MAX_QUEUED_UTILITY_TASKS - 1) {
      throw new Error('Queued cancellation did not free exactly one slot without replacing the worker.');
    }

    const replacement = { label: 'replacement', pending: enqueue('replacement') };
    const afterRefill = engine.rasterUtilities.status();
    if (afterRefill.pid !== gate.pid || afterRefill.queued !== MAX_QUEUED_UTILITY_TASKS) throw new Error('The replacement waiter did not refill the exact queue boundary.');
    const admitted = [...queued.filter((item) => item !== cancelled), replacement];
    await pressureGate;
    await Promise.all(admitted.map((item) => item.pending));
    const expectedOrder = admitted.map((item) => item.label);
    if (JSON.stringify(completionOrder) !== JSON.stringify(expectedOrder)) throw new Error('Admitted utility work did not drain in exact FIFO order.');
    const afterDrain = engine.rasterUtilities.status();
    if (!afterDrain.running || afterDrain.pid !== gate.pid || afterDrain.queued !== 0 || afterDrain.activeTaskId) throw new Error('The pressure queue did not drain through the original real utility worker.');

    const current = engine.service.getDocument(documentId);
    if (!current) throw new Error('The canonical document disappeared during utility pressure containment.');
    const after = { documentId, revision: current.revision, sha256: documentSha256(current) };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Utility pressure containment changed canonical document state.');
    if (engine.generationUtilities.status().running) throw new Error('The separate generation lane was unexpectedly started.');

    retained = {
      version: 1,
      scenario: 'FND-09 packaged raster utility admission pressure containment',
      result: 'passed',
      canonical: { before, after, unchanged: true },
      oversize: {
        boundaryBytes: MAX_QUANTIZE_UTILITY_SOURCE_BYTES,
        rejectedBytes: oversized.byteLength,
        base64Attempted: false,
        workerStarted: false,
        error: oversizedError,
      },
      admission: {
        activeWorkerPid: gate.pid,
        waitingLimit: MAX_QUEUED_UTILITY_TASKS,
        queuedAtLimit: atLimit.queued,
        overflowError,
      },
      cancellation: { label: cancelled.label, error: cancelledError, queuedAfterCancellation: afterCancellation.queued },
      refill: { label: replacement.label, queuedAfterRefill: afterRefill.queued },
      drain: { expectedOrder, completionOrder, sameWorker: true, workerPid: afterDrain.pid, queuedAfterDrain: afterDrain.queued },
      generationLaneUntouched: true,
      privacy: { rawUtilityPayloadsPublished: false, publicJobCreated: false },
    };
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    retained = {
      version: 1,
      scenario: 'FND-09 packaged raster utility admission pressure containment',
      result: 'failed',
      error: { name: value.name, message: value.message.slice(0, 500) },
      canonical: { before },
    };
  }
  await writeFile(configuration.probePath, `${JSON.stringify(retained, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (retained.result !== 'passed') throw new Error(String((retained.error as { message?: string } | undefined)?.message ?? 'FND-09 utility pressure containment failed.'));
  return retained;
}
