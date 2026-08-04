import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { HUMAN_ACTOR, IDENTITY_TRANSFORM, createId, nowIso, type AsyncJob, type CanvasTransaction, type DocumentAsset, type ShapeObject } from '@aidraw/core';

vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 10, height: 10 }) }) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
}));

import type { GeneratedOutput, GenerationRequest } from '../../src/common/generation';
import { DocumentService } from '../../src/main/document-service';
import { GenerationManager } from '../../src/main/generation-manager';
import { RecoveryJournal } from '../../src/main/journal';
import { ProviderCredentialStore } from '../../src/main/provider-credentials';
import type { GenerationProviderRunner } from '../../src/main/generation-provider-runner';

const temporaryDirectories: string[] = [];
const documentServices: DocumentService[] = [];
afterEach(async () => { await Promise.all(documentServices.splice(0).map((service) => service.compactRecovery())); await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); vi.restoreAllMocks(); });

async function fixture(runner: GenerationProviderRunner, resultCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'aidraw-generation-')); temporaryDirectories.push(directory); const documents = new DocumentService(new RecoveryJournal(join(directory, 'journal')), '0.1.0'); documentServices.push(documents); documents.initialize(); const document = documents.create({ kind: 'sprite', name: 'Generated sprite', width: 4, height: 4 }).activeDocument!;
  const canvas = createCanvas(2, 2); canvas.getContext('2d').fillStyle = '#ff6b7a'; canvas.getContext('2d').fillRect(0, 0, 2, 2); const data = canvas.toBuffer('image/png').toString('base64');
  const manager = new GenerationManager(documents, new ProviderCredentialStore(join(directory, 'credentials.json')), runner, async () => ({ data, width: 2, height: 2 }), async () => [{ x: 0, y: 0, index: 3 }]);
  const request: GenerationRequest = { documentId: document.id, provider: 'openai', mode: 'create', prompt: 'A coral sprite', sourceAssetIds: [], size: 'auto', resultCount, providerOptions: {} };
  return { documents, document, manager, request, data };
}

async function waitForStatus(documents: DocumentService, jobId: string, status: AsyncJob['status']): Promise<AsyncJob> {
  for (let attempt = 0; attempt < 100; attempt += 1) { const job = documents.getJob(jobId); if (job?.status === status) return job; await new Promise((resolve) => setTimeout(resolve, 0)); }
  throw new Error(`Generation job ${jobId} did not reach ${status}.`);
}

