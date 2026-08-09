import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument, createPixelDocument } from '@aidraw/core';
import { exportDocument } from '@main/export-document';
import type { SerializedExportArtifact, UtilityResponse } from '@main/utility-contract';
import {
  createFnd09InvalidExportArtifact,
  type Fnd09ExportResultFault,
} from '@main/utility-export-result-e2e-contract';
import {
  FND09_EXPORT_RESULT_E2E_CONNECTION_FILE,
  FND09_EXPORT_RESULT_E2E_NETWORK_SENTINEL_FILE,
  FND09_EXPORT_RESULT_E2E_PROBE_FILE,
  FND09_EXPORT_RESULT_E2E_PROFILE_PREFIX,
  resolveFnd09ExportResultE2eConfiguration,
  runFnd09ExportResultScenario,
} from '@main/utility-export-result-e2e';
import { RasterUtilitySupervisor, type UtilityProcessLike } from '@main/utility-supervisor';

const temporaryDirectories: string[] = [];

function serialize(artifact: Awaited<ReturnType<typeof exportDocument>>): SerializedExportArtifact {
  return {
    dataBase64: artifact.data.toString('base64'),
    mimeType: artifact.mimeType,
    extension: artifact.extension,
    report: artifact.report,
    companion: artifact.companion ? {
      dataBase64: artifact.companion.data.toString('base64'),
      extension: artifact.companion.extension,
      mimeType: artifact.companion.mimeType,
      name: artifact.companion.name,
    } : undefined,
    companions: artifact.companions?.map((companion) => ({
      dataBase64: companion.data.toString('base64'),
      extension: companion.extension,
      mimeType: companion.mimeType,
      name: companion.name,
    })),
  };
}

class ExportResultUtility extends EventEmitter implements UtilityProcessLike {
  readonly messages: unknown[] = [];
  killed = false;

  constructor(readonly pid: number) { super(); }

  postMessage(message: unknown): void {
    this.messages.push(message);
    const request = message as { id?: string; kind?: string; document?: Parameters<typeof exportDocument>[0]; e2eArtifactFault?: Fnd09ExportResultFault };
    if (request.kind !== 'export-document' || !request.document) return;
    void exportDocument(request.document, 'sprite-sheet', { scale: 1 }).then((artifact) => {
      const actual = serialize(artifact);
      const returned = request.e2eArtifactFault ? createFnd09InvalidExportArtifact(actual, request.e2eArtifactFault) : actual;
      setTimeout(() => this.respond({ id: request.id!, ok: true, kind: 'export-document', artifact: returned }), request.e2eArtifactFault ? 20 : 0);
    });
  }

  kill(): boolean { this.killed = true; return true; }
  respond(response: UtilityResponse): void { this.emit('message', response); }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function isolatedConfiguration() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'aidraw-fnd09-export-result-'));
  temporaryDirectories.push(workspacePath);
  const profilePath = resolve(workspacePath, 'test-results', 'retained', `${FND09_EXPORT_RESULT_E2E_PROFILE_PREFIX}unit`);
  await mkdir(profilePath, { recursive: true });
  const connectionPath = join(profilePath, FND09_EXPORT_RESULT_E2E_CONNECTION_FILE);
  const probePath = join(profilePath, FND09_EXPORT_RESULT_E2E_PROBE_FILE);
  const networkSentinelPath = join(profilePath, FND09_EXPORT_RESULT_E2E_NETWORK_SENTINEL_FILE);
  const input = {
    nodeEnv: 'test',
    enabled: '1',
    workspacePath,
    declaredProfilePath: profilePath,
    userDataPath: profilePath,
    connectionPath,
    probePath,
    networkSentinelPath,
  };
  const configuration = resolveFnd09ExportResultE2eConfiguration(input);
  if (!configuration) throw new Error('Expected an isolated FND-09 export-result configuration.');
  return { input, configuration };
}

