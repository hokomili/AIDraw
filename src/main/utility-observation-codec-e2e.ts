import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { AIDrawDocument } from '@aidraw/core';
import {
  FND09_OBSERVATION_CODEC_E2E_HOLD_MS,
  FND09_OBSERVATION_CODEC_E2E_MAX_PIXELS,
  FND09_OBSERVATION_CODEC_E2E_REQUEST,
} from './utility-observation-codec-e2e-contract';

export const FND09_OBSERVATION_CODEC_E2E_PROFILE_PREFIX = 'aidraw-e2e-fnd09-observation-codec-';
export const FND09_OBSERVATION_CODEC_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const FND09_OBSERVATION_CODEC_E2E_PROBE_FILE = 'fnd09-observation-codec-probe.json';
export const FND09_OBSERVATION_CODEC_E2E_NETWORK_SENTINEL_FILE = 'fnd09-observation-codec-forbidden-network.json';

export interface Fnd09ObservationCodecE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  probePath: string;
  networkSentinelPath: string;
}

interface Fnd09ObservationCodecE2eConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  workspacePath: string;
  declaredProfilePath?: string;
  userDataPath?: string;
  connectionPath?: string;
  probePath?: string;
  networkSentinelPath?: string;
}

interface ObservationCodecLane {
  runE2eObservationCodecProbe(document: AIDrawDocument, control?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>>;
  captureObservation(
    document: AIDrawDocument,
    request: typeof FND09_OBSERVATION_CODEC_E2E_REQUEST,
    maxPixels: number,
    control?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
  status(): { running: boolean; pid?: number; queued: number; activeTaskId?: string };
}

export interface Fnd09ObservationCodecEngine {
  service: {
    getActiveDocumentId(): string | undefined;
    getDocument(documentId: string): AIDrawDocument | undefined;
  };
  rasterUtilities: ObservationCodecLane;
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

export function resolveFnd09ObservationCodecE2eConfiguration(
  input: Fnd09ObservationCodecE2eConfigurationInput,
): Fnd09ObservationCodecE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath || !input.probePath || !input.networkSentinelPath) return undefined;
  const retainedRoot = resolve(input.workspacePath, 'test-results', 'retained');
  const profilePath = resolve(input.userDataPath);
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (normalizedPath(dirname(profilePath)) !== normalizedPath(retainedRoot)) return undefined;
  if (!basename(profilePath).toLowerCase().startsWith(FND09_OBSERVATION_CODEC_E2E_PROFILE_PREFIX)) return undefined;
  if (!isNamedDirectChild(profilePath, input.connectionPath, FND09_OBSERVATION_CODEC_E2E_CONNECTION_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.probePath, FND09_OBSERVATION_CODEC_E2E_PROBE_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.networkSentinelPath, FND09_OBSERVATION_CODEC_E2E_NETWORK_SENTINEL_FILE)) return undefined;
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

async function waitForActiveWorker(lane: ObservationCodecLane): Promise<{ pid: number; taskId: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = lane.status();
    if (status.running && Number.isInteger(status.pid) && status.activeTaskId) return { pid: status.pid!, taskId: status.activeTaskId };
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('The observation codec probe did not become active in the supervised utility process.');
}

async function rejected(promise: Promise<unknown>): Promise<{ name: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    return { name: value.name, message: value.message.slice(0, 500) };
  }
  throw new Error('The CRC-valid undecodable observation unexpectedly reached its caller.');
}

function observationSummary(result: Record<string, unknown>) {
  if (result.available !== true || result.mimeType !== 'image/png' || typeof result.data !== 'string'
    || result.width !== 8 || result.height !== 6 || result.scale !== 1
    || JSON.stringify(result.region) !== JSON.stringify(FND09_OBSERVATION_CODEC_E2E_REQUEST.region)
    || result.background !== FND09_OBSERVATION_CODEC_E2E_REQUEST.background) {
    throw new Error('The fresh utility worker returned an unexpected recovery observation.');
  }
  const bytes = Buffer.from(result.data, 'base64');
  return {
    available: true,
    mimeType: 'image/png',
    width: result.width,
    height: result.height,
    scale: result.scale,
    region: result.region,
    background: result.background,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
  };
}

/**
 * Fixed non-provider packaged probe: return one CRC-valid but undecodable PNG
 * from the real raster child, then require queued ordinary observation work to
 * complete in a distinct replacement child without canonical mutation.
 */
export async function runFnd09ObservationCodecScenario(
  engine: Fnd09ObservationCodecEngine,
  configuration: Fnd09ObservationCodecE2eConfiguration,
): Promise<Record<string, unknown>> {
  const documentId = engine.service.getActiveDocumentId();
  const document = documentId ? engine.service.getDocument(documentId) : undefined;
  if (!documentId || !document) throw new Error('The observation codec probe requires one active canonical document.');
  const before = { documentId, revision: document.revision, sha256: documentSha256(document) };
  let retained: Record<string, unknown>;
  try {
    const corruptTask = engine.rasterUtilities.runE2eObservationCodecProbe(document);
    const corruptWorker = await waitForActiveWorker(engine.rasterUtilities);
    const queuedRecovery = engine.rasterUtilities.captureObservation(
      document,
      FND09_OBSERVATION_CODEC_E2E_REQUEST,
      FND09_OBSERVATION_CODEC_E2E_MAX_PIXELS,
    );
    const corruptError = await rejected(corruptTask);
    if (corruptError.message !== 'Raster utility returned an undecodable observation image.') {
      throw new Error(`The observation codec probe failed at the wrong boundary: ${corruptError.message}`);
    }
    const recovery = observationSummary(await queuedRecovery);
    const afterRecovery = engine.rasterUtilities.status();
    if (!afterRecovery.running || !Number.isInteger(afterRecovery.pid) || afterRecovery.pid === corruptWorker.pid) {
      throw new Error('The compromised observation utility was not replaced before queued recovery completed.');
    }

    const current = engine.service.getDocument(documentId);
    if (!current) throw new Error('The canonical document disappeared during observation codec containment.');
    const after = { documentId, revision: current.revision, sha256: documentSha256(current) };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Observation codec containment changed canonical document state.');
    retained = {
      version: 1,
      scenario: 'FND-09 packaged observation codec result containment',
      result: 'passed',
      canonical: { before, after, unchanged: true },
      corrupt: {
        workerPid: corruptWorker.pid,
        error: corruptError,
        crcValidStaticEnvelopeReachedFullDecode: true,
        resultReturnedToCaller: false,
        payloadRetained: false,
      },
      recovery: {
        workerPid: afterRecovery.pid,
        workerReplaced: true,
        queued: true,
        fixedCorruptResponseHoldMs: FND09_OBSERVATION_CODEC_E2E_HOLD_MS,
        observation: recovery,
      },
      privacy: { rendererCreated: false, corruptPayloadPublished: false, publicJobCreated: false },
      network: { nonLoopbackRequests: 0 },
    };
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    retained = {
      version: 1,
      scenario: 'FND-09 packaged observation codec result containment',
      result: 'failed',
      error: { name: value.name, message: value.message.slice(0, 500) },
      canonical: { before },
      network: { nonLoopbackRequests: 0 },
    };
  }
  await writeFile(configuration.probePath, `${JSON.stringify(retained, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (retained.result !== 'passed') throw new Error(String((retained.error as { message?: string } | undefined)?.message ?? 'FND-09 observation codec containment failed.'));
  return retained;
}
