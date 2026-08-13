import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createId, nowIso, readPixel, type AIDrawDocument, type Actor, type AsyncJob, type CanvasTransaction, type DocumentAsset, type ShapeObject } from '@aidraw/core';

vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 10, height: 10 }) }) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
}));

import type { GeneratedOutput, GenerationJobResult, GenerationRequest } from '../../src/common/generation';
import { DocumentService } from '../../src/main/document-service';
import { GenerationManager } from '../../src/main/generation-manager';
import { RecoveryJournal } from '../../src/main/journal';
import { ProviderCredentialStore } from '../../src/main/provider-credentials';
import type { GenerationProviderRunner } from '../../src/main/generation-provider-runner';
import { MAX_INLINE_ASSET_BYTES } from '../../src/main/transaction-policy';
import {
  QA06_GENERATION_E2E_AUDIT_FILE,
  QA06_GENERATION_E2E_APPROVAL_TIMEOUT_MS,
  QA06_GENERATION_E2E_CONNECTION_FILE,
  QA06_GENERATION_E2E_DOCUMENT_NAME,
  QA06_GENERATION_E2E_MASK_ASSET_ID,
  QA06_GENERATION_E2E_NETWORK_SENTINEL_FILE,
  QA06_GENERATION_E2E_OUTPUT_FILE,
  QA06_GENERATION_E2E_PROFILE_PREFIX,
  QA06_GENERATION_E2E_REQUEST,
  QA06_GENERATION_E2E_SOURCE_ASSET_ID,
  createQa06GenerationE2eRunner,
  installQa06GenerationE2eNetworkBoundary,
  resolveQa06GenerationE2eConfiguration,
} from '../../src/main/generation-e2e';

const temporaryDirectories: string[] = [];
const documentServices: DocumentService[] = [];
afterEach(async () => {
  const flushResults = await Promise.allSettled(documentServices.splice(0).map((service) => service.flushRecovery()));
  const cleanupResults = await Promise.allSettled(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
  const failures = [...flushResults, ...cleanupResults].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Generation-manager fixture teardown failed.');
});

async function fixture(runner: GenerationProviderRunner, resultCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'aidraw-generation-')); temporaryDirectories.push(directory); const documents = new DocumentService(new RecoveryJournal(join(directory, 'journal')), '0.1.0'); documentServices.push(documents); documents.initialize(); const document = documents.create({ kind: 'sprite', name: 'Generated sprite', width: 4, height: 4 }).activeDocument!;
  const canvas = createCanvas(2, 2); canvas.getContext('2d').fillStyle = '#ff6b7a'; canvas.getContext('2d').fillRect(0, 0, 2, 2); const data = canvas.toBuffer('image/png').toString('base64');
  const comparisonCanvas = createCanvas(4, 4); comparisonCanvas.getContext('2d').fillStyle = '#3978b8'; comparisonCanvas.getContext('2d').fillRect(0, 0, 4, 4); const comparisonData = comparisonCanvas.toBuffer('image/png').toString('base64');
  const manager = new GenerationManager(documents, new ProviderCredentialStore(join(directory, 'credentials.json')), runner, async () => Buffer.from(comparisonData, 'base64'), async () => [{ x: 0, y: 0, index: 3 }]);
  const request: GenerationRequest = { documentId: document.id, provider: 'openai', mode: 'create', prompt: 'A coral sprite', sourceAssetIds: [], size: 'auto', resultCount, providerOptions: {} };
  return { directory, documents, document, manager, request, data, comparisonData };
}

async function waitForStatus(documents: DocumentService, jobId: string, status: AsyncJob['status']): Promise<AsyncJob> {
  for (let attempt = 0; attempt < 100; attempt += 1) { const job = documents.getJob(jobId); if (job?.status === status) return job; await new Promise((resolve) => setTimeout(resolve, 0)); }
  throw new Error(`Generation job ${jobId} did not reach ${status}.`);
}

