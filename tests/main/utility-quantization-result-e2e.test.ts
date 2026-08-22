import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument } from '@aidraw/core';
import { quantizeImageToPalette } from '@main/quantize-image';
import type { UtilityResponse } from '@main/utility-contract';
import {
  createFnd09InvalidQuantizationResult,
  FND09_QUANTIZATION_RESULT_E2E_OPTIONS,
  FND09_QUANTIZATION_RESULT_E2E_PALETTE,
  FND09_QUANTIZATION_RESULT_E2E_TINY_PNG_BASE64,
  type Fnd09QuantizationResultFault,
} from '@main/utility-quantization-result-e2e-contract';
import {
  FND09_QUANTIZATION_RESULT_E2E_CONNECTION_FILE,
  FND09_QUANTIZATION_RESULT_E2E_NETWORK_SENTINEL_FILE,
  FND09_QUANTIZATION_RESULT_E2E_PROBE_FILE,
  FND09_QUANTIZATION_RESULT_E2E_PROFILE_PREFIX,
  resolveFnd09QuantizationResultE2eConfiguration,
  runFnd09QuantizationResultScenario,
} from '@main/utility-quantization-result-e2e';
import { RasterUtilitySupervisor, type UtilityProcessLike } from '@main/utility-supervisor';

const temporaryDirectories: string[] = [];

class QuantizationResultUtility extends EventEmitter implements UtilityProcessLike {
  readonly messages: unknown[] = [];
  killed = false;

  constructor(readonly pid: number) { super(); }

  postMessage(message: unknown): void {
    this.messages.push(message);
    const request = message as { id?: string; kind?: string; e2eResultFault?: Fnd09QuantizationResultFault };
    if (request.kind !== 'quantize-image') return;
    const changes = request.e2eResultFault
      ? createFnd09InvalidQuantizationResult(request.e2eResultFault)
      : [{ x: 0, y: 0, index: 1 }];
    setTimeout(() => this.respond({ id: request.id!, ok: true, kind: 'quantize-image', changes }), request.e2eResultFault ? 20 : 0);
  }

  kill(): boolean { this.killed = true; return true; }
  respond(response: UtilityResponse): void { this.emit('message', response); }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function isolatedConfiguration() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'aidraw-fnd09-quantization-result-'));
  temporaryDirectories.push(workspacePath);
  const profilePath = resolve(workspacePath, 'test-results', 'retained', `${FND09_QUANTIZATION_RESULT_E2E_PROFILE_PREFIX}unit`);
  await mkdir(profilePath, { recursive: true });
  const connectionPath = join(profilePath, FND09_QUANTIZATION_RESULT_E2E_CONNECTION_FILE);
  const probePath = join(profilePath, FND09_QUANTIZATION_RESULT_E2E_PROBE_FILE);
  const networkSentinelPath = join(profilePath, FND09_QUANTIZATION_RESULT_E2E_NETWORK_SENTINEL_FILE);
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
  const configuration = resolveFnd09QuantizationResultE2eConfiguration(input);
  if (!configuration) throw new Error('Expected an isolated FND-09 quantization-result configuration.');
  return { input, configuration };
}

