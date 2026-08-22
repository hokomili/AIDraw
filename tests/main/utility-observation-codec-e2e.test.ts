import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument } from '@aidraw/core';
import type { UtilityResponse } from '@main/utility-contract';
import {
  corruptFnd09ObservationIdat,
  FND09_OBSERVATION_CODEC_E2E_HOLD_MS,
  isFnd09ObservationCodecE2eEnabled,
} from '@main/utility-observation-codec-e2e-contract';
import {
  FND09_OBSERVATION_CODEC_E2E_CONNECTION_FILE,
  FND09_OBSERVATION_CODEC_E2E_NETWORK_SENTINEL_FILE,
  FND09_OBSERVATION_CODEC_E2E_PROBE_FILE,
  FND09_OBSERVATION_CODEC_E2E_PROFILE_PREFIX,
  resolveFnd09ObservationCodecE2eConfiguration,
  runFnd09ObservationCodecScenario,
} from '@main/utility-observation-codec-e2e';
import { RasterUtilitySupervisor, type UtilityProcessLike } from '@main/utility-supervisor';

const temporaryDirectories: string[] = [];

function observationResult(data: string): Record<string, unknown> {
  return {
    available: true,
    mimeType: 'image/png',
    width: 8,
    height: 6,
    scale: 1,
    region: { x: 0, y: 0, width: 8, height: 6 },
    background: 'transparent',
    data,
  };
}

class ObservationCodecUtility extends EventEmitter implements UtilityProcessLike {
  readonly messages: unknown[] = [];
  killed = false;

  constructor(readonly pid: number, private readonly pngBase64: string) { super(); }

  postMessage(message: unknown): void {
    this.messages.push(message);
    const request = message as { id?: string; kind?: string; e2eCorruptIdat?: boolean };
    if (request.kind !== 'capture-observation') return;
    const data = request.e2eCorruptIdat ? corruptFnd09ObservationIdat(this.pngBase64) : this.pngBase64;
    setTimeout(() => this.respond({
      id: request.id!,
      ok: true,
      kind: 'capture-observation',
      result: observationResult(data),
    }), request.e2eCorruptIdat ? 20 : 0);
  }

  kill(): boolean { this.killed = true; return true; }
  respond(response: UtilityResponse): void { this.emit('message', response); }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function isolatedConfiguration() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'aidraw-fnd09-observation-codec-'));
  temporaryDirectories.push(workspacePath);
  const profilePath = resolve(workspacePath, 'test-results', 'retained', `${FND09_OBSERVATION_CODEC_E2E_PROFILE_PREFIX}unit`);
  await mkdir(profilePath, { recursive: true });
  const connectionPath = join(profilePath, FND09_OBSERVATION_CODEC_E2E_CONNECTION_FILE);
  const probePath = join(profilePath, FND09_OBSERVATION_CODEC_E2E_PROBE_FILE);
  const networkSentinelPath = join(profilePath, FND09_OBSERVATION_CODEC_E2E_NETWORK_SENTINEL_FILE);
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
  const configuration = resolveFnd09ObservationCodecE2eConfiguration(input);
  if (!configuration) throw new Error('Expected an isolated FND-09 observation codec configuration.');
  return { input, configuration };
}

describe('isolated FND-09 observation codec hook', () => {
  it('requires test mode, a retained direct-child profile, and fixed direct-child artifacts', async () => {
    const { input, configuration } = await isolatedConfiguration();
    expect(configuration).toMatchObject({
      profilePath: input.userDataPath,
      connectionPath: input.connectionPath,
      probePath: input.probePath,
      networkSentinelPath: input.networkSentinelPath,
    });
    expect(resolveFnd09ObservationCodecE2eConfiguration({ ...input, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveFnd09ObservationCodecE2eConfiguration({ ...input, enabled: '0' })).toBeUndefined();
    expect(resolveFnd09ObservationCodecE2eConfiguration({ ...input, declaredProfilePath: join(input.userDataPath, 'other') })).toBeUndefined();
    expect(resolveFnd09ObservationCodecE2eConfiguration({ ...input, userDataPath: resolve(input.workspacePath, 'outside', FND09_OBSERVATION_CODEC_E2E_PROFILE_PREFIX) })).toBeUndefined();
    expect(resolveFnd09ObservationCodecE2eConfiguration({ ...input, probePath: join(input.userDataPath, 'nested', FND09_OBSERVATION_CODEC_E2E_PROBE_FILE) })).toBeUndefined();
    expect(resolveFnd09ObservationCodecE2eConfiguration({ ...input, networkSentinelPath: join(input.userDataPath, 'other.json') })).toBeUndefined();
    expect(isFnd09ObservationCodecE2eEnabled({ nodeEnv: 'test', enabled: '1' })).toBe(true);
    expect(isFnd09ObservationCodecE2eEnabled({ nodeEnv: 'production', enabled: '1' })).toBe(false);
  });

  it('retire a CRC-valid undecodable worker result before queued recovery reaches the caller', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AIDRAW_E2E_UTILITY_OBSERVATION_CODEC', '1');
    const { configuration } = await isolatedConfiguration();
    const pngBase64 = createCanvas(8, 6).toBuffer('image/png').toString('base64');
    expect(corruptFnd09ObservationIdat(pngBase64)).not.toBe(pngBase64);
    const workers = [new ObservationCodecUtility(811, pngBase64), new ObservationCodecUtility(922, pngBase64)];
    let workerIndex = 0;
    const supervisor = new RasterUtilitySupervisor(() => workers[workerIndex++]);
    const document = createIllustrationDocument('Observation codec containment');

    const evidence = await runFnd09ObservationCodecScenario({
      service: {
        getActiveDocumentId: () => document.id,
        getDocument: (documentId) => documentId === document.id ? structuredClone(document) : undefined,
      },
      rasterUtilities: supervisor,
    }, configuration);

    expect(evidence).toMatchObject({
      result: 'passed',
      canonical: { before: { documentId: document.id, revision: document.revision }, after: { documentId: document.id, revision: document.revision }, unchanged: true },
      corrupt: {
        workerPid: 811,
        error: { message: 'Raster utility returned an undecodable observation image.' },
        crcValidStaticEnvelopeReachedFullDecode: true,
        resultReturnedToCaller: false,
        payloadRetained: false,
      },
      recovery: {
        workerPid: 922,
        workerReplaced: true,
        queued: true,
        fixedCorruptResponseHoldMs: FND09_OBSERVATION_CODEC_E2E_HOLD_MS,
        observation: { available: true, mimeType: 'image/png', width: 8, height: 6, bytes: expect.any(Number), sha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
      },
      privacy: { rendererCreated: false, corruptPayloadPublished: false, publicJobCreated: false },
      network: { nonLoopbackRequests: 0 },
    });
    expect(workers[0].killed).toBe(true);
    expect(workers[1].killed).toBe(false);
    expect(workerIndex).toBe(2);
    const retained = await readFile(configuration.probePath, 'utf8');
    expect(JSON.parse(retained)).toEqual(evidence);
    expect(retained).not.toMatch(/Bearer|Authorization|"token"\s*:|"data"\s*:|"prompt"\s*:|"credential"\s*:/i);
    await expect(access(configuration.networkSentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
    supervisor.stop();
  });
});
