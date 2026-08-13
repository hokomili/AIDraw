import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import {
  IDENTITY_TRANSFORM,
  createId,
  createPixelSprite,
  nowIso,
  type Actor,
  type CanvasTransaction,
  type DocumentAsset,
  type Provenance,
  type ShapeObject,
} from '@aidraw/core';
import { DocumentService } from '@main/document-service';
import { RecoveryJournal } from '@main/journal';
import { validateInlineDocumentAsset, type ImageDecodeValidator } from '@main/transaction-policy';

const temporaryPaths: string[] = [];
const services: DocumentService[] = [];
afterEach(async () => {
  const flushResults = await Promise.allSettled(services.splice(0).map((service) => service.flushRecovery()));
  const cleanupResults = await Promise.allSettled(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  const failures = [...flushResults, ...cleanupResults].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Transaction-policy fixture teardown failed.');
});

const AGENT: Actor = { id: 'agent-authenticated', kind: 'agent', name: 'Authenticated agent', color: '#31a6a0' };

function pngAsset(id = createId('asset'), overrides: Partial<DocumentAsset> = {}): DocumentAsset {
  const bytes = createCanvas(1, 1).toBuffer('image/png');
  return {
    id,
    name: 'Safe pixel',
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    source: 'embedded',
    data: bytes.toString('base64'),
    ...overrides,
  };
}

async function serviceFixture(imageDecoder?: ImageDecodeValidator): Promise<DocumentService> {
  const root = await mkdtemp(join(tmpdir(), 'aidraw-policy-'));
  temporaryPaths.push(root);
  const service = new DocumentService(new RecoveryJournal(root), '1.0.0', undefined, imageDecoder);
  services.push(service);
  service.initialize();
  return service;
}

describe('transaction trust policy', () => {
  it('accepts a verified raster and rejects forged length, hash, MIME, and dimensions', async () => {
    const valid = pngAsset('valid');
    const decoder = vi.fn<ImageDecodeValidator>(async (_bytes, expected) => {
      expect(expected).toEqual({ mimeType: 'image/png', width: 1, height: 1 });
    });
    await expect(validateInlineDocumentAsset(valid, decoder)).resolves.toBeUndefined();
    expect(decoder).toHaveBeenCalledOnce();
    await expect(validateInlineDocumentAsset({ ...valid, byteLength: valid.byteLength + 1 })).rejects.toThrow('declared');
    await expect(validateInlineDocumentAsset({ ...valid, sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256');
    await expect(validateInlineDocumentAsset({ ...valid, mimeType: 'image/svg+xml' })).rejects.toThrow('declares image/svg+xml');
    await expect(validateInlineDocumentAsset(valid, async () => { throw new Error('isolated decoder rejected the payload'); })).rejects.toThrow('could not be decoded safely: isolated decoder rejected the payload');

    const oversizedHeader = Buffer.from(valid.data!, 'base64');
    oversizedHeader.writeUInt32BE(8_193, 16);
    const oversized = pngAsset('oversized', {
      data: oversizedHeader.toString('base64'),
      byteLength: oversizedHeader.byteLength,
      sha256: createHash('sha256').update(oversizedHeader).digest('hex'),
    });
    await expect(validateInlineDocumentAsset(oversized)).rejects.toThrow('safety limit');
  });

  it('routes live asset admission through the injected isolated decoder and preserves the document on rejection', async () => {
    const decoder = vi.fn<ImageDecodeValidator>(async () => undefined);
    const service = await serviceFixture(decoder);
    const document = service.snapshot().activeDocument!;
    const accepted = pngAsset('isolated-accepted');
    expect((await service.apply({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: AGENT,
      label: 'Accept isolated asset', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset: accepted }],
    })).status).toBe('committed');
    expect(decoder).toHaveBeenCalledOnce();

    const rejected = pngAsset('isolated-rejected');
    decoder.mockRejectedValueOnce(new Error('decoder process exited'));
    const response = await service.apply({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: AGENT,
      label: 'Reject isolated asset', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset: rejected }],
    });
    expect(response).toMatchObject({ status: 'conflict', message: expect.stringContaining('decoder process exited') });
    expect(service.getDocument(document.id)?.assets[rejected.id]).toBeUndefined();
  });

  it('owns entity attribution and preserves the normalized identity through undo, redo, and replacement', async () => {
    const service = await serviceFixture();
    const document = service.snapshot().activeDocument!;
    if (document.kind !== 'illustration') throw new Error('Expected illustration');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector')!;
    const object: ShapeObject = {
      id: createId('shape'),
      revision: 42,
      name: 'Forged rectangle',
      createdAt: 'forged-created-at',
      updatedAt: 'forged-updated-at',
      createdBy: 'forged-actor',
      layerId: layer.id,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      transform: { ...IDENTITY_TRANSFORM, x: 4, y: 8 },
      type: 'shape',
      shape: 'rectangle',
      width: 16,
      height: 12,
      fill: { kind: 'solid', color: '#ff6b7a' },
      stroke: { paint: { kind: 'none' }, width: 0, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
    };
    const add: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: AGENT,
      label: 'Add forged object', createdAt: 'forged-transaction-time', operations: [{ kind: 'illustration.object.add', object }],
    };
    expect((await service.apply(add)).status).toBe('committed');
    const committed = service.getDocument(document.id);
    if (!committed || committed.kind !== 'illustration') throw new Error('Expected illustration');
    const normalized = committed.objects[object.id];
    expect(normalized).toMatchObject({ revision: 0, createdBy: AGENT.id });
    expect(normalized.createdAt).not.toBe('forged-created-at');
    expect(normalized.updatedAt).toBe(normalized.createdAt);
    expect(committed.activity.at(-1)?.actor).toMatchObject(AGENT);

    expect((await service.undo(document.id, AGENT)).status).toBe('committed');
    expect((await service.redo(document.id, AGENT)).status).toBe('committed');
    const restored = service.getDocument(document.id);
    if (!restored || restored.kind !== 'illustration') throw new Error('Expected illustration');
    expect(restored.objects[object.id]).toMatchObject({ revision: 0, createdBy: AGENT.id, createdAt: normalized.createdAt });

    const replace: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: AGENT,
      label: 'Try to rewrite identity', createdAt: nowIso(), operations: [{
        kind: 'illustration.object.replace', expectedRevision: 0,
        object: { ...restored.objects[object.id], revision: 900, createdBy: 'replacement-forgery', createdAt: 'replacement-forgery', transform: { ...restored.objects[object.id].transform, x: 20 } },
      }],
    };
    expect((await service.apply(replace)).status).toBe('committed');
    const replaced = service.getDocument(document.id);
    if (!replaced || replaced.kind !== 'illustration') throw new Error('Expected illustration');
    expect(replaced.objects[object.id]).toMatchObject({ revision: 1, createdBy: AGENT.id, createdAt: normalized.createdAt });
  });

  it('normalizes every nested entity in a newly added pixel asset', async () => {
    const service = await serviceFixture();
    const project = service.create({ kind: 'project' }).activeDocument!;
    if (project.kind !== 'pixel') throw new Error('Expected pixel project');
    const sprite = createPixelSprite('Nested forgery', 8, 8);
    const forge = (entity: { revision: number; createdAt: string; updatedAt: string; createdBy: string }) => {
      entity.revision = 99; entity.createdAt = 'forged'; entity.updatedAt = 'forged'; entity.createdBy = 'forged';
    };
    forge(sprite);
    Object.values(sprite.layers).forEach(forge);
    Object.values(sprite.frames).forEach(forge);
    Object.values(sprite.cels).forEach(forge);
    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: project.id, actor: AGENT,
      label: 'Add sprite', createdAt: 'forged', operations: [{ kind: 'pixel.asset.add', asset: sprite }],
    };
    expect((await service.apply(transaction)).status).toBe('committed');
    const committed = service.getDocument(project.id);
    if (!committed || committed.kind !== 'pixel') throw new Error('Expected pixel project');
    const normalized = committed.pixelAssets[sprite.id];
    if (normalized.type !== 'sprite') throw new Error('Expected sprite');
    for (const entity of [normalized, ...Object.values(normalized.layers), ...Object.values(normalized.frames), ...Object.values(normalized.cels)]) {
      expect(entity).toMatchObject({ revision: 0, createdBy: AGENT.id });
      expect(entity.createdAt).not.toBe('forged');
    }
  });

  it('reserves verified provenance for the engine and normalizes agent asset origin', async () => {
    const service = await serviceFixture();
    const document = service.snapshot().activeDocument!;
    const asset = pngAsset('generated-claim', { source: 'generated' });
    const provenance: Provenance = {
      id: 'provenance-claim', assetId: asset.id, provider: 'openai', modelOrWorkflow: 'forged-model',
      prompt: 'A forged claim', sourceAssetIds: [], createdAt: 'forged',
    };
    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: 'provenance-policy', documentId: document.id, actor: AGENT,
      label: 'Forge provenance', createdAt: 'forged', operations: [{ kind: 'asset.add', asset }, { kind: 'provenance.add', provenance }],
    };
    const blocked = await service.apply(transaction);
    expect(blocked).toMatchObject({ status: 'conflict' });
    expect(blocked.message).toContain('generation engine');
    expect(service.getDocument(document.id)?.assets[asset.id]).toBeUndefined();

    expect((await service.apply(transaction, { trustedProvenance: true })).status).toBe('committed');
    const committed = service.getDocument(document.id)!;
    expect(committed.assets[asset.id].source).toBe('embedded');
    expect(committed.provenance[0].createdAt).not.toBe('forged');

    const remove: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: AGENT,
      label: 'Erase provenance', createdAt: nowIso(), operations: [{ kind: 'provenance.delete', provenanceId: provenance.id }],
    };
    expect(await service.apply(remove)).toMatchObject({ status: 'conflict', message: expect.stringContaining('generation engine') });
  });
});
