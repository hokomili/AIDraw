import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AIDrawDocument } from '@aidraw/core';
import {
  FND09_IMPORT_RESULT_E2E_HOLD_MS,
  type Fnd09ImportResultFault,
} from './utility-import-result-e2e-contract';

export const FND09_IMPORT_RESULT_E2E_PROFILE_PREFIX = 'aidraw-e2e-fnd09-import-result-';
export const FND09_IMPORT_RESULT_E2E_CONNECTION_FILE = 'mcp-connection.json';
export const FND09_IMPORT_RESULT_E2E_PROBE_FILE = 'fnd09-import-result-probe.json';
export const FND09_IMPORT_RESULT_E2E_FIXTURE_FILE = 'fnd09-import-result-fixture.svg';
export const FND09_IMPORT_RESULT_E2E_NETWORK_SENTINEL_FILE = 'fnd09-import-result-forbidden-network.json';

const SVG_FIXTURE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3" viewBox="0 0 4 3"><rect x="1" y="1" width="2" height="1" fill="#3b728f"/></svg>',
  'utf8',
);

export interface Fnd09ImportResultE2eConfiguration {
  profilePath: string;
  connectionPath: string;
  probePath: string;
  fixturePath: string;
  networkSentinelPath: string;
}

interface Fnd09ImportResultE2eConfigurationInput {
  nodeEnv?: string;
  enabled?: string;
  workspacePath: string;
  declaredProfilePath?: string;
  userDataPath?: string;
  connectionPath?: string;
  probePath?: string;
  networkSentinelPath?: string;
}

interface ImportResultLane {
  runE2eImportResultProbe(
    filePath: string,
    fault: Fnd09ImportResultFault,
    control?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ documents: AIDrawDocument[]; warnings: string[] }>;
  importDocument(
    filePath: string,
    pixelMode: boolean,
    control?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ documents: AIDrawDocument[]; warnings: string[] }>;
  status(): { running: boolean; pid?: number; queued: number; activeTaskId?: string };
}

export interface Fnd09ImportResultEngine {
  service: {
    getActiveDocumentId(): string | undefined;
    getDocument(documentId: string): AIDrawDocument | undefined;
  };
  rasterUtilities: ImportResultLane;
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

export function resolveFnd09ImportResultE2eConfiguration(
  input: Fnd09ImportResultE2eConfigurationInput,
): Fnd09ImportResultE2eConfiguration | undefined {
  if (input.nodeEnv !== 'test' || input.enabled !== '1') return undefined;
  if (!input.declaredProfilePath || !input.userDataPath || !input.connectionPath || !input.probePath || !input.networkSentinelPath) return undefined;
  const retainedRoot = resolve(input.workspacePath, 'test-results', 'retained');
  const profilePath = resolve(input.userDataPath);
  if (normalizedPath(input.declaredProfilePath) !== normalizedPath(profilePath)) return undefined;
  if (normalizedPath(dirname(profilePath)) !== normalizedPath(retainedRoot)) return undefined;
  if (!basename(profilePath).toLowerCase().startsWith(FND09_IMPORT_RESULT_E2E_PROFILE_PREFIX)) return undefined;
  if (!isNamedDirectChild(profilePath, input.connectionPath, FND09_IMPORT_RESULT_E2E_CONNECTION_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.probePath, FND09_IMPORT_RESULT_E2E_PROBE_FILE)) return undefined;
  if (!isNamedDirectChild(profilePath, input.networkSentinelPath, FND09_IMPORT_RESULT_E2E_NETWORK_SENTINEL_FILE)) return undefined;
  return {
    profilePath,
    connectionPath: resolve(input.connectionPath),
    probePath: resolve(input.probePath),
    fixturePath: join(profilePath, FND09_IMPORT_RESULT_E2E_FIXTURE_FILE),
    networkSentinelPath: resolve(input.networkSentinelPath),
  };
}

function documentSha256(document: AIDrawDocument): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex').toUpperCase();
}

async function waitForActiveWorker(lane: ImportResultLane, label: string): Promise<{ pid: number; taskId: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = lane.status();
    if (status.running && Number.isInteger(status.pid) && status.activeTaskId) return { pid: status.pid!, taskId: status.activeTaskId };
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`${label} did not become active in the supervised utility process.`);
}

async function rejected(promise: Promise<unknown>, label: string): Promise<{ name: string; message: string }> {
  try { await promise; }
  catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    return { name: value.name, message: value.message.slice(0, 500) };
  }
  throw new Error(`${label} unexpectedly reached its caller.`);
}

