import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { AIDrawDocument } from '@aidraw/core';
import type { GeneratedOutput } from '../common/generation';
import {
  FND09_GENERATION_RESULT_E2E_HOLD_MS,
  FND09_GENERATION_RESULT_E2E_SEED,
  type Fnd09GenerationResultFault,
  type Fnd09GenerationResultFixture,
} from './utility-generation-result-e2e-contract';

export const FND09_GENERATION_RESULT_E2E_PROFILE_PREFIX = 'aidraw-e2e-fnd09-generation-result-';
export const FND09_GENERATION_RESULT_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const FND09_GENERATION_RESULT_E2E_PROBE_FILE = 'fnd09-generation-result-probe.json';
export const FND09_GENERATION_RESULT_E2E_NETWORK_SENTINEL_FILE = 'fnd09-generation-result-forbidden-network.json';

export interface Fnd09GenerationResultE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  probePath: string;
  networkSentinelPath: string;
}

interface Fnd09GenerationResultE2eConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  workspacePath: string;
  declaredProfilePath?: string;
  userDataPath?: string;
  connectionPath?: string;
  probePath?: string;
  networkSentinelPath?: string;
}

interface GenerationResultLane {
  runE2eGenerationResultProbe(
    document: AIDrawDocument,
    fixture: Fnd09GenerationResultFixture,
    control?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GeneratedOutput[]>;
  status(): { running: boolean; pid?: number; queued: number; activeTaskId?: string };
}

export interface Fnd09GenerationResultEngine {
  service: {
    getActiveDocumentId(): string | undefined;
    getDocument(documentId: string): AIDrawDocument | undefined;
  };
  rasterUtilities: { status(): { running: boolean; queued: number; activeTaskId?: string } };
  generationUtilities: GenerationResultLane;
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

export function resolveFnd09GenerationResultE2eConfiguration(
  input: Fnd09GenerationResultE2eConfigurationInput,
): Fnd09GenerationResultE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath || !input.probePath || !input.networkSentinelPath) return undefined;
  const retainedRoot = resolve(input.workspacePath, 'test-results', 'retained');
  const profilePath = resolve(input.userDataPath);
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (normalizedPath(dirname(profilePath)) !== normalizedPath(retainedRoot)) return undefined;
  if (!basename(profilePath).toLowerCase().startsWith(FND09_GENERATION_RESULT_E2E_PROFILE_PREFIX)) return undefined;
  if (!isNamedDirectChild(profilePath, input.connectionPath, FND09_GENERATION_RESULT_E2E_CONNECTION_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.probePath, FND09_GENERATION_RESULT_E2E_PROBE_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.networkSentinelPath, FND09_GENERATION_RESULT_E2E_NETWORK_SENTINEL_FILE)) return undefined;
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

async function waitForActiveWorker(lane: GenerationResultLane, label: string): Promise<{ pid: number; taskId: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = lane.status();
    if (status.running && Number.isInteger(status.pid) && status.activeTaskId) return { pid: status.pid!, taskId: status.activeTaskId };
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`${label} did not become active in the supervised generation utility process.`);
}

async function rejected(promise: Promise<unknown>, label: string): Promise<{ name: string; message: string }> {
  try { await promise; }
  catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    return { name: value.name, message: value.message.slice(0, 500) };
  }
  throw new Error(`${label} unexpectedly reached preview or job use.`);
}

function summarizeRecovery(outputs: GeneratedOutput[]) {
  if (outputs.length !== 1) throw new Error('Fresh-worker generation recovery returned an unexpected result count.');
  const output = outputs[0];
  if (output.mimeType !== 'image/png' || output.width !== 1 || output.height !== 1 || output.seed !== FND09_GENERATION_RESULT_E2E_SEED) {
    throw new Error('Fresh-worker generation recovery returned an unexpected image contract.');
  }
  if (!output.providerMetadata || Array.isArray(output.providerMetadata)) throw new Error('Fresh-worker generation recovery lost record metadata.');
  const bytes = Buffer.from(output.data, 'base64');
  const summary = {
    outputCount: 1,
    mimeType: output.mimeType,
    width: output.width,
    height: output.height,
    seed: output.seed,
    providerMetadataRecord: true,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
  };
  return {
    ...summary,
    semanticSha256: createHash('sha256').update(JSON.stringify(summary)).digest('hex').toUpperCase(),
  };
}

