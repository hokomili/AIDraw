import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument } from '@aidraw/core';
import type { ImportUtilityRequest } from '@main/utility-contract';
import { runImportUtilityRequest } from '@main/utility-import';
import {
  createFnd09InvalidImportResult,
} from '@main/utility-import-result-e2e-contract';
import {
  FND09_IMPORT_RESULT_E2E_CONNECTION_FILE,
  FND09_IMPORT_RESULT_E2E_FIXTURE_FILE,
  FND09_IMPORT_RESULT_E2E_NETWORK_SENTINEL_FILE,
  FND09_IMPORT_RESULT_E2E_PROBE_FILE,
  FND09_IMPORT_RESULT_E2E_PROFILE_PREFIX,
  resolveFnd09ImportResultE2eConfiguration,
  runFnd09ImportResultScenario,
} from '@main/utility-import-result-e2e';
import { RasterUtilitySupervisor, type UtilityProcessLike } from '@main/utility-supervisor';

const temporaryDirectories: string[] = [];
const svgFixture = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3" viewBox="0 0 4 3"><rect x="1" y="1" width="2" height="1" fill="#3b728f"/></svg>';

class ImportResultUtility extends EventEmitter implements UtilityProcessLike {
  readonly messages: unknown[] = [];
  killed = false;

  constructor(readonly pid: number) { super(); }

  postMessage(message: unknown): void {
    this.messages.push(message);
    const request = message as ImportUtilityRequest;
    if (request.kind !== 'import-document') return;
    void runImportUtilityRequest(request).then((imported) => {
      const returned = request.e2eResultFault
        ? createFnd09InvalidImportResult(imported, request.e2eResultFault)
        : imported;
      setTimeout(() => this.emit('message', {
        id: request.id,
        ok: true,
        kind: request.kind,
        documents: returned.documents,
        warnings: returned.warnings,
      }), request.e2eResultFault ? 20 : 0);
    });
  }

  kill(): boolean { this.killed = true; return true; }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function isolatedConfiguration() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'aidraw-fnd09-import-result-'));
  temporaryDirectories.push(workspacePath);
  const profilePath = resolve(workspacePath, 'test-results', 'retained', `${FND09_IMPORT_RESULT_E2E_PROFILE_PREFIX}unit`);
  await mkdir(profilePath, { recursive: true });
  const connectionPath = join(profilePath, FND09_IMPORT_RESULT_E2E_CONNECTION_FILE);
  const probePath = join(profilePath, FND09_IMPORT_RESULT_E2E_PROBE_FILE);
  const networkSentinelPath = join(profilePath, FND09_IMPORT_RESULT_E2E_NETWORK_SENTINEL_FILE);
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
  const configuration = resolveFnd09ImportResultE2eConfiguration(input);
  if (!configuration) throw new Error('Expected an isolated FND-09 import-result configuration.');
  return { input, configuration };
}

