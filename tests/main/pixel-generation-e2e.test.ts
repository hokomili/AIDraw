import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPixelDocument } from '@aidraw/core';
import type { GenerationRequest } from '../../src/common/generation';
import {
  QA06_PIXEL_PALETTE_E2E_APPROVAL_TIMEOUT_MS,
  QA06_PIXEL_PALETTE_E2E_AUDIT_FILE,
  QA06_PIXEL_PALETTE_E2E_CONNECTION_FILE,
  QA06_PIXEL_PALETTE_E2E_DOCUMENT_NAME,
  QA06_PIXEL_PALETTE_E2E_NETWORK_SENTINEL_FILE,
  QA06_PIXEL_PALETTE_E2E_OUTPUT_FILE,
  QA06_PIXEL_PALETTE_E2E_PROFILE_PREFIX,
  QA06_PIXEL_PALETTE_E2E_REQUEST,
  createQa06PixelPaletteE2eRunner,
  installQa06PixelPaletteE2eNetworkBoundary,
  qa06PixelPaletteExpectedIndex,
  resolveQa06PixelPaletteE2eConfiguration,
} from '../../src/main/pixel-generation-e2e';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('QA-06 pixel-palette packaged fixture', () => {
  it('fails closed to one exact profile, deterministic request, and fixed direct-child artifacts', async () => {
    const profilePath = await mkdtemp(join(tmpdir(), QA06_PIXEL_PALETTE_E2E_PROFILE_PREFIX));
    temporaryDirectories.push(profilePath);
    const connectionPath = join(profilePath, QA06_PIXEL_PALETTE_E2E_CONNECTION_FILE);
    const outputPath = join(profilePath, QA06_PIXEL_PALETTE_E2E_OUTPUT_FILE);
    const auditPath = join(profilePath, QA06_PIXEL_PALETTE_E2E_AUDIT_FILE);
    const networkSentinelPath = join(profilePath, QA06_PIXEL_PALETTE_E2E_NETWORK_SENTINEL_FILE);
    const valid = { nodeEnv: 'test', enabled: '1', declaredProfilePath: profilePath, userDataPath: profilePath, connectionPath, outputPath, auditPath, networkSentinelPath };
    const configuration = resolveQa06PixelPaletteE2eConfiguration(valid);
    expect(configuration).toEqual({ profilePath, connectionPath, outputPath, auditPath, networkSentinelPath, approvalTimeoutMs: QA06_PIXEL_PALETTE_E2E_APPROVAL_TIMEOUT_MS });
    expect(resolveQa06PixelPaletteE2eConfiguration({ ...valid, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveQa06PixelPaletteE2eConfiguration({ ...valid, declaredProfilePath: join(profilePath, 'other') })).toBeUndefined();
    expect(resolveQa06PixelPaletteE2eConfiguration({ ...valid, outputPath: join(profilePath, 'nested', QA06_PIXEL_PALETTE_E2E_OUTPUT_FILE) })).toBeUndefined();
    expect(resolveQa06PixelPaletteE2eConfiguration({ ...valid, auditPath: join(profilePath, 'other.json') })).toBeUndefined();
    if (!configuration) throw new Error('Expected the exact isolated QA-06 pixel-palette configuration.');

    const document = createPixelDocument('sprite', QA06_PIXEL_PALETTE_E2E_DOCUMENT_NAME);
    const sprite = document.pixelAssets[document.activeAssetId];
    if (sprite.type !== 'sprite') throw new Error('Expected the fixture sprite.');
    sprite.width = 16;
    sprite.height = 16;
    const request = structuredClone({ documentId: document.id, ...QA06_PIXEL_PALETTE_E2E_REQUEST }) as GenerationRequest;
    const runner = createQa06PixelPaletteE2eRunner(configuration);

    await expect(runner({ jobId: 'qa06-palette-key-refusal', document, request, credential: 'must-not-enter-fixture' }, { signal: new AbortController().signal })).rejects.toThrow(/refuses hosted provider keys/);
    expect(await access(outputPath).then(() => true, () => false)).toBe(false);
    await expect(runner({ jobId: 'qa06-palette-request-refusal', document, request: { ...request, prompt: 'wrong request' } }, { signal: new AbortController().signal })).rejects.toThrow(/unexpected request payload/);

    const progress = vi.fn();
    const outputs = await runner({ jobId: 'qa06-palette-local-fixture', document, request }, { signal: new AbortController().signal, onProgress: progress });
    expect(outputs).toEqual([expect.objectContaining({
      id: 'qa06-pixel-palette-result',
      mimeType: 'image/png',
      width: 32,
      height: 32,
      seed: QA06_PIXEL_PALETTE_E2E_REQUEST.seed,
      providerMetadata: { fixture: 'qa06-pixel-palette-conversion', transport: 'deterministic-local', externalProviderRequests: 0, paidRequests: 0 },
    })]);
    const outputBytes = await readFile(outputPath);
    expect(Buffer.from(outputs[0].data, 'base64')).toEqual(outputBytes);
    const image = await loadImage(outputBytes);
    const decoded = createCanvas(32, 32); decoded.getContext('2d').drawImage(image, 0, 0);
    const pixels = decoded.getContext('2d').getImageData(0, 0, 32, 32).data;
    const rgbaAt = (x: number, y: number) => [...pixels.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
    expect(rgbaAt(0, 0)).toEqual([39, 33, 60, 255]);
    expect(rgbaAt(10, 10)).toEqual([255, 107, 122, 255]);
    expect(rgbaAt(22, 10)).toEqual([57, 120, 184, 255]);
    expect(rgbaAt(10, 22)).toEqual([155, 227, 194, 255]);
    expect(rgbaAt(20, 20)).toEqual(qa06PixelPaletteExpectedIndex(10, 10) === 15 ? [229, 184, 75, 255] : [0, 0, 0, 0]);
    expect(rgbaAt(22, 20)).toEqual(qa06PixelPaletteExpectedIndex(11, 10) === 15 ? [229, 184, 75, 255] : [0, 0, 0, 0]);

    const auditText = await readFile(auditPath, 'utf8');
    expect(JSON.parse(auditText)).toMatchObject({ fixture: 'qa06-pixel-palette-conversion', transport: 'in-process-deterministic-runner', invocationCount: 1, hostedKeyReceived: false, externalProviderRequests: 0, paidRequests: 0, output: { file: QA06_PIXEL_PALETTE_E2E_OUTPUT_FILE, width: 32, height: 32 } });
    expect(auditText).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    expect(progress).toHaveBeenCalledWith(0.3, expect.stringContaining('deterministic local palette study'));

    const restoreFetch = installQa06PixelPaletteE2eNetworkBoundary(configuration);
    try { await expect(fetch('https://api.stability.ai/v2beta/stable-image/generate/core')).rejects.toThrow(/blocked an external provider request/); }
    finally { restoreFetch(); }
    expect(JSON.parse(await readFile(networkSentinelPath, 'utf8'))).toMatchObject({ blocked: true, protocol: 'https:', hostname: 'api.stability.ai', externalProviderRequests: 1, paidRequests: 0 });
  });
});