function oversizedValidPng(): Buffer {
  const canvas = createCanvas(8, 6); const context = canvas.getContext('2d'); context.fillStyle = '#d26682'; context.fillRect(0, 0, 8, 6); context.fillStyle = '#386fa4'; context.fillRect(2, 1, 4, 3);
  const png = canvas.toBuffer('image/png'); const type = Buffer.from('raNd'); const payload = Buffer.alloc(MAX_INLINE_ASSET_BYTES + 257 - png.byteLength - 12, 0x5a); const chunk = Buffer.alloc(payload.byteLength + 12);
  chunk.writeUInt32BE(payload.byteLength, 0); type.copy(chunk, 4); payload.copy(chunk, 8); chunk.writeUInt32BE(crc32(Buffer.concat([type, payload])) >>> 0, chunk.byteLength - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

describe('generation manager orchestration', () => {
  it('routes a result through the provider seam, records partial completion, and accepts it as indexed content with provenance', async () => {
    let outputData = ''; const runner = vi.fn<GenerationProviderRunner>(async () => [{ id: 'result-one', mimeType: 'image/png', data: outputData, width: 2, height: 2 }]); const value = await fixture(runner, 2); outputData = value.data;
    const started = await value.manager.startHuman(value.request); const completed = await waitForStatus(value.documents, started.jobId, 'completed'); expect(runner).toHaveBeenCalledTimes(1); expect(completed.message).toContain('1 of 2 requested results'); expect(completed.result).toMatchObject({ comparisonSource: { mimeType: 'image/png', data: value.comparisonData, width: 4, height: 4 } });
    const accepted = await value.manager.accept(started.jobId, 'result-one'); expect(accepted).toEqual({ accepted: true }); const document = value.documents.getDocument(value.document.id); if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(sprite.layerIds).toHaveLength(2); expect(document.provenance).toEqual([expect.objectContaining({ provider: 'openai', modelOrWorkflow: 'gpt-image-2', prompt: 'A coral sprite', conversion: expect.objectContaining({ width: 4, height: 4 }) })]); expect(Object.values(document.assets)).toEqual([expect.objectContaining({ source: 'generated' })]);
  });

  it('retains an exact GIF source with its truthful MIME and header geometry', async () => {
    let outputData = '';
    const runner = vi.fn<GenerationProviderRunner>(async () => [{ id: 'gif-edit-result', mimeType: 'image/png', data: outputData, width: 2, height: 2 }]);
    const value = await fixture(runner); outputData = value.data;
    const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    const source: DocumentAsset = {
      id: 'comparison-gif', name: 'Animated source', mimeType: 'image/gif', byteLength: gifBytes.byteLength,
      sha256: createHash('sha256').update(gifBytes).digest('hex'), source: 'imported', data: gifBytes.toString('base64'),
    };
    expect((await value.documents.apply({
      id: createId('tx'), clientOperationId: 'install-comparison-gif', documentId: value.document.id, actor: HUMAN_ACTOR,
      label: 'Install GIF comparison source', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset: source }],
    })).status).toBe('committed');

    const started = await value.manager.startHuman({ ...value.request, mode: 'edit', sourceAssetIds: [source.id] });
    const completed = await waitForStatus(value.documents, started.jobId, 'completed');
    expect((completed.result as GenerationJobResult).comparisonSource).toMatchObject({
      mimeType: 'image/gif', data: source.data, width: 1, height: 1,
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it('rejects malformed or contradictory rendered comparisons before dispatch and isolates a valid renderer snapshot', async () => {
    let outputData = '';
    const outputRunner = vi.fn<GenerationProviderRunner>(async () => [{ id: 'admitted-result', mimeType: 'image/png', data: outputData, width: 2, height: 2 }]);
    const value = await fixture(outputRunner); outputData = value.data;
    const wrongCanvas = createCanvas(1, 1);
    const validCanvas = createCanvas(4, 4); validCanvas.getContext('2d').fillStyle = '#31a6a0'; validCanvas.getContext('2d').fillRect(0, 0, 4, 4);
    const validPng = validCanvas.toBuffer('image/png');
    const renderer = vi.fn<(document: AIDrawDocument) => Promise<Buffer>>()
      .mockResolvedValueOnce(Buffer.from('not a PNG'))
      .mockResolvedValueOnce(wrongCanvas.toBuffer('image/png'))
      .mockImplementationOnce(async (snapshot) => { snapshot.name = 'Renderer mutation'; return validPng; });
    const manager = new GenerationManager(
      value.documents,
      new ProviderCredentialStore(join(value.directory, 'comparison-admission-credentials.json')),
      outputRunner,
      renderer,
    );
    const before = value.documents.getDocument(value.document.id)!;

    await expect(manager.startHuman(value.request)).rejects.toThrow('Generation comparison renderer returned an invalid PNG.');
    await expect(manager.startHuman(value.request)).rejects.toThrow('Generation comparison renderer returned contradictory PNG dimensions.');
    expect(outputRunner).not.toHaveBeenCalled();
    expect(value.documents.snapshot().jobs).toEqual([]);

    const started = await manager.startHuman(value.request);
    const completed = await waitForStatus(value.documents, started.jobId, 'completed');
    expect((completed.result as GenerationJobResult).comparisonSource).toMatchObject({
      mimeType: 'image/png', data: validPng.toString('base64'), width: 4, height: 4,
    });
    expect(value.documents.getDocument(value.document.id)).toEqual(before);
    expect(outputRunner).toHaveBeenCalledOnce();
    expect(renderer).toHaveBeenCalledTimes(3);
  });

  it('wires production comparison rendering to supervised PNG bytes without Electron image decode', async () => {
    const [managerSource, runtimeSource] = await Promise.all([
      readFile(join(process.cwd(), 'src/main/generation-manager.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/main/engine-runtime.ts'), 'utf8'),
    ]);
    expect(managerSource).not.toContain("import { nativeImage } from 'electron'");
    expect(managerSource).not.toContain('nativeImage.createFromBuffer');
    expect(runtimeSource).toContain("async (document) => (await this.rasterUtilities.exportDocument(document, 'png')).data");
    expect(runtimeSource).not.toContain("from './render-document'");
  });

  it('accepts an oversized preview through an explicit normalized copy while retaining the exact provider result', async () => {
    const sourceBytes = oversizedValidPng(); const sourceData = sourceBytes.toString('base64');
    const runner = vi.fn<GenerationProviderRunner>(async () => [{ id: 'oversized-preview', mimeType: 'image/png', data: sourceData, width: 8, height: 6, seed: 77 }]);
    const value = await fixture(runner); value.request.provider = 'stability'; value.request.seed = 77;
    const started = await value.manager.startHuman(value.request); await waitForStatus(value.documents, started.jobId, 'completed');
    const before = value.documents.getDocument(value.document.id)!; const retainedOutput = structuredClone((value.documents.getJob(started.jobId)?.result as GenerationJobResult).outputs[0]);

    const response = await value.manager.accept(started.jobId, 'oversized-preview');
    expect(response).toMatchObject({ accepted: true, message: expect.stringContaining('original preview is retained unchanged'), normalization: { method: 'png-reencode', sourceByteLength: sourceBytes.byteLength, sourceMimeType: 'image/png', acceptedMimeType: 'image/png' } });
    const accepted = value.documents.getDocument(value.document.id); if (!accepted || accepted.kind !== 'pixel') throw new Error('Expected accepted pixel document');
    expect(accepted.revision).toBe(before.revision + 1);
    const asset = Object.values(accepted.assets).find((entry) => entry.source === 'generated'); if (!asset?.data) throw new Error('Expected normalized generated asset');
    expect(asset.name).toContain('normalized for acceptance'); expect(asset.byteLength).toBeLessThanOrEqual(MAX_INLINE_ASSET_BYTES); expect(asset.data).not.toBe(sourceData);
    const job = value.documents.getJob(started.jobId) as AsyncJob<GenerationJobResult>;
    expect(job.result?.outputs).toEqual([retainedOutput]);
    expect(job.result).toMatchObject({ acceptedOutputId: 'oversized-preview', acceptedNormalization: response.normalization });
    expect(accepted.provenance[0]).toMatchObject({ assetId: asset.id, provider: 'stability', seed: 77, conversion: { acceptanceNormalization: response.normalization, width: 4, height: 4 } });
  });

  it('keeps a valid result preview-only and canonical state exact when normalization cannot meet acceptance policy', async () => {
    const value = await fixture(vi.fn<GenerationProviderRunner>()); const sourceBytes = oversizedValidPng(); const sourceData = sourceBytes.toString('base64'); const timestamp = nowIso();
    const job: AsyncJob<GenerationJobResult> = { id: 'preview-only-job', kind: 'generation', status: 'completed', actor: HUMAN_ACTOR, createdAt: timestamp, updatedAt: timestamp, progress: 1, message: '1 result ready to compare.', result: { request: value.request, outputs: [{ id: 'preview-only-output', mimeType: 'image/png', data: sourceData, width: 8, height: 6 }] } };
    value.documents.upsertJob(job); const before = structuredClone(value.documents.getDocument(value.document.id)); const quantize = vi.fn(async () => [{ x: 0, y: 0, index: 1 }]);
    const manager = new GenerationManager(value.documents, new ProviderCredentialStore(join(temporaryDirectories.at(-1)!, 'preview-only-credentials.json')), vi.fn<GenerationProviderRunner>(), undefined, quantize, async () => ({ status: 'preview-only', reason: 'encoded-byte-limit', message: 'The deterministic accepted copy does not fit.', guidance: 'Generate a smaller result.' }));

    const response = await manager.accept(job.id, 'preview-only-output');
    expect(response).toEqual({ accepted: false, previewOnly: true, message: 'The deterministic accepted copy does not fit. Generate a smaller result.' });
    expect(value.documents.getDocument(value.document.id)).toEqual(before); expect(quantize).not.toHaveBeenCalled();
    expect(value.documents.getJob(job.id)).toMatchObject({ status: 'completed', result: { outputs: job.result!.outputs } });
    expect((value.documents.getJob(job.id)?.result as GenerationJobResult).acceptedOutputId).toBeUndefined();
  });

  it('accepts one agent result into a new indexed cel using the exact document conversion contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-generation-palette-contract-')); temporaryDirectories.push(directory);
    const documents = new DocumentService(new RecoveryJournal(join(directory, 'journal')), '0.1.0'); documentServices.push(documents); documents.initialize();
    const created = documents.create({ kind: 'sprite', name: 'Palette acceptance contract', width: 4, height: 4 }).activeDocument!;
    if (created.kind !== 'pixel') throw new Error('Expected pixel document');
    const sourceSprite = created.pixelAssets[created.activeAssetId]; if (sourceSprite.type !== 'sprite') throw new Error('Expected sprite');
    const sourceLayerId = sourceSprite.layerIds[0];
    const sourceCel = Object.values(sourceSprite.cels).find((cel) => cel.layerId === sourceLayerId); if (!sourceCel) throw new Error('Expected source cel');
    const conversion = { ...created.conversionDefaults, dithering: 'bayer-4x4' as const, alphaThreshold: 0.6 };
    expect((await documents.apply({ id: createId('tx'), clientOperationId: 'palette-conversion-defaults', documentId: created.id, actor: HUMAN_ACTOR, label: 'Set palette conversion defaults', createdAt: nowIso(), playback: { mode: 'instant', speed: 1 }, operations: [{ kind: 'pixel.conversion.replace', conversionDefaults: conversion }] })).status).toBe('committed');
    const before = documents.getDocument(created.id); if (!before || before.kind !== 'pixel') throw new Error('Expected configured pixel document');
    const beforeSprite = before.pixelAssets[before.activeAssetId]; if (beforeSprite.type !== 'sprite') throw new Error('Expected configured sprite');

    const outputCanvas = createCanvas(8, 8); const outputContext = outputCanvas.getContext('2d'); outputContext.fillStyle = '#ff6b7a'; outputContext.fillRect(0, 0, 4, 4); outputContext.fillStyle = '#3978b8'; outputContext.fillRect(4, 0, 4, 4); const outputBytes = outputCanvas.toBuffer('image/png');
    const requestingAgent: Actor = { id: 'qa06-pixel-palette-agent', kind: 'agent', name: 'QA-06 pixel palette agent', color: '#3978b8' };
    const request: GenerationRequest = { documentId: before.id, provider: 'stability', mode: 'create', prompt: 'Indexed palette contract', sourceAssetIds: [], size: { width: 8, height: 8 }, resultCount: 1, seed: 97531, providerOptions: { stylePreset: 'pixel-art' } };
    const timestamp = nowIso();
    const job: AsyncJob<GenerationJobResult> = { id: 'qa06-pixel-palette-job', kind: 'generation', status: 'completed', actor: requestingAgent, createdAt: timestamp, updatedAt: timestamp, progress: 1, message: '1 result ready to compare.', result: { request, outputs: [{ id: 'qa06-pixel-palette-output', mimeType: 'image/png', data: outputBytes.toString('base64'), width: 8, height: 8, seed: request.seed }] } };
    documents.upsertJob(job);
    const quantize = vi.fn(async (...parameters: [Buffer, number, number, typeof before.palette, number, 'none' | 'bayer-4x4' | 'floyd-steinberg']) => {
      void parameters;
      return [
        { x: 0, y: 0, index: 4 },
        { x: 1, y: 0, index: 9 },
        { x: 2, y: 0, index: 15 },
        { x: 3, y: 0, index: 0 },
      ];
    });
    const manager = new GenerationManager(documents, new ProviderCredentialStore(join(directory, 'credentials.json')), vi.fn<GenerationProviderRunner>(), undefined, quantize);

    expect(await manager.accept(job.id, 'qa06-pixel-palette-output')).toEqual({ accepted: true });
    expect(quantize).toHaveBeenCalledTimes(1);
    const [encoded, width, height, palette, alphaThreshold, dithering] = quantize.mock.calls[0];
    expect(encoded).toEqual(outputBytes);
    expect({ width, height, palette, alphaThreshold, dithering }).toEqual({ width: 4, height: 4, palette: before.palette, alphaThreshold: 0.6, dithering: 'bayer-4x4' });

    const accepted = documents.getDocument(before.id); if (!accepted || accepted.kind !== 'pixel') throw new Error('Expected accepted pixel document');
    const sprite = accepted.pixelAssets[accepted.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected accepted sprite');
    expect(sprite.layerIds).toHaveLength(beforeSprite.layerIds.length + 1);
    expect(sprite.cels[sourceCel.id]).toEqual(beforeSprite.cels[sourceCel.id]);
    const generatedLayer = sprite.layers[sprite.layerIds.at(-1)!];
    const generatedCel = Object.values(sprite.cels).find((cel) => cel.layerId === generatedLayer.id && cel.frameId === sprite.frameIds[0]);
    if (!generatedCel) throw new Error('Expected generated palette cel');
    expect(generatedLayer).toMatchObject({ name: 'Generated result', createdBy: HUMAN_ACTOR.id });
    expect(generatedCel).toMatchObject({ createdBy: HUMAN_ACTOR.id });
    expect([0, 1, 2, 3].map((x) => readPixel(generatedCel, x, 0))).toEqual([4, 9, 15, 0]);
    const generatedAsset = Object.values(accepted.assets).find((asset) => asset.source === 'generated'); if (!generatedAsset) throw new Error('Expected retained generated source');
    expect(generatedAsset).toMatchObject({ byteLength: outputBytes.byteLength, sha256: createHash('sha256').update(outputBytes).digest('hex') });
    expect(accepted.provenance).toEqual([expect.objectContaining({ assetId: generatedAsset.id, provider: 'stability', modelOrWorkflow: 'stable-image-core', seed: 97531, conversion: { resample: 'area', paletteMetric: 'oklab', dithering: 'bayer-4x4', alphaThreshold: 0.6, width: 4, height: 4 } })]);
    expect(accepted.activity.at(-1)).toMatchObject({ actor: HUMAN_ACTOR, label: 'Accept generated image into palette', status: 'committed' });
    expect(documents.getJob(job.id)).toMatchObject({ actor: requestingAgent, result: { acceptedOutputId: 'qa06-pixel-palette-output' } });

    expect((await documents.undo(accepted.id)).status).toBe('committed');
    const undone = documents.getDocument(accepted.id); if (!undone || undone.kind !== 'pixel') throw new Error('Expected undone pixel document');
    const undoneSprite = undone.pixelAssets[undone.activeAssetId]; if (undoneSprite.type !== 'sprite') throw new Error('Expected undone sprite');
    expect(undoneSprite.layerIds).toEqual(beforeSprite.layerIds);
    expect(undone.assets).toEqual(before.assets);
    expect(undone.provenance).toEqual(before.provenance);
  });

  it('keeps the requesting agent on the generation job while human acceptance owns canonical created entities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-generation-attribution-')); temporaryDirectories.push(directory);
    const documents = new DocumentService(new RecoveryJournal(join(directory, 'journal')), '0.1.0'); documentServices.push(documents); documents.initialize();
    const document = documents.create({ kind: 'illustration', name: 'Two-actor generation', width: 32, height: 24 }).activeDocument!;
    const outputCanvas = createCanvas(8, 6); outputCanvas.getContext('2d').fillStyle = '#d26682'; outputCanvas.getContext('2d').fillRect(0, 0, 8, 6); const outputData = outputCanvas.toBuffer('image/png').toString('base64');
    const requestingAgent: Actor = { id: 'qa06-generation-agent', kind: 'agent', name: 'QA-06 generation agent', color: '#d26682' };
    const request: GenerationRequest = { documentId: document.id, provider: 'stability', mode: 'create', prompt: 'A bounded local fill', sourceAssetIds: [], size: { width: 8, height: 6 }, resultCount: 1, seed: 606, providerOptions: {} };
    const timestamp = nowIso();
    const job: AsyncJob<GenerationJobResult> = {
      id: 'qa06-agent-generation-job', kind: 'generation', status: 'completed', actor: requestingAgent, createdAt: timestamp, updatedAt: timestamp, progress: 1, message: '1 result ready to compare.',
      result: { request, outputs: [{ id: 'qa06-agent-generation-output', mimeType: 'image/png', data: outputData, width: 8, height: 6, seed: 606 }] },
    };
    documents.upsertJob(job);
    const runner = vi.fn<GenerationProviderRunner>();
    const manager = new GenerationManager(documents, new ProviderCredentialStore(join(directory, 'credentials.json')), runner);

    expect(await manager.accept(job.id, 'qa06-agent-generation-output')).toEqual({ accepted: true });
    expect(runner).not.toHaveBeenCalled();
    const accepted = documents.getDocument(document.id); if (!accepted || accepted.kind !== 'illustration') throw new Error('Expected illustration');
    const generatedAsset = Object.values(accepted.assets).find((asset) => asset.source === 'generated'); if (!generatedAsset) throw new Error('Expected generated asset');
    const generatedObject = Object.values(accepted.objects).find((object) => object.type === 'image' && object.assetId === generatedAsset.id); if (!generatedObject) throw new Error('Expected generated image');
    const generatedLayer = accepted.layers[generatedObject.layerId]; if (!generatedLayer) throw new Error('Expected generated layer');

    expect(generatedObject.createdBy).toBe(HUMAN_ACTOR.id);
    expect(generatedLayer.createdBy).toBe(HUMAN_ACTOR.id);
    expect(accepted.activity.at(-1)).toMatchObject({ actor: HUMAN_ACTOR, label: 'Accept generated image', status: 'committed' });
    expect(documents.getJob(job.id)).toMatchObject({ actor: requestingAgent, result: { acceptedOutputId: 'qa06-agent-generation-output' } });
    expect(accepted.provenance).toEqual([expect.objectContaining({ assetId: generatedAsset.id, provider: 'stability', modelOrWorkflow: 'stable-image-core', prompt: request.prompt, seed: 606 })]);
  });

  it('classifies a moderation/permission failure without retrying the provider seam', async () => {
    const error = Object.assign(new Error('request rejected'), { status: 403 }); const runner = vi.fn<GenerationProviderRunner>(async () => { throw error; }); const value = await fixture(runner); const started = await value.manager.startHuman(value.request); const failed = await waitForStatus(value.documents, started.jobId, 'failed');
    expect(runner).toHaveBeenCalledTimes(1); expect(failed.error).toEqual({ code: 'moderation_or_permission', message: 'request rejected', retryable: false }); expect(failed.message).toContain('without an automatic retry');
  });

  it('aborts an in-flight utility request and never overwrites the cancelled terminal state', async () => {
    let entered!: () => void; const running = new Promise<void>((resolve) => { entered = resolve; }); const runner = vi.fn<GenerationProviderRunner>((_input, control) => new Promise<GeneratedOutput[]>((_resolve, reject) => { entered(); control.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); })); const value = await fixture(runner); const started = await value.manager.startHuman(value.request); await running; expect(value.manager.cancel(started.jobId)?.status).toBe('cancelled'); await new Promise((resolve) => setTimeout(resolve, 0)); expect(value.documents.getJob(started.jobId)).toMatchObject({ status: 'cancelled', message: 'Generation cancelled.' }); expect(runner).toHaveBeenCalledTimes(1);
  });

  it('fails closed around one deterministic, keyless QA-06 packaged generation fixture', async () => {
    const profilePath = await mkdtemp(join(tmpdir(), QA06_GENERATION_E2E_PROFILE_PREFIX)); temporaryDirectories.push(profilePath);
    const connectionPath = join(profilePath, QA06_GENERATION_E2E_CONNECTION_FILE);
    const outputPath = join(profilePath, QA06_GENERATION_E2E_OUTPUT_FILE);
    const auditPath = join(profilePath, QA06_GENERATION_E2E_AUDIT_FILE);
    const networkSentinelPath = join(profilePath, QA06_GENERATION_E2E_NETWORK_SENTINEL_FILE);
    const valid = { nodeEnv: 'test', enabled: '1', declaredProfilePath: profilePath, userDataPath: profilePath, connectionPath, outputPath, auditPath, networkSentinelPath };
    const configuration = resolveQa06GenerationE2eConfiguration(valid);
    expect(configuration).toEqual({ profilePath, connectionPath, outputPath, auditPath, networkSentinelPath, approvalTimeoutMs: QA06_GENERATION_E2E_APPROVAL_TIMEOUT_MS });
    expect(resolveQa06GenerationE2eConfiguration({ ...valid, nodeEnv: 'production' })).toBeUndefined();
    expect(resolveQa06GenerationE2eConfiguration({ ...valid, declaredProfilePath: join(profilePath, 'other') })).toBeUndefined();
    expect(resolveQa06GenerationE2eConfiguration({ ...valid, outputPath: join(profilePath, 'nested', QA06_GENERATION_E2E_OUTPUT_FILE) })).toBeUndefined();
    expect(resolveQa06GenerationE2eConfiguration({ ...valid, auditPath: join(profilePath, 'other.json') })).toBeUndefined();
    if (!configuration) throw new Error('Expected the exact isolated QA-06 generation configuration.');

    const documents = new DocumentService(new RecoveryJournal(join(profilePath, 'journal')), '0.1.0'); documentServices.push(documents); documents.initialize();
    const document = documents.create({ kind: 'illustration', name: QA06_GENERATION_E2E_DOCUMENT_NAME, width: 320, height: 240 }).activeDocument!;
    const sourceCanvas = createCanvas(32, 24); sourceCanvas.getContext('2d').fillStyle = '#6379aa'; sourceCanvas.getContext('2d').fillRect(0, 0, 32, 24); const sourceBytes = sourceCanvas.toBuffer('image/png');
    const maskCanvas = createCanvas(32, 24); maskCanvas.getContext('2d').fillStyle = '#ffffff'; maskCanvas.getContext('2d').fillRect(0, 0, 16, 24); const maskBytes = maskCanvas.toBuffer('image/png');
    const asset = (id: string, name: string, bytes: Buffer): DocumentAsset => ({ id, name, mimeType: 'image/png', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), source: 'imported', data: bytes.toString('base64') });
    expect((await documents.apply({ id: createId('tx'), clientOperationId: 'qa06-generation-fixture-assets', documentId: document.id, actor: HUMAN_ACTOR, label: 'Install QA-06 generation fixture assets', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset: asset(QA06_GENERATION_E2E_SOURCE_ASSET_ID, 'QA-06 source', sourceBytes) }, { kind: 'asset.add', asset: asset(QA06_GENERATION_E2E_MASK_ASSET_ID, 'QA-06 mask', maskBytes) }] })).status).toBe('committed');
    const current = documents.getDocument(document.id)!;
    const request = structuredClone({ documentId: document.id, ...QA06_GENERATION_E2E_REQUEST }) as GenerationRequest;
    const runner = createQa06GenerationE2eRunner(configuration);
    await expect(runner({ jobId: 'qa06-key-refusal', document: current, request, credential: 'must-not-enter-fixture' }, { signal: new AbortController().signal })).rejects.toThrow(/refuses hosted provider keys/);
    expect(await access(outputPath).then(() => true, () => false)).toBe(false);
    const progress = vi.fn();
    const outputs = await runner({ jobId: 'qa06-local-fixture', document: current, request }, { signal: new AbortController().signal, onProgress: progress });
    expect(outputs).toEqual([expect.objectContaining({ id: 'qa06-generated-fill-result', mimeType: 'image/png', width: 192, height: 128, seed: QA06_GENERATION_E2E_REQUEST.seed, providerMetadata: { fixture: 'qa06-generated-fill', transport: 'deterministic-local', externalProviderRequests: 0, paidRequests: 0 } })]);
    expect(Buffer.from(outputs[0].data, 'base64')).toEqual(await readFile(outputPath));
    const audit = JSON.parse(await readFile(auditPath, 'utf8')) as Record<string, unknown>;
    expect(audit).toMatchObject({ fixture: 'qa06-generated-fill', transport: 'in-process-deterministic-runner', invocationCount: 1, hostedKeyReceived: false, externalProviderRequests: 0, paidRequests: 0, output: { file: QA06_GENERATION_E2E_OUTPUT_FILE, width: 192, height: 128 } });
    expect(JSON.stringify(audit)).not.toMatch(/Bearer\s|Authorization|"token"\s*:/i);
    expect(progress).toHaveBeenCalledWith(0.3, expect.stringContaining('deterministic local fill'));
    const restoreFetch = installQa06GenerationE2eNetworkBoundary(configuration);
    try { await expect(fetch('https://api.stability.ai/v2beta/stable-image/generate/core')).rejects.toThrow(/blocked an external provider request/); }
    finally { restoreFetch(); }
    expect(JSON.parse(await readFile(networkSentinelPath, 'utf8'))).toMatchObject({ blocked: true, protocol: 'https:', hostname: 'api.stability.ai', externalProviderRequests: 1, paidRequests: 0 });
  });

  it('accepts outpaint by atomically expanding the artboard and offsetting existing editable content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-outpaint-')); temporaryDirectories.push(directory); const documents = new DocumentService(new RecoveryJournal(join(directory, 'journal')), '0.1.0'); documentServices.push(documents); documents.initialize(); const document = documents.create({ kind: 'illustration', name: 'Expanded scene', width: 10, height: 10 }).activeDocument!; if (document.kind !== 'illustration') throw new Error('Expected illustration');
    const sourceCanvas = createCanvas(10, 10); sourceCanvas.getContext('2d').fillStyle = '#ffffff'; sourceCanvas.getContext('2d').fillRect(0, 0, 10, 10); const sourceBytes = sourceCanvas.toBuffer('image/png'); const source: DocumentAsset = { id: 'source', name: 'Canvas source', mimeType: 'image/png', byteLength: sourceBytes.byteLength, sha256: createHash('sha256').update(sourceBytes).digest('hex'), source: 'imported', data: sourceBytes.toString('base64') };
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector'); if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer'); const timestamp = nowIso(); const shape: ShapeObject = { id: 'existing', revision: 0, name: 'Existing mark', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, type: 'shape', shape: 'rectangle', width: 2, height: 2, transform: { ...IDENTITY_TRANSFORM, x: 1, y: 1 }, visible: true, locked: false, opacity: 1, blendMode: 'normal', fill: { kind: 'solid', color: '#ff0000' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
    const setup: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Prepare outpaint', createdAt: timestamp, operations: [{ kind: 'asset.add', asset: source }, { kind: 'illustration.object.add', object: shape }] }; expect((await documents.apply(setup)).status).toBe('committed');
    const outputCanvas = createCanvas(15, 19); outputCanvas.getContext('2d').fillStyle = '#5aa9e6'; outputCanvas.getContext('2d').fillRect(0, 0, 15, 19); const outputData = outputCanvas.toBuffer('image/png').toString('base64'); const runner = vi.fn<GenerationProviderRunner>(async () => [{ id: 'expanded', mimeType: 'image/png', data: outputData, width: 15, height: 19 }]);
    const manager = new GenerationManager(documents, new ProviderCredentialStore(join(directory, 'credentials.json')), runner, async () => Buffer.from(source.data!, 'base64')); const request: GenerationRequest = { documentId: document.id, provider: 'stability', mode: 'outpaint', prompt: 'Continue the sky', sourceAssetIds: [source.id], size: 'auto', resultCount: 1, providerOptions: { left: 2, right: 3, up: 4, down: 5, creativity: 0.5 } };
    const started = await manager.startHuman(request); await waitForStatus(documents, started.jobId, 'completed'); expect(await manager.accept(started.jobId, 'expanded')).toEqual({ accepted: true });
    const expanded = documents.getDocument(document.id); if (!expanded || expanded.kind !== 'illustration') throw new Error('Expected illustration'); expect(expanded.artboard).toMatchObject({ width: 15, height: 19 }); expect(expanded.objects[shape.id].transform).toMatchObject({ x: 3, y: 5 }); const generated = Object.values(expanded.objects).find((object) => object.type === 'image' && object.name === 'Generated image'); expect(generated?.transform).toMatchObject({ x: 0, y: 0, scaleX: 1, scaleY: 1 }); expect(expanded.provenance[0].conversion).toEqual({ outpaint: { previousWidth: 10, previousHeight: 10, width: 15, height: 19, offsetX: 2, offsetY: 4 } });
    const undone = await documents.undo(document.id); if (undone.status !== 'committed') throw new Error(JSON.stringify(undone)); const restored = documents.getDocument(document.id); if (!restored || restored.kind !== 'illustration') throw new Error('Expected illustration'); expect(restored.artboard).toMatchObject({ width: 10, height: 10 }); expect(restored.objects[shape.id].transform).toMatchObject({ x: 1, y: 1 }); expect(Object.values(restored.objects).some((object) => object.type === 'image' && object.name === 'Generated image')).toBe(false);
  });
});