describe('isolated FND-09 import-result hook', () => {
  it('requires test mode, a retained direct-child profile, and fixed direct-child artifacts', async () => {
    const { input, configuration } = await isolatedConfiguration();
    expect(configuration).toMatchObject({
      profilePath: input.userDataPath,
      connectionPath: input.connectionPath,
      probePath: input.probePath,
      fixturePath: join(input.userDataPath, FND09_IMPORT_RESULT_E2E_FIXTURE_FILE),
      networkSentinelPath: input.networkSentinelPath,
    });
    expect(resolveFnd09ImportResultE2eConfiguration({ ...input, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveFnd09ImportResultE2eConfiguration({ ...input, enabled: '0' })).toBeUndefined();
    expect(resolveFnd09ImportResultE2eConfiguration({ ...input, declaredProfilePath: join(input.userDataPath, 'other') })).toBeUndefined();
    expect(resolveFnd09ImportResultE2eConfiguration({ ...input, userDataPath: resolve(input.workspacePath, 'outside', FND09_IMPORT_RESULT_E2E_PROFILE_PREFIX) })).toBeUndefined();
    expect(resolveFnd09ImportResultE2eConfiguration({ ...input, probePath: join(input.userDataPath, 'nested', FND09_IMPORT_RESULT_E2E_PROBE_FILE) })).toBeUndefined();
    expect(resolveFnd09ImportResultE2eConfiguration({ ...input, networkSentinelPath: join(input.userDataPath, 'other.json') })).toBeUndefined();
  });

  it('uses the production SVG importer before mutating document schema or warning shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-fnd09-import-baseline-'));
    temporaryDirectories.push(root);
    const filePath = join(root, FND09_IMPORT_RESULT_E2E_FIXTURE_FILE);
    await writeFile(filePath, svgFixture, 'utf8');
    const imported = await runImportUtilityRequest({ id: 'baseline', kind: 'import-document', filePath, pixelMode: false });
    expect(imported.documents).toHaveLength(1);
    expect(imported.documents[0]).toMatchObject({ kind: 'illustration', schemaVersion: 2, artboard: { width: 4, height: 3 } });
    expect(imported.warnings).toEqual([]);
    expect(createFnd09InvalidImportResult(imported, 'document-schema').documents[0]).toMatchObject({ schemaVersion: 3 });
    expect(createFnd09InvalidImportResult(imported, 'warning-shape').warnings).toEqual([17]);
  });

  it('rejects malformed document and warning results before queued fresh-worker recovery', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AIDRAW_E2E_UTILITY_IMPORT_RESULT', '1');
    const { configuration } = await isolatedConfiguration();
    const workers = [new ImportResultUtility(3111), new ImportResultUtility(3222), new ImportResultUtility(3333)];
    let workerIndex = 0;
    const supervisor = new RasterUtilitySupervisor(() => workers[workerIndex++]);
    const canonical = createIllustrationDocument('Import-result-contained canonical document');
    const evidence = await runFnd09ImportResultScenario({
      service: {
        getActiveDocumentId: () => canonical.id,
        getDocument: (documentId) => documentId === canonical.id ? structuredClone(canonical) : undefined,
      },
      rasterUtilities: supervisor,
    }, configuration);

    expect(evidence).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged import result containment',
      result: 'passed',
      canonical: { before: { documentId: canonical.id, revision: canonical.revision }, after: { documentId: canonical.id, revision: canonical.revision }, unchanged: true },
      realImporter: { format: 'svg', fixtureBytes: expect.any(Number), fixtureSha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
      documentSchema: {
        workerPid: 3111,
        error: { message: 'Raster utility returned a malformed imported document.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforeWorkspaceUse: true,
        queuedRecovery: { workerPid: 3222, workerReplaced: true, queued: true, documentCount: 1, kind: 'illustration', schemaVersion: 2, width: 4, height: 3, warnings: [], semanticSha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
      },
      warningShape: {
        workerPid: 3222,
        error: { message: 'Raster utility returned malformed import warnings.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        rejectedBeforeWorkspaceUse: true,
        queuedRecovery: { workerPid: 3333, workerReplaced: true, queued: true, documentCount: 1, kind: 'illustration', schemaVersion: 2, width: 4, height: 3, warnings: [], semanticSha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
      },
      workerPidsDistinct: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false },
      filesystem: { importInputsCreated: 1, outputTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0 },
    });
    expect(workers[0].killed).toBe(true);
    expect(workers[1].killed).toBe(true);
    expect(workers[2].killed).toBe(false);
    expect(workerIndex).toBe(3);
    expect(await readFile(configuration.fixturePath, 'utf8')).toBe(svgFixture);
    const retained = await readFile(configuration.probePath, 'utf8');
    expect(JSON.parse(retained)).toEqual(evidence);
    expect(retained).not.toMatch(/Bearer|Authorization|"token"\s*:|"documents?"\s*:|"data(?:Base64)?"\s*:|"prompt"\s*:|"credential"\s*:/i);
    await expect(access(configuration.networkSentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
    supervisor.stop();
  });

  it('keeps the private worker fault unavailable without the exact isolated gate', async () => {
    const supervisor = new RasterUtilitySupervisor(() => new ImportResultUtility(3444));
    await expect(supervisor.runE2eImportResultProbe('C:\\approved\\fixture.svg', 'document-schema')).rejects.toThrow(
      'The import-result probe is unavailable outside isolated packaged QA.',
    );
    expect(supervisor.status()).toMatchObject({ running: false, queued: 0 });
    supervisor.stop();
  });
});