describe('generation manager orchestration', () => {
  it('routes a result through the provider seam, records partial completion, and accepts it as indexed content with provenance', async () => {
    let outputData = ''; const runner = vi.fn<GenerationProviderRunner>(async () => [{ id: 'result-one', mimeType: 'image/png', data: outputData, width: 2, height: 2 }]); const value = await fixture(runner, 2); outputData = value.data;
    const started = await value.manager.startHuman(value.request); const completed = await waitForStatus(value.documents, started.jobId, 'completed'); expect(runner).toHaveBeenCalledTimes(1); expect(completed.message).toContain('1 of 2 requested results');
    const accepted = await value.manager.accept(started.jobId, 'result-one'); expect(accepted).toEqual({ accepted: true }); const document = value.documents.getDocument(value.document.id); if (!document || document.kind !== 'pixel') throw new Error('Expected pixel document'); const sprite = document.pixelAssets[document.activeAssetId]; if (sprite.type !== 'sprite') throw new Error('Expected sprite');
    expect(sprite.layerIds).toHaveLength(2); expect(document.provenance).toEqual([expect.objectContaining({ provider: 'openai', modelOrWorkflow: 'gpt-image-2', prompt: 'A coral sprite', conversion: expect.objectContaining({ width: 4, height: 4 }) })]); expect(Object.values(document.assets)).toEqual([expect.objectContaining({ source: 'generated' })]);
  });

  it('classifies a moderation/permission failure without retrying the provider seam', async () => {
    const error = Object.assign(new Error('request rejected'), { status: 403 }); const runner = vi.fn<GenerationProviderRunner>(async () => { throw error; }); const value = await fixture(runner); const started = await value.manager.startHuman(value.request); const failed = await waitForStatus(value.documents, started.jobId, 'failed');
    expect(runner).toHaveBeenCalledTimes(1); expect(failed.error).toEqual({ code: 'moderation_or_permission', message: 'request rejected', retryable: false }); expect(failed.message).toContain('without an automatic retry');
  });

  it('aborts an in-flight utility request and never overwrites the cancelled terminal state', async () => {
    let entered!: () => void; const running = new Promise<void>((resolve) => { entered = resolve; }); const runner = vi.fn<GenerationProviderRunner>((_input, control) => new Promise<GeneratedOutput[]>((_resolve, reject) => { entered(); control.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); })); const value = await fixture(runner); const started = await value.manager.startHuman(value.request); await running; expect(value.manager.cancel(started.jobId)?.status).toBe('cancelled'); await new Promise((resolve) => setTimeout(resolve, 0)); expect(value.documents.getJob(started.jobId)).toMatchObject({ status: 'cancelled', message: 'Generation cancelled.' }); expect(runner).toHaveBeenCalledTimes(1);
  });

  it('accepts outpaint by atomically expanding the artboard and offsetting existing editable content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aidraw-outpaint-')); temporaryDirectories.push(directory); const documents = new DocumentService(new RecoveryJournal(join(directory, 'journal')), '0.1.0'); documentServices.push(documents); documents.initialize(); const document = documents.create({ kind: 'illustration', name: 'Expanded scene', width: 10, height: 10 }).activeDocument!; if (document.kind !== 'illustration') throw new Error('Expected illustration');
    const sourceCanvas = createCanvas(10, 10); sourceCanvas.getContext('2d').fillStyle = '#ffffff'; sourceCanvas.getContext('2d').fillRect(0, 0, 10, 10); const sourceBytes = sourceCanvas.toBuffer('image/png'); const source: DocumentAsset = { id: 'source', name: 'Canvas source', mimeType: 'image/png', byteLength: sourceBytes.byteLength, sha256: createHash('sha256').update(sourceBytes).digest('hex'), source: 'imported', data: sourceBytes.toString('base64') };
    const vector = Object.values(document.layers).find((layer) => layer.type === 'vector'); if (!vector || vector.type !== 'vector') throw new Error('Expected vector layer'); const timestamp = nowIso(); const shape: ShapeObject = { id: 'existing', revision: 0, name: 'Existing mark', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, layerId: vector.id, type: 'shape', shape: 'rectangle', width: 2, height: 2, transform: { ...IDENTITY_TRANSFORM, x: 1, y: 1 }, visible: true, locked: false, opacity: 1, blendMode: 'normal', fill: { kind: 'solid', color: '#ff0000' }, stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] } };
    const setup: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Prepare outpaint', createdAt: timestamp, operations: [{ kind: 'asset.add', asset: source }, { kind: 'illustration.object.add', object: shape }] }; expect((await documents.apply(setup)).status).toBe('committed');
    const outputCanvas = createCanvas(15, 19); outputCanvas.getContext('2d').fillStyle = '#5aa9e6'; outputCanvas.getContext('2d').fillRect(0, 0, 15, 19); const outputData = outputCanvas.toBuffer('image/png').toString('base64'); const runner = vi.fn<GenerationProviderRunner>(async () => [{ id: 'expanded', mimeType: 'image/png', data: outputData, width: 15, height: 19 }]);
    const manager = new GenerationManager(documents, new ProviderCredentialStore(join(directory, 'credentials.json')), runner, async () => ({ data: source.data!, width: 10, height: 10 })); const request: GenerationRequest = { documentId: document.id, provider: 'stability', mode: 'outpaint', prompt: 'Continue the sky', sourceAssetIds: [source.id], size: 'auto', resultCount: 1, providerOptions: { left: 2, right: 3, up: 4, down: 5, creativity: 0.5 } };
    const started = await manager.startHuman(request); await waitForStatus(documents, started.jobId, 'completed'); expect(await manager.accept(started.jobId, 'expanded')).toEqual({ accepted: true });
    const expanded = documents.getDocument(document.id); if (!expanded || expanded.kind !== 'illustration') throw new Error('Expected illustration'); expect(expanded.artboard).toMatchObject({ width: 15, height: 19 }); expect(expanded.objects[shape.id].transform).toMatchObject({ x: 3, y: 5 }); const generated = Object.values(expanded.objects).find((object) => object.type === 'image' && object.name === 'Generated image'); expect(generated?.transform).toMatchObject({ x: 0, y: 0, scaleX: 1, scaleY: 1 }); expect(expanded.provenance[0].conversion).toEqual({ outpaint: { previousWidth: 10, previousHeight: 10, width: 15, height: 19, offsetX: 2, offsetY: 4 } });
    const undone = await documents.undo(document.id); if (undone.status !== 'committed') throw new Error(JSON.stringify(undone)); const restored = documents.getDocument(document.id); if (!restored || restored.kind !== 'illustration') throw new Error('Expected illustration'); expect(restored.artboard).toMatchObject({ width: 10, height: 10 }); expect(restored.objects[shape.id].transform).toMatchObject({ x: 1, y: 1 }); expect(Object.values(restored.objects).some((object) => object.type === 'image' && object.name === 'Generated image')).toBe(false);
  });
});