describe('isolated FND-09 quantization-result hook', () => {
  it('requires test mode, a retained direct-child profile, and fixed direct-child artifacts', async () => {
    const { input, configuration } = await isolatedConfiguration();
    expect(configuration).toMatchObject({
      profilePath: input.userDataPath,
      connectionPath: input.connectionPath,
      probePath: input.probePath,
      networkSentinelPath: input.networkSentinelPath,
    });
    expect(resolveFnd09QuantizationResultE2eConfiguration({ ...input, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveFnd09QuantizationResultE2eConfiguration({ ...input, enabled: '0' })).toBeUndefined();
    expect(resolveFnd09QuantizationResultE2eConfiguration({ ...input, declaredProfilePath: join(input.userDataPath, 'other') })).toBeUndefined();
    expect(resolveFnd09QuantizationResultE2eConfiguration({ ...input, userDataPath: resolve(input.workspacePath, 'outside', FND09_QUANTIZATION_RESULT_E2E_PROFILE_PREFIX) })).toBeUndefined();
    expect(resolveFnd09QuantizationResultE2eConfiguration({ ...input, probePath: join(input.userDataPath, 'nested', FND09_QUANTIZATION_RESULT_E2E_PROBE_FILE) })).toBeUndefined();
    expect(resolveFnd09QuantizationResultE2eConfiguration({ ...input, networkSentinelPath: join(input.userDataPath, 'other.json') })).toBeUndefined();
  });

  it('uses a deterministic one-pixel PNG that traverses the production decoder and quantizer', async () => {
    const changes = await quantizeImageToPalette(
      Buffer.from(FND09_QUANTIZATION_RESULT_E2E_TINY_PNG_BASE64, 'base64'),
      1,
      1,
      FND09_QUANTIZATION_RESULT_E2E_PALETTE,
      FND09_QUANTIZATION_RESULT_E2E_OPTIONS,
    );
    expect(changes).toEqual([{ x: 0, y: 0, index: 1 }]);
  });

  it('rejects over-budget and contradictory child output before queued fresh-worker recovery', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AIDRAW_E2E_UTILITY_QUANTIZATION_RESULT', '1');
    const { configuration } = await isolatedConfiguration();
    const workers = [new QuantizationResultUtility(811), new QuantizationResultUtility(922), new QuantizationResultUtility(1033)];
    let workerIndex = 0;
    const supervisor = new RasterUtilitySupervisor(() => workers[workerIndex++]);
    const document = createIllustrationDocument('Quantization-result-contained canonical document');
    const evidence = await runFnd09QuantizationResultScenario({
      service: {
        getActiveDocumentId: () => document.id,
        getDocument: (documentId) => documentId === document.id ? structuredClone(document) : undefined,
      },
      rasterUtilities: supervisor,
    }, configuration);

    expect(evidence).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged quantization result containment',
      result: 'passed',
      canonical: { before: { documentId: document.id, revision: document.revision }, after: { documentId: document.id, revision: document.revision }, unchanged: true },
      overBudget: {
        workerPid: 811,
        error: { message: 'Raster utility quantization result exceeds its 1-pixel output budget.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        requestPixelBudget: 1,
        returnedChanges: 2,
        countGateBeforeDuplicateAllocation: true,
        queuedRecovery: { workerPid: 922, workerReplaced: true, queued: true, changes: 1, sha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
      },
      contradictory: {
        workerPid: 922,
        error: { message: 'Raster utility returned a malformed quantization result.' },
        resultReturnedToCaller: false,
        payloadRetained: false,
        contradiction: 'x=1 lies outside the originating 1x1 request',
        queuedRecovery: { workerPid: 1033, workerReplaced: true, queued: true, changes: 1, sha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
      },
      fixedInvalidResponseHoldMs: 150,
      workerPidsDistinct: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false },
      network: { nonLoopbackRequests: 0 },
    });
    expect(workers[0].killed).toBe(true);
    expect(workers[1].killed).toBe(true);
    expect(workers[2].killed).toBe(false);
    expect(workerIndex).toBe(3);
    const retained = await readFile(configuration.probePath, 'utf8');
    expect(JSON.parse(retained)).toEqual(evidence);
    expect(retained).not.toMatch(/Bearer|Authorization|"token"\s*:|"data"\s*:|"prompt"\s*:|"credential"\s*:/i);
    await expect(access(configuration.networkSentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
    supervisor.stop();
  });

  it('keeps the private worker fault unavailable without the exact isolated gate', async () => {
    const supervisor = new RasterUtilitySupervisor(() => new QuantizationResultUtility(1444));
    await expect(supervisor.runE2eQuantizationResultProbe('over-budget')).rejects.toThrow(
      'The quantization-result probe is unavailable outside isolated packaged QA.',
    );
    expect(supervisor.status()).toMatchObject({ running: false, queued: 0 });
    supervisor.stop();
  });
});