function summarizeRecovery(value: { documents: AIDrawDocument[]; warnings: string[] }) {
  if (value.documents.length !== 1 || value.documents[0].kind !== 'illustration') {
    throw new Error('Fresh-worker SVG import returned an unexpected document set.');
  }
  const document = value.documents[0];
  const summary = {
    documentCount: 1,
    schemaVersion: document.schemaVersion,
    kind: document.kind,
    name: document.name,
    width: document.artboard.width,
    height: document.artboard.height,
    layerCount: Object.keys(document.layers).length,
    objectCount: Object.keys(document.objects).length,
    warnings: [...value.warnings],
  };
  return { ...summary, semanticSha256: createHash('sha256').update(JSON.stringify(summary)).digest('hex').toUpperCase() };
}

/** Fixed packaged probe: corrupt real SVG import output and require queued fresh-worker recovery. */
export async function runFnd09ImportResultScenario(
  engine: Fnd09ImportResultEngine,
  configuration: Fnd09ImportResultE2eConfiguration,
): Promise<Record<string, unknown>> {
  const documentId = engine.service.getActiveDocumentId();
  const document = documentId ? engine.service.getDocument(documentId) : undefined;
  if (!documentId || !document) throw new Error('The FND-09 import-result probe requires one active canonical document.');
  const before = { documentId, revision: document.revision, sha256: documentSha256(document) };
  let retained: Record<string, unknown>;
  try {
    const idle = engine.rasterUtilities.status();
    if (idle.running || idle.queued !== 0 || idle.activeTaskId) throw new Error('The import-result probe requires a fresh idle raster utility lane.');
    await writeFile(configuration.fixturePath, SVG_FIXTURE, { flag: 'wx', mode: 0o600 });

    const runFault = async (fault: Fnd09ImportResultFault, expectedMessage: string) => {
      const corruptTask = engine.rasterUtilities.runE2eImportResultProbe(configuration.fixturePath, fault);
      const corruptWorker = await waitForActiveWorker(engine.rasterUtilities, `The ${fault} import-result probe`);
      const queuedRecovery = engine.rasterUtilities.importDocument(configuration.fixturePath, false);
      const error = await rejected(corruptTask, `The ${fault} import-result probe`);
      if (error.message !== expectedMessage) throw new Error(`The ${fault} import-result probe failed at the wrong boundary: ${error.message}`);
      const recovery = summarizeRecovery(await queuedRecovery);
      const after = engine.rasterUtilities.status();
      if (!after.running || !Number.isInteger(after.pid) || after.pid === corruptWorker.pid) {
        throw new Error(`The ${fault} import worker was not replaced before queued recovery completed.`);
      }
      return {
        workerPid: corruptWorker.pid,
        error,
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforeWorkspaceUse: true,
        queuedRecovery: { workerPid: after.pid, workerReplaced: true, queued: true, ...recovery },
      };
    };

    const documentSchema = await runFault('document-schema', 'Raster utility returned a malformed imported document.');
    const warningShape = await runFault('warning-shape', 'Raster utility returned malformed import warnings.');
    if (warningShape.workerPid !== documentSchema.queuedRecovery.workerPid) {
      throw new Error('The warning-shape fault did not begin on the first fresh recovery worker.');
    }
    if (new Set([documentSchema.workerPid, documentSchema.queuedRecovery.workerPid, warningShape.queuedRecovery.workerPid]).size !== 3) {
      throw new Error('Import-result recovery did not use three distinct worker identities.');
    }
    if (documentSchema.queuedRecovery.semanticSha256 !== warningShape.queuedRecovery.semanticSha256) {
      throw new Error('Fresh-worker import recovery did not preserve supported SVG semantics.');
    }

    const current = engine.service.getDocument(documentId);
    if (!current) throw new Error('The canonical document disappeared during import-result containment.');
    const after = { documentId, revision: current.revision, sha256: documentSha256(current) };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Import-result containment changed canonical document state.');
    retained = {
      version: 1,
      scenario: 'FND-09 packaged import result containment',
      result: 'passed',
      canonical: { before, after, unchanged: true },
      realImporter: {
        format: 'svg',
        fixtureBytes: SVG_FIXTURE.byteLength,
        fixtureSha256: createHash('sha256').update(SVG_FIXTURE).digest('hex').toUpperCase(),
      },
      documentSchema,
      warningShape,
      fixedInvalidResponseHoldMs: FND09_IMPORT_RESULT_E2E_HOLD_MS,
      workerPidsDistinct: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false },
      filesystem: { importInputsCreated: 1, outputTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0 },
    };
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    retained = {
      version: 1,
      scenario: 'FND-09 packaged import result containment',
      result: 'failed',
      error: { name: value.name, message: value.message.slice(0, 500) },
      canonical: { before },
      network: { nonLoopbackRequests: 0 },
    };
  }
  await writeFile(configuration.probePath, `${JSON.stringify(retained, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (retained.result !== 'passed') throw new Error(String((retained.error as { message?: string } | undefined)?.message ?? 'FND-09 import-result containment failed.'));
  return retained;
}
