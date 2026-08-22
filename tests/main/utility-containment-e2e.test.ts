import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIllustrationDocument } from '@aidraw/core';
import { RasterUtilitySupervisor, type UtilityProcessLike } from '@main/utility-supervisor';
import type { UtilityResponse } from '@main/utility-contract';
import {
  FND09_UTILITY_E2E_CONNECTION_FILE,
  FND09_UTILITY_E2E_NETWORK_SENTINEL_FILE,
  FND09_UTILITY_E2E_PROBE_FILE,
  FND09_UTILITY_E2E_PROFILE_PREFIX,
  installFnd09UtilityContainmentNetworkBoundary,
  resolveFnd09UtilityContainmentE2eConfiguration,
  runFnd09UtilityContainmentScenario,
} from '@main/utility-containment-e2e';

const temporaryDirectories: string[] = [];

class ScriptedUtility extends EventEmitter implements UtilityProcessLike {
  readonly messages: unknown[] = [];
  killed = false;

  constructor(readonly pid: number) { super(); }

  postMessage(message: unknown): void {
    this.messages.push(message);
    const request = message as { id?: string; kind?: string; mode?: string };
    if (request.kind === 'containment-probe' && request.mode === 'crash') {
      setTimeout(() => this.emit('exit', 9), 20);
    } else if (request.kind === 'export-document') {
      setImmediate(() => this.respond({
        id: request.id!,
        ok: true,
        kind: 'export-document',
        artifact: {
          dataBase64: Buffer.from('fixed-contained-png').toString('base64'),
          mimeType: 'image/png',
          extension: 'png',
          report: { warnings: [], rasterized: [] },
        },
      }));
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
  const workspacePath = await mkdtemp(join(tmpdir(), 'aidraw-fnd09-utility-'));
  temporaryDirectories.push(workspacePath);
  const profilePath = resolve(workspacePath, 'test-results', 'retained', `${FND09_UTILITY_E2E_PROFILE_PREFIX}unit`);
  await mkdir(profilePath, { recursive: true });
  const connectionPath = join(profilePath, FND09_UTILITY_E2E_CONNECTION_FILE);
  const probePath = join(profilePath, FND09_UTILITY_E2E_PROBE_FILE);
  const networkSentinelPath = join(profilePath, FND09_UTILITY_E2E_NETWORK_SENTINEL_FILE);
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
  const configuration = resolveFnd09UtilityContainmentE2eConfiguration(input);
  if (!configuration) throw new Error('Expected an isolated FND-09 utility configuration.');
  return { input, configuration };
}

describe('isolated FND-09 utility containment hook', () => {
  it('requires test mode, a retained direct-child profile, and fixed direct-child artifacts', async () => {
    const { input, configuration } = await isolatedConfiguration();
    expect(configuration).toMatchObject({ profilePath: input.userDataPath, connectionPath: input.connectionPath, probePath: input.probePath, networkSentinelPath: input.networkSentinelPath });
    expect(resolveFnd09UtilityContainmentE2eConfiguration({ ...input, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveFnd09UtilityContainmentE2eConfiguration({ ...input, enabled: '0' })).toBeUndefined();
    expect(resolveFnd09UtilityContainmentE2eConfiguration({ ...input, declaredProfilePath: join(input.userDataPath, 'other') })).toBeUndefined();
    expect(resolveFnd09UtilityContainmentE2eConfiguration({ ...input, userDataPath: resolve(input.workspacePath, 'outside', FND09_UTILITY_E2E_PROFILE_PREFIX) })).toBeUndefined();
    expect(resolveFnd09UtilityContainmentE2eConfiguration({ ...input, probePath: join(input.userDataPath, 'nested', FND09_UTILITY_E2E_PROBE_FILE) })).toBeUndefined();
    expect(resolveFnd09UtilityContainmentE2eConfiguration({ ...input, networkSentinelPath: join(input.userDataPath, 'other.json') })).toBeUndefined();
  });

  it('contains crash and cancellation before deterministic queued exports restart in fresh workers', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AIDRAW_E2E_UTILITY_CONTAINMENT', '1');
    const { configuration } = await isolatedConfiguration();
    const workers = [new ScriptedUtility(101), new ScriptedUtility(202), new ScriptedUtility(303)];
    let nextWorker = 0;
    const supervisor = new RasterUtilitySupervisor(() => workers[nextWorker++]);
    const document = createIllustrationDocument('Contained canonical document');
    const evidence = await runFnd09UtilityContainmentScenario({
      service: { getActiveDocumentId: () => document.id, getDocument: (documentId) => documentId === document.id ? structuredClone(document) : undefined },
      rasterUtilities: supervisor,
    }, configuration);

    expect(evidence).toMatchObject({
      result: 'passed',
      canonical: { before: { documentId: document.id, revision: document.revision }, after: { documentId: document.id, revision: document.revision }, unchanged: true },
      crash: { workerPid: 101, error: { message: expect.stringContaining('exited unexpectedly with code 9') }, restartPid: 202, queuedExport: { warnings: [] } },
      cancellation: { workerPid: 202, error: { name: 'AbortError' }, restartPid: 303, queuedExport: { warnings: [] } },
      workerPidsDistinct: true,
      network: { nonLoopbackRequests: 0 },
    });
    expect(workers[1].killed).toBe(true);
    const retained = await readFile(configuration.probePath, 'utf8');
    expect(JSON.parse(retained)).toEqual(evidence);
    expect(retained).not.toMatch(/Bearer|Authorization|"token"\s*:|"prompt"\s*:|"credential"\s*:/i);
    supervisor.stop();
  });

  it('blocks a non-loopback fetch before transport and writes only its fixed sentinel', async () => {
    const { configuration } = await isolatedConfiguration();
    const originalFetch = globalThis.fetch;
    const transport = vi.fn<typeof fetch>();
    globalThis.fetch = transport;
    const restore = installFnd09UtilityContainmentNetworkBoundary(configuration);
    try {
      await expect(fetch('https://example.invalid/forbidden')).rejects.toThrow('blocked a non-loopback request');
      expect(transport).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(configuration.networkSentinelPath, 'utf8'))).toMatchObject({ blocked: true, hostname: 'example.invalid', nonLoopbackRequests: 1 });
    } finally {
      restore();
      globalThis.fetch = originalFetch;
    }
    await expect(access(join(configuration.profilePath, 'credentials', 'generation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