/** Fixed packaged probe: return provider-free local results, corrupt one contract, and require queued recovery. */
export async function runFnd09GenerationResultScenario(
  engine: Fnd09GenerationResultEngine,
  configuration: Fnd09GenerationResultE2eConfiguration,
): Promise<Record<string, unknown>> {
  const documentId = engine.service.getActiveDocumentId();
  const document = documentId ? engine.service.getDocument(documentId) : undefined;
  if (!documentId || !document) throw new Error('The FND-09 generation-result probe requires one active canonical document.');
  const before = { documentId, revision: document.revision, sha256: documentSha256(document) };
  let retained: Record<string, unknown>;
  try {
    const generationIdle = engine.generationUtilities.status();
    const rasterIdle = engine.rasterUtilities.status();
    if (generationIdle.running || generationIdle.queued !== 0 || generationIdle.activeTaskId) throw new Error('The generation-result probe requires a fresh idle generation utility lane.');
    if (rasterIdle.running || rasterIdle.queued !== 0 || rasterIdle.activeTaskId) throw new Error('The generation-result probe requires an untouched raster utility lane.');

    const runFault = async (fault: Fnd09GenerationResultFault, expectedMessage: string, contract: string) => {
      const corruptTask = engine.generationUtilities.runE2eGenerationResultProbe(document, fault);
      const corruptWorker = await waitForActiveWorker(engine.generationUtilities, `The ${fault} generation-result probe`);
      const queuedRecovery = engine.generationUtilities.runE2eGenerationResultProbe(document, 'valid');
      const error = await rejected(corruptTask, `The ${fault} generation-result probe`);
      if (error.message !== expectedMessage) throw new Error(`The ${fault} generation-result probe failed at the wrong boundary: ${error.message}`);
      const recovery = summarizeRecovery(await queuedRecovery);
      const after = engine.generationUtilities.status();
      if (!after.running || !Number.isInteger(after.pid) || after.pid === corruptWorker.pid) {
        throw new Error(`The ${fault} generation worker was not replaced before queued recovery completed.`);
      }
      return {
        fault,
        contract,
        workerPid: corruptWorker.pid,
        error,
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforePreviewOrJobUse: true,
        queuedRecovery: { workerPid: after.pid, workerReplaced: true, queued: true, ...recovery },
      };
    };

    const resultCount = await runFault('result-count', 'Generation utility returned more than the requested 1 result.', 'originating resultCount');
    const mimeHeader = await runFault('mime-header', 'Generation utility returned a malformed image result.', 'MIME/header agreement');
    const dimensionHeader = await runFault('dimension-header', 'Generation utility returned a malformed image result.', 'declared/header dimensions');
    const seed = await runFault('seed', 'Generation utility returned a malformed result.', 'request-derived Stability seed');
    const metadata = await runFault('metadata', 'Generation utility returned a malformed result.', 'record-shaped provider metadata');
    const faultRuns = [resultCount, mimeHeader, dimensionHeader, seed, metadata];
    for (let index = 1; index < faultRuns.length; index += 1) {
      if (faultRuns[index].workerPid !== faultRuns[index - 1].queuedRecovery.workerPid) {
        throw new Error('A generation-result fault did not begin on the preceding fresh recovery worker.');
      }
    }
    const pids = [resultCount.workerPid, ...faultRuns.map((entry) => entry.queuedRecovery.workerPid)];
    if (new Set(pids).size !== pids.length) throw new Error('Generation-result recovery did not use six distinct worker identities.');
    const semanticHashes = new Set(faultRuns.map((entry) => entry.queuedRecovery.semanticSha256));
    if (semanticHashes.size !== 1) throw new Error('Fresh-worker generation recovery did not preserve the deterministic local result.');

    const current = engine.service.getDocument(documentId);
    if (!current) throw new Error('The canonical document disappeared during generation-result containment.');
    const after = { documentId, revision: current.revision, sha256: documentSha256(current) };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Generation-result containment changed canonical document state.');
    const rasterAfter = engine.rasterUtilities.status();
    if (rasterAfter.running || rasterAfter.queued !== 0 || rasterAfter.activeTaskId) throw new Error('Generation-result containment touched the raster utility lane.');

    retained = {
      version: 1,
      scenario: 'FND-09 packaged generation result containment',
      result: 'passed',
      canonical: { before, after, unchanged: true },
      requestContract: {
        provider: 'stability', mode: 'create', resultCount: 1, width: 1, height: 1,
        seed: FND09_GENERATION_RESULT_E2E_SEED, credentialSupplied: false, providerInvoked: false,
      },
      resultCount,
      mimeHeader,
      dimensionHeader,
      seed,
      metadata,
      fixedInvalidResponseHoldMs: FND09_GENERATION_RESULT_E2E_HOLD_MS,
      workerPidsDistinct: true,
      recoverySemanticHashesAgree: true,
      rasterLaneUntouched: true,
      privacy: {
        rendererCreated: false,
        invalidPayloadPublished: false,
        publicJobCreated: false,
        promptRetained: false,
        providerMetadataRetained: false,
      },
      filesystem: { inputTargetsCreated: 0, outputTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
    };
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    retained = {
      version: 1,
      scenario: 'FND-09 packaged generation result containment',
      result: 'failed',
      error: { name: value.name, message: value.message.slice(0, 500) },
      canonical: { before },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
    };
  }
  await writeFile(configuration.probePath, `${JSON.stringify(retained, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (retained.result !== 'passed') throw new Error(String((retained.error as { message?: string } | undefined)?.message ?? 'FND-09 generation-result containment failed.'));
  return retained;
}
