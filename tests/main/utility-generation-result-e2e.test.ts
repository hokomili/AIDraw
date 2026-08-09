import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument } from '@aidraw/core';
import type { GenerationUtilityRequest } from '@main/utility-contract';
import {
  createFnd09GenerationResultOutputs,
  FND09_GENERATION_RESULT_E2E_PNG_BASE64,
  FND09_GENERATION_RESULT_E2E_PROMPT,
  FND09_GENERATION_RESULT_E2E_SEED,
} from '@main/utility-generation-result-e2e-contract';
import {
  FND09_GENERATION_RESULT_E2E_CONNECTION_FILE,
  FND09_GENERATION_RESULT_E2E_NETWORK_SENTINEL_FILE,
  FND09_GENERATION_RESULT_E2E_PROBE_FILE,
  FND09_GENERATION_RESULT_E2E_PROFILE_PREFIX,
  resolveFnd09GenerationResultE2eConfiguration,
  runFnd09GenerationResultScenario,
} from '@main/utility-generation-result-e2e';
import { RasterUtilitySupervisor, type UtilityProcessLike } from '@main/utility-supervisor';

const temporaryDirectories: string[] = [];

class GenerationResultUtility extends EventEmitter implements UtilityProcessLike {
  readonly messages: unknown[] = [];
  killed = false;

  constructor(readonly pid: number) { super(); }

  postMessage(message: unknown): void {
    this.messages.push(message);
    const request = message as GenerationUtilityRequest;
    if (request.kind !== 'generation-run' || !request.e2eResultFixture) return;
    const outputs = createFnd09GenerationResultOutputs(request.request, request.e2eResultFixture);
    setTimeout(() => this.emit('message', {
      id: request.id,
      ok: true,
      kind: request.kind,
      outputs,
    }), request.e2eResultFixture === 'valid' ? 0 : 20);
  }

  kill(): boolean { this.killed = true; return true; }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function isolatedConfiguration() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'aidraw-fnd09-generation-result-'));
  temporaryDirectories.push(workspacePath);
  const profilePath = resolve(workspacePath, 'test-results', 'retained', `${FND09_GENERATION_RESULT_E2E_PROFILE_PREFIX}unit`);
  await mkdir(profilePath, { recursive: true });
  const connectionPath = join(profilePath, FND09_GENERATION_RESULT_E2E_CONNECTION_FILE);
  const probePath = join(profilePath, FND09_GENERATION_RESULT_E2E_PROBE_FILE);
  const networkSentinelPath = join(profilePath, FND09_GENERATION_RESULT_E2E_NETWORK_SENTINEL_FILE);
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
  const configuration = resolveFnd09GenerationResultE2eConfiguration(input);
  if (!configuration) throw new Error('Expected an isolated FND-09 generation-result configuration.');
  return { input, configuration };
}