describe('isolated FND-09 export-result hook', () => {
  it('requires test mode, a retained direct-child profile, and fixed direct-child artifacts', async () => {
    const { input, configuration } = await isolatedConfiguration();
    expect(configuration).toMatchObject({
      profilePath: input.userDataPath,
      connectionPath: input.connectionPath,
      probePath: input.probePath,
      networkSentinelPath: input.networkSentinelPath,
    });
    expect(resolveFnd09ExportResultE2eConfiguration({ ...input, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveFnd09ExportResultE2eConfiguration({ ...input, enabled: '0' })).toBeUndefined();
    expect(resolveFnd09ExportResultE2eConfiguration({ ...input, declaredProfilePath: join(input.userDataPath, 'other') })).toBeUndefined();
    expect(resolveFnd09ExportResultE2eConfiguration({ ...input, userDataPath: resolve(input.workspacePath, 'outside', FND09_EXPORT_RESULT_E2E_PROFILE_PREFIX) })).toBeUndefined();
    expect(resolveFnd09ExportResultE2eConfiguration({ ...input, probePath: join(input.userDataPath, 'nested', FND09_EXPORT_RESULT_E2E_PROBE_FILE) })).toBeUndefined();
    expect(resolveFnd09ExportResultE2eConfiguration({ ...input, networkSentinelPath: join(input.userDataPath, 'other.json') })).toBeUndefined();
  });

  it('uses the production sprite-sheet exporter before mutating either serialized member', async () => {
    const artifact = await exportDocument(createPixelDocument('sprite', 'Export result fixture'), 'sprite-sheet', { scale: 1 });
    const serialized = serialize(artifact);
    expect(serialized).toMatchObject({
      mimeType: 'image/png',
      extension: 'png',
      report: { warnings: [], rasterized: [] },
      companion: { mimeType: 'application/json', extension: 'json' },
    });
    expect(Buffer.from(serialized.dataBase64, 'base64')).toEqual(artifact.data);
    expect(Buffer.from(serialized.companion!.dataBase64, 'base64')).toEqual(artifact.companion!.data);
    expect(createFnd09InvalidExportArtifact(serialized, 'primary-base64')).toMatchObject({ dataBase64: 'not-canonical-base64' });
    expect(createFnd09InvalidExportArtifact(serialized, 'companion-base64').companion).toMatchObject({ dataBase64: 'not-canonical-base64' });
  });

  it('rejects malformed primary and companion envelopes before queued fresh-worker recovery', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AIDRAW_E2E_UTILITY_EXPORT_RESULT', '1');
    const { configuration } = await isolatedConfiguration();
    const workers = [new ExportResultUtility(1811), new ExportResultUtility(1922), new ExportResultUtility(2033)];
    let workerIndex = 0;
    const supervisor = new RasterUtilitySupervisor(() => workers[workerIndex++]);
    const canonical = createIllustrationDocument('Export-result-contained canonical document');
    const evidence = await runFnd09ExportResultScenario({
      service: {
        getActiveDocumentId: () => canonical.id,
        getDocument: (documentId) => documentId === canonical.id ? structuredClone(canonical) : undefined,
      },
      rasterUtilities: supervisor,
      generationUtilities: { status: () => ({ running: false }) },
    }, configuration);

    expect(evidence).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged export artifact result containment',
      result: 'passed',
      canonical: { before: { documentId: canonical.id, revision: canonical.revision }, after: { documentId: canonical.id, revision: canonical.revision }, unchanged: true },
      realExporter: { format: 'sprite-sheet', primary: 'image/png', companion: 'application/json' },
      primary: {
        workerPid: 1811,
        error: { message: 'Raster utility returned a malformed export artifact.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforeCallerBase64Decode: true,
        exportTargetWritten: false,
        queuedRecovery: { workerPid: 1922, workerReplaced: true, queued: true, primary: { sha256: expect.stringMatching(/^[A-F0-9]{64}$/) }, companion: { sha256: expect.stringMatching(/^[A-F0-9]{64}$/) } },
      },
      companion: {
        workerPid: 1922,
        error: { message: 'Raster utility returned a malformed export companion.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforeCallerBase64Decode: true,
        exportTargetWritten: false,
        queuedRecovery: { workerPid: 2033, workerReplaced: true, queued: true, primary: { sha256: expect.stringMatching(/^[A-F0-9]{64}$/) }, companion: { sha256: expect.stringMatching(/^[A-F0-9]{64}$/) } },
      },
      workerPidsDistinct: true,
      generationLaneUntouched: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false },
      filesystem: { exportTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
    });
    expect(workers[0].killed).toBe(true);
    expect(workers[1].killed).toBe(true);
    expect(workers[2].killed).toBe(false);
    expect(workerIndex).toBe(3);
    const retained = await readFile(configuration.probePath, 'utf8');
    expect(JSON.parse(retained)).toEqual(evidence);
    expect(retained).not.toMatch(/Bearer|Authorization|"token"\s*:|"data(?:Base64)?"\s*:|"prompt"\s*:|"credential"\s*:/i);
    await expect(access(configuration.networkSentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
    supervisor.stop();
  });

  it('keeps the private worker fault unavailable without the exact isolated gate', async () => {
    const supervisor = new RasterUtilitySupervisor(() => new ExportResultUtility(2444));
    await expect(supervisor.runE2eExportResultProbe(createPixelDocument(), 'primary-base64')).rejects.toThrow(
      'The export-result probe is unavailable outside isolated packaged QA.',
    );
    expect(supervisor.status()).toMatchObject({ running: false, queued: 0 });
    supervisor.stop();
  });
});
