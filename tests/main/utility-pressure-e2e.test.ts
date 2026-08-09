import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument } from '@aidraw/core';
import { quantizeImageToPalette } from '@main/quantize-image';
import { RasterUtilitySupervisor, type UtilityProcessLike } from '@main/utility-supervisor';
import type { UtilityResponse } from '@main/utility-contract';
import {
  FND09_UTILITY_PRESSURE_E2E_CONNECTION_FILE,
  FND09_UTILITY_PRESSURE_E2E_NETWORK_SENTINEL_FILE,
  FND09_UTILITY_PRESSURE_E2E_PROBE_FILE,
  FND09_UTILITY_PRESSURE_E2E_PROFILE_PREFIX,
  FND09_UTILITY_PRESSURE_TINY_PNG_BASE64,
  resolveFnd09UtilityPressureE2eConfiguration,
  runFnd09UtilityPressureScenario,
} from '@main/utility-pressure-e2e';

const temporaryDirectories: string[] = [];

class PressureUtility extends EventEmitter implements UtilityProcessLike {
  readonly messages: unknown[] = [];
  readonly pid = 707;
  killed = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
    const request = message as { id?: string; kind?: string; mode?: string };
    if (request.kind === 'containment-probe' && request.mode === 'pressure-gate') {
      setTimeout(() => this.respond({ id: request.id!, ok: true, kind: 'containment-probe' }), 30);
    } else if (request.kind === 'quantize-image') {
      setImmediate(() => this.respond({ id: request.id!, ok: true, kind: 'quantize-image', changes: [{ x: 0, y: 0, index: 1 }] }));
    }
  }

  kill(): boolean { this.killed = true; return true; }
  respond(response: UtilityResponse): void { this.emit('message', response); }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function isolatedConfiguration() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'aidraw-fnd09-pressure-'));
  temporaryDirectories.push(workspacePath);
  const profilePath = resolve(workspacePath, 'test-results', 'retained', `${FND09_UTILITY_PRESSURE_E2E_PROFILE_PREFIX}unit`);
  await mkdir(profilePath, { recursive: true });
  const connectionPath = join(profilePath, FND09_UTILITY_PRESSURE_E2E_CONNECTION_FILE);
  const probePath = join(profilePath, FND09_UTILITY_PRESSURE_E2E_PROBE_FILE);
  const networkSentinelPath = join(profilePath, FND09_UTILITY_PRESSURE_E2E_NETWORK_SENTINEL_FILE);
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
  const configuration = resolveFnd09UtilityPressureE2eConfiguration(input);
  if (!configuration) throw new Error('Expected an isolated FND-09 pressure configuration.');
  return { input, configuration };
}

describe('isolated FND-09 utility pressure hook', () => {
  it('requires test mode, a retained direct-child profile, and fixed direct-child artifacts', async () => {
    const { input, configuration } = await isolatedConfiguration();
    expect(configuration).toMatchObject({ profilePath: input.userDataPath, connectionPath: input.connectionPath, probePath: input.probePath, networkSentinelPath: input.networkSentinelPath });
    expect(resolveFnd09UtilityPressureE2eConfiguration({ ...input, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveFnd09UtilityPressureE2eConfiguration({ ...input, enabled: '0' })).toBeUndefined();
    expect(resolveFnd09UtilityPressureE2eConfiguration({ ...input, declaredProfilePath: join(input.userDataPath, 'other') })).toBeUndefined();
    expect(resolveFnd09UtilityPressureE2eConfiguration({ ...input, userDataPath: resolve(input.workspacePath, 'outside', FND09_UTILITY_PRESSURE_E2E_PROFILE_PREFIX) })).toBeUndefined();
    expect(resolveFnd09UtilityPressureE2eConfiguration({ ...input, probePath: join(input.userDataPath, 'nested', FND09_UTILITY_PRESSURE_E2E_PROBE_FILE) })).toBeUndefined();
    expect(resolveFnd09UtilityPressureE2eConfiguration({ ...input, networkSentinelPath: join(input.userDataPath, 'other.json') })).toBeUndefined();
  });

  it('uses one locally generated tiny PNG that traverses the production decoder contract', async () => {
    const changes = await quantizeImageToPalette(
      Buffer.from(FND09_UTILITY_PRESSURE_TINY_PNG_BASE64, 'base64'),
      1,
      1,
      [
        { id: 'transparent', name: 'Transparent', color: '#00000000' },
        { id: 'ink', name: 'Ink', color: '#111111ff' },
      ],
      { alphaThreshold: 0.5, dithering: 'none' },
    );
    expect(changes).toEqual([{ x: 0, y: 0, index: 1 }]);
  });

  it('proves oversize admission and exact queue pressure without replacing the worker', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AIDRAW_E2E_UTILITY_PRESSURE', '1');
    const { configuration } = await isolatedConfiguration();
    const worker = new PressureUtility();
    const fork = vi.fn(() => worker);
    const supervisor = new RasterUtilitySupervisor(fork);
    const document = createIllustrationDocument('Pressure-contained canonical document');
    const evidence = await runFnd09UtilityPressureScenario({
      service: { getActiveDocumentId: () => document.id, getDocument: (documentId) => documentId === document.id ? structuredClone(document) : undefined },
      rasterUtilities: supervisor,
      generationUtilities: { status: () => ({ running: false }) },
    }, configuration);

    expect(evidence).toMatchObject({
      result: 'passed',
      canonical: { before: { documentId: document.id, revision: document.revision }, after: { documentId: document.id, revision: document.revision }, unchanged: true },
      oversize: { boundaryBytes: 1_500_000, rejectedBytes: 1_500_001, base64Attempted: false, workerStarted: false, error: { message: 'Encoded image exceeds the utility input limit.' } },
      admission: { activeWorkerPid: 707, waitingLimit: 32, queuedAtLimit: 32, overflowError: { name: 'UtilityBackpressureError', code: 'utility_queue_full', retryable: true } },
      cancellation: { label: 'queued-10', error: { name: 'AbortError' }, queuedAfterCancellation: 31 },
      refill: { label: 'replacement', queuedAfterRefill: 32 },
      drain: { sameWorker: true, workerPid: 707, queuedAfterDrain: 0 },
      generationLaneUntouched: true,
      privacy: { rawUtilityPayloadsPublished: false, publicJobCreated: false },
    });
    expect((evidence.drain as { expectedOrder: string[]; completionOrder: string[] }).completionOrder)
      .toEqual((evidence.drain as { expectedOrder: string[]; completionOrder: string[] }).expectedOrder);
    expect(worker.messages).toHaveLength(33);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(worker.killed).toBe(false);
    const retained = await readFile(configuration.probePath, 'utf8');
    expect(JSON.parse(retained)).toEqual(evidence);
    expect(retained).not.toMatch(/Bearer|Authorization|"token"\s*:|"prompt"\s*:|"credential"\s*:/i);
    await expect(access(configuration.networkSentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
    supervisor.stop();
  });
});