describe('isolated FND-09 generation-result hook', () => {
  it('requires test mode, a retained direct-child profile, and fixed direct-child artifacts', async () => {
    const { input, configuration } = await isolatedConfiguration();
    expect(configuration).toMatchObject({
      profilePath: input.userDataPath,
      connectionPath: input.connectionPath,
      probePath: input.probePath,
      networkSentinelPath: input.networkSentinelPath,
    });
    expect(resolveFnd09GenerationResultE2eConfiguration({ ...input, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveFnd09GenerationResultE2eConfiguration({ ...input, enabled: '0' })).toBeUndefined();
    expect(resolveFnd09GenerationResultE2eConfiguration({ ...input, declaredProfilePath: join(input.userDataPath, 'other') })).toBeUndefined();
    expect(resolveFnd09GenerationResultE2eConfiguration({ ...input, userDataPath: resolve(input.workspacePath, 'outside', FND09_GENERATION_RESULT_E2E_PROFILE_PREFIX) })).toBeUndefined();
    expect(resolveFnd09GenerationResultE2eConfiguration({ ...input, probePath: join(input.userDataPath, 'nested', FND09_GENERATION_RESULT_E2E_PROBE_FILE) })).toBeUndefined();
    expect(resolveFnd09GenerationResultE2eConfiguration({ ...input, networkSentinelPath: join(input.userDataPath, 'other.json') })).toBeUndefined();
  });

  it('creates one deterministic provider-free baseline and only the five intended contract faults', () => {
    const document = createIllustrationDocument('Generation-result local fixture');
    const request = {
      documentId: document.id,
      provider: 'stability' as const,
      mode: 'create' as const,
      prompt: FND09_GENERATION_RESULT_E2E_PROMPT,
      sourceAssetIds: [],
      size: { width: 1, height: 1 },
      resultCount: 1,
      seed: FND09_GENERATION_RESULT_E2E_SEED,
      providerOptions: {},
    };
    expect(createFnd09GenerationResultOutputs(request, 'valid')).toEqual([{
      id: 'fnd09-generation-result-0',
      mimeType: 'image/png',
      data: FND09_GENERATION_RESULT_E2E_PNG_BASE64,
      width: 1,
      height: 1,
      seed: FND09_GENERATION_RESULT_E2E_SEED,
      providerMetadata: { fixture: 'local-deterministic', resultIndex: 0 },
    }]);
    expect(createFnd09GenerationResultOutputs(request, 'result-count')).toHaveLength(2);
    expect(createFnd09GenerationResultOutputs(request, 'mime-header')[0]).toMatchObject({ mimeType: 'image/jpeg', width: 1, height: 1 });
    expect(createFnd09GenerationResultOutputs(request, 'dimension-header')[0]).toMatchObject({ mimeType: 'image/png', width: 2, height: 1 });
    expect(createFnd09GenerationResultOutputs(request, 'seed')[0]).toMatchObject({ seed: FND09_GENERATION_RESULT_E2E_SEED + 1 });
    expect(createFnd09GenerationResultOutputs(request, 'metadata')[0]).toMatchObject({ providerMetadata: [] });
    expect(() => createFnd09GenerationResultOutputs({ ...request, resultCount: 2 }, 'valid')).toThrow('exact provider-free local request baseline');
  });

  it('rejects five invalid results before queued fresh-worker recovery without touching raster or canonical state', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AIDRAW_E2E_UTILITY_GENERATION_RESULT', '1');
    const { configuration } = await isolatedConfiguration();
    const workers = [3111, 3222, 3333, 3444, 3555, 3666].map((pid) => new GenerationResultUtility(pid));
    let workerIndex = 0;
    const generationUtilities = new RasterUtilitySupervisor(() => workers[workerIndex++]);
    const canonical = createIllustrationDocument('Generation-result-contained canonical document');
    const evidence = await runFnd09GenerationResultScenario({
      service: {
        getActiveDocumentId: () => canonical.id,
        getDocument: (documentId) => documentId === canonical.id ? structuredClone(canonical) : undefined,
      },
      rasterUtilities: { status: () => ({ running: false, queued: 0 }) },
      generationUtilities,
    }, configuration);

    expect(evidence).toMatchObject({
      version: 1,
      scenario: 'FND-09 packaged generation result containment',
      result: 'passed',
      canonical: { before: { documentId: canonical.id, revision: canonical.revision }, after: { documentId: canonical.id, revision: canonical.revision }, unchanged: true },
      requestContract: { provider: 'stability', mode: 'create', resultCount: 1, width: 1, height: 1, seed: FND09_GENERATION_RESULT_E2E_SEED, credentialSupplied: false, providerInvoked: false },
      resultCount: { workerPid: 3111, error: { message: 'Generation utility returned more than the requested 1 result.' }, rejectedBeforePreviewOrJobUse: true, queuedRecovery: { workerPid: 3222, outputCount: 1 } },
      mimeHeader: { workerPid: 3222, error: { message: 'Generation utility returned a malformed image result.' }, queuedRecovery: { workerPid: 3333, outputCount: 1 } },
      dimensionHeader: { workerPid: 3333, error: { message: 'Generation utility returned a malformed image result.' }, queuedRecovery: { workerPid: 3444, outputCount: 1 } },
      seed: { workerPid: 3444, error: { message: 'Generation utility returned a malformed result.' }, queuedRecovery: { workerPid: 3555, outputCount: 1 } },
      metadata: { workerPid: 3555, error: { message: 'Generation utility returned a malformed result.' }, queuedRecovery: { workerPid: 3666, outputCount: 1 } },
      workerPidsDistinct: true,
      recoverySemanticHashesAgree: true,
      rasterLaneUntouched: true,
      privacy: { rendererCreated: false, invalidPayloadPublished: false, publicJobCreated: false, promptRetained: false, providerMetadataRetained: false },
      filesystem: { inputTargetsCreated: 0, outputTargetsCreated: 0 },
      network: { nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 },
    });
    expect(workers.slice(0, 5).every((worker) => worker.killed)).toBe(true);
    expect(workers[5].killed).toBe(false);
    expect(workerIndex).toBe(6);
    const retained = await readFile(configuration.probePath, 'utf8');
    expect(JSON.parse(retained)).toEqual(evidence);
    expect(retained).not.toMatch(/Bearer|Authorization|"token"\s*:|"data(?:Base64)?"\s*:|"prompt"\s*:|"credential"\s*:|"providerMetadata"\s*:/i);
    await expect(access(configuration.networkSentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
    generationUtilities.stop();
  });

  it('keeps the private local result unavailable without the exact isolated gate', async () => {
    const supervisor = new RasterUtilitySupervisor(() => new GenerationResultUtility(3777));
    const document = createIllustrationDocument('No generation-result fixture authority');
    await expect(supervisor.runE2eGenerationResultProbe(document, 'valid')).rejects.toThrow(
      'The generation-result probe is unavailable outside isolated packaged QA.',
    );
    expect(supervisor.status()).toMatchObject({ running: false, queued: 0 });
    supervisor.stop();
  });
});
