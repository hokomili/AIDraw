import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIllustrationDocument } from '@aidraw/core';
import {
  FND09_GENERATION_NORMALIZATION_E2E_AUDIT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_CONNECTION_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_DOCUMENT_NAME,
  FND09_GENERATION_NORMALIZATION_E2E_NETWORK_SENTINEL_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_ID,
  FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_PROBE_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_PROFILE_PREFIX,
  FND09_GENERATION_NORMALIZATION_E2E_READY_PROBE_FILE,
  FND09_GENERATION_NORMALIZATION_E2E_REQUEST,
  createFnd09GenerationNormalizationE2eRunner,
  installFnd09GenerationNormalizationE2eNetworkBoundary,
  resolveFnd09GenerationNormalizationE2eConfiguration,
} from '../../src/main/generation-normalization-e2e';
import { inspectImageHeader, MAX_INLINE_ASSET_BYTES, MAX_INLINE_IMAGE_PIXELS } from '../../src/main/transaction-policy';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'aidraw-generation-normalization-e2e-'));
  temporaryRoots.push(workspace);
  const profilePath = join(workspace, 'test-results', 'retained', `${FND09_GENERATION_NORMALIZATION_E2E_PROFILE_PREFIX}fixture`);
  await mkdir(profilePath, { recursive: true });
  const input = {
    nodeEnv: 'test',
    enabled: '1',
    workspacePath: workspace,
    declaredProfilePath: profilePath,
    userDataPath: profilePath,
    connectionPath: join(profilePath, FND09_GENERATION_NORMALIZATION_E2E_CONNECTION_FILE),
    normalizableOutputPath: join(profilePath, FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_FILE),
    previewOnlyOutputPath: join(profilePath, FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_FILE),
    auditPath: join(profilePath, FND09_GENERATION_NORMALIZATION_E2E_AUDIT_FILE),
    readyProbePath: join(profilePath, FND09_GENERATION_NORMALIZATION_E2E_READY_PROBE_FILE),
    previewOnlyProbePath: join(profilePath, FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_PROBE_FILE),
    networkSentinelPath: join(profilePath, FND09_GENERATION_NORMALIZATION_E2E_NETWORK_SENTINEL_FILE),
  };
  const configuration = resolveFnd09GenerationNormalizationE2eConfiguration(input);
  if (!configuration) throw new Error('Expected the exact normalization fixture configuration.');
  return { workspace, profilePath, input, configuration };
}

describe('packaged generated-preview normalization fixture', () => {
  it('resolves only the fixed direct-child profile and artifact contract', async () => {
    const value = await fixture();
    expect(value.configuration.profilePath).toBe(value.profilePath);
    expect(resolveFnd09GenerationNormalizationE2eConfiguration({ ...value.input, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveFnd09GenerationNormalizationE2eConfiguration({ ...value.input, declaredProfilePath: join(value.profilePath, 'other') })).toBeUndefined();
    expect(resolveFnd09GenerationNormalizationE2eConfiguration({ ...value.input, readyProbePath: join(value.profilePath, 'wrong.json') })).toBeUndefined();
    expect(resolveFnd09GenerationNormalizationE2eConfiguration({ ...value.input, userDataPath: join(value.workspace, 'outside', `${FND09_GENERATION_NORMALIZATION_E2E_PROFILE_PREFIX}fixture`) })).toBeUndefined();
  });

  it('returns exactly one over-byte normalizable PNG and one over-geometry preview-only PNG without credentials or network', async () => {
    const { configuration } = await fixture();
    const document = createIllustrationDocument(FND09_GENERATION_NORMALIZATION_E2E_DOCUMENT_NAME);
    const request = { documentId: document.id, ...structuredClone(FND09_GENERATION_NORMALIZATION_E2E_REQUEST) };
    const outputs = await createFnd09GenerationNormalizationE2eRunner(configuration)(
      { jobId: 'fixture-job', document, request, credential: undefined },
      { signal: new AbortController().signal },
    );
    expect(outputs).toHaveLength(2);
    expect(outputs.map(({ id, mimeType, width, height, seed }) => ({ id, mimeType, width, height, seed }))).toEqual([
      { id: FND09_GENERATION_NORMALIZATION_E2E_NORMALIZABLE_OUTPUT_ID, mimeType: 'image/png', width: 64, height: 48, seed: FND09_GENERATION_NORMALIZATION_E2E_REQUEST.seed },
      { id: FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_OUTPUT_ID, mimeType: 'image/png', ...FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS, seed: FND09_GENERATION_NORMALIZATION_E2E_REQUEST.seed + 1 },
    ]);
    const normalizable = Buffer.from(outputs[0].data, 'base64');
    const previewOnly = Buffer.from(outputs[1].data, 'base64');
    expect(normalizable.byteLength).toBeGreaterThan(MAX_INLINE_ASSET_BYTES);
    expect(inspectImageHeader(normalizable)).toMatchObject({ mimeType: 'image/png', width: 64, height: 48 });
    expect(inspectImageHeader(previewOnly)).toMatchObject({ mimeType: 'image/png', ...FND09_GENERATION_NORMALIZATION_E2E_PREVIEW_ONLY_DIMENSIONS });
    expect(outputs[1].width * outputs[1].height).toBeGreaterThan(MAX_INLINE_IMAGE_PIXELS);
    expect(await readFile(configuration.normalizableOutputPath)).toEqual(normalizable);
    expect(await readFile(configuration.previewOnlyOutputPath)).toEqual(previewOnly);
    const audit = JSON.parse(await readFile(configuration.auditPath, 'utf8')) as Record<string, unknown>;
    expect(audit).toMatchObject({ invocationCount: 1, hostedKeyReceived: false, nonLoopbackRequests: 0, externalProviderRequests: 0, paidRequests: 0 });
    expect(JSON.stringify(audit)).not.toMatch(/Bearer|Authorization|"token"\s*:/i);
  }, 15_000);

  it('blocks a non-loopback fixture fetch before transport and records only a sanitized sentinel', async () => {
    const { configuration } = await fixture();
    const restore = installFnd09GenerationNormalizationE2eNetworkBoundary(configuration);
    try {
      await expect(fetch('https://provider.invalid/generate')).rejects.toThrow('blocked a non-loopback request');
    } finally {
      restore();
    }
    const sentinel = JSON.parse(await readFile(configuration.networkSentinelPath, 'utf8')) as Record<string, unknown>;
    expect(sentinel).toEqual({ version: 1, blocked: true, protocol: 'https:', hostname: 'provider.invalid', nonLoopbackRequests: 1, externalProviderRequests: 1, paidRequests: 0 });
    expect(await access(configuration.auditPath).then(() => true, () => false)).toBe(false);
  });
});
