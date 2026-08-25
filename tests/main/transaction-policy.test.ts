import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import {
  IDENTITY_TRANSFORM,
  HUMAN_ACTOR,
  createId,
  createIllustrationDocument,
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
import {
  MAX_TRANSACTION_IMAGE_DECODES,
  MAX_TRANSACTION_IMAGE_DECODE_MS,
  TransactionImageProjectionCursor,
  TransactionImageWorkContext,
  prepareTransactionForCommit,
  validateInlineDocumentAsset,
  type ImageDecodeValidator,
} from '@main/transaction-policy';

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
  it('fixes the public transaction image-work bounds at sixteen projections and thirty seconds', () => {
    expect(MAX_TRANSACTION_IMAGE_DECODES).toBe(16);
    expect(MAX_TRANSACTION_IMAGE_DECODE_MS).toBe(30_000);
  });

  it('admits projection work before inspection, reuses one buffer across layers, and invalidates deterministically', () => {
    const asset = pngAsset('shared-ingress-projection');
    const context = new TransactionImageWorkContext({ maximum: 1 });
    const ingressCursor = new TransactionImageProjectionCursor();
    const commitCursor = new TransactionImageProjectionCursor();
    const ingress = context.inspectProjection(ingressCursor, asset.id, asset, 'Ingress image');
    const commit = context.inspectProjection(commitCursor, asset.id, { ...asset }, 'Commit image');
    expect(commit).toBe(ingress);
    expect(commit.bytes).toBe(ingress.bytes);

    commitCursor.invalidate(asset.id);
    expect(() => context.inspectProjection(commitCursor, asset.id, asset, 'Changed projection')).toThrow('at most 1 distinct image-asset projections');

    const expired = new TransactionImageWorkContext({ budgetMs: 1, startedAt: Date.now() - 10 });
    expect(() => expired.inspectProjection(
      new TransactionImageProjectionCursor(),
      asset.id,
      { ...asset, sha256: '0'.repeat(64) },
      'Expired forged image',
    )).toThrow('deadline expired before');
  });

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

  it('binds image-object source geometry to usable embedded bytes before canonical commit', async () => {
    const service = await serviceFixture();
    const document = service.snapshot().activeDocument!;
    if (document.kind !== 'illustration') throw new Error('Expected illustration');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer) throw new Error('Expected vector layer');
    const asset = pngAsset('bound-image');
    expect(await service.apply({
      id: createId('tx'), clientOperationId: 'bound-image-asset', documentId: document.id, actor: AGENT,
      label: 'Add embedded image bytes', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }],
    })).toMatchObject({ status: 'committed' });
    const timestamp = nowIso();
    const object = {
      id: 'bound-image-object', revision: 0, name: 'Bound image', createdAt: timestamp, updatedAt: timestamp, createdBy: 'forged',
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: IDENTITY_TRANSFORM,
      type: 'image' as const, assetId: asset.id, width: 40, height: 20, filters: [],
    };
    expect(await service.apply({
      id: createId('tx'), clientOperationId: 'bound-image-object-add', documentId: document.id, actor: AGENT,
      label: 'Add byte-bound image object', createdAt: timestamp, operations: [{ kind: 'illustration.object.add', object }],
    })).toMatchObject({ status: 'committed' });
    const committed = service.getDocument(document.id);
    if (!committed || committed.kind !== 'illustration') throw new Error('Expected illustration');
    expect(committed.objects[object.id]).toMatchObject({ sourceWidth: 1, sourceHeight: 1, createdBy: AGENT.id });

    const before = structuredClone(committed);
    const current = committed.objects[object.id];
    if (current.type !== 'image') throw new Error('Expected image object');
    const mismatch = await service.apply({
      id: createId('tx'), clientOperationId: 'bound-image-mismatch', documentId: document.id, actor: AGENT,
      label: 'Reject forged source geometry', createdAt: nowIso(), operations: [{
        kind: 'illustration.object.replace', expectedRevision: current.revision,
        object: { ...current, sourceWidth: 2, sourceHeight: 1 },
      }],
    });
    expect(mismatch).toMatchObject({ status: 'conflict', message: expect.stringContaining('must match embedded asset width 1') });
    expect(service.getDocument(document.id)).toEqual(before);
  });

  it('inspects and decodes one projected image asset once across 256 references, then invalidates on replacement', async () => {
    const document = createIllustrationDocument('Cached image validation');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    const asset = pngAsset('shared-image');
    document.assets[asset.id] = asset;
    const timestamp = nowIso();
    const image = (id: string) => ({
      id, revision: 0, name: id, createdAt: timestamp, updatedAt: timestamp, createdBy: AGENT.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM },
      type: 'image' as const, assetId: asset.id, width: 1, height: 1, filters: [],
    });
    const decoder = vi.fn<ImageDecodeValidator>(async () => undefined);
    const transaction: CanvasTransaction = {
      id: 'cached-asset-transaction', clientOperationId: 'cached-asset-operation', documentId: document.id, actor: AGENT,
      label: 'Reuse one validated asset', createdAt: timestamp,
      operations: Array.from({ length: 256 }, (_, index) => ({ kind: 'illustration.object.add' as const, object: image(`cached-image-${index}`) })),
    };
    const prepared = await prepareTransactionForCommit(document, transaction, timestamp, { imageDecoder: decoder });
    expect(prepared.operations).toHaveLength(256);
    expect(prepared.operations.every((operation) => operation.kind === 'illustration.object.add' && operation.object.type === 'image' && operation.object.sourceWidth === 1 && operation.object.sourceHeight === 1)).toBe(true);
    expect(decoder).toHaveBeenCalledOnce();

    const existing = image('existing-image');
    document.objects[existing.id] = existing;
    layer.objectIds.push(existing.id);
    decoder.mockClear();
    const replacement = { ...pngAsset(asset.id), name: 'Replacement projection' };
    const projected: CanvasTransaction = {
      id: 'reprojected-asset-transaction', clientOperationId: 'reprojected-asset-operation', documentId: document.id, actor: AGENT,
      label: 'Replace projected asset identity', createdAt: timestamp,
      operations: [
        { kind: 'illustration.object.replace', object: existing, expectedRevision: 0 },
        { kind: 'illustration.object.delete', objectId: existing.id, expectedRevision: 1 },
        { kind: 'asset.delete', assetId: asset.id },
        { kind: 'asset.add', asset: replacement },
        { kind: 'illustration.object.add', object: image('replacement-image') },
      ],
    };
    await expect(prepareTransactionForCommit(document, projected, timestamp, { imageDecoder: decoder })).resolves.toMatchObject({ operations: expect.any(Array) });
    expect(decoder).toHaveBeenCalledTimes(2);
  });

  it('rejects a transaction before a seventeenth distinct supervised image decode without mutating the document', async () => {
    const decoder = vi.fn<ImageDecodeValidator>(async () => undefined);
    const service = await serviceFixture(decoder);
    const document = createIllustrationDocument('Bounded distinct image validation');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso();
    const operations = Array.from({ length: 17 }, (_, index) => {
      const asset = pngAsset(`distinct-image-${index}`);
      document.assets[asset.id] = asset;
      return {
        kind: 'illustration.object.add' as const,
        object: {
          id: `distinct-object-${index}`, revision: 0, name: `Distinct object ${index}`, createdAt: timestamp, updatedAt: timestamp, createdBy: AGENT.id,
          layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM },
          type: 'image' as const, assetId: asset.id, width: 1, height: 1, filters: [],
        },
      };
    });
    service.addDocument(document);
    const before = service.getDocument(document.id);
    const response = await service.apply({
      id: 'distinct-image-budget-transaction', clientOperationId: 'distinct-image-budget-operation', documentId: document.id, actor: AGENT,
      label: 'Reject excessive distinct image work', createdAt: timestamp, operations,
    });
    expect(response).toMatchObject({ status: 'conflict', message: expect.stringContaining('at most 16 distinct image-asset projections') });
    expect(decoder).toHaveBeenCalledTimes(16);
    expect(service.getDocument(document.id)).toEqual(before);
  });

  it('aborts and returns when the aggregate supervised image-decode deadline expires', async () => {
    const document = createIllustrationDocument('Image deadline');
    const asset = pngAsset('deadline-image');
    const decoder = vi.fn<ImageDecodeValidator>(async (_bytes, _expected, control) => {
      expect(control?.timeoutMs).toBeGreaterThan(0);
      expect(control?.timeoutMs).toBeLessThanOrEqual(25);
      await new Promise<void>(() => undefined);
    });
    const transaction: CanvasTransaction = {
      id: 'image-deadline-transaction', clientOperationId: 'image-deadline-operation', documentId: document.id, actor: AGENT,
      label: 'Bound image decode time', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }],
    };
    await expect(prepareTransactionForCommit(document, transaction, nowIso(), {
      imageDecoder: decoder,
      imageDecodeBudgetMs: 25,
    })).rejects.toThrow('transaction image-work deadline expired');
    expect(decoder).toHaveBeenCalledOnce();
    expect(decoder.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  });

  it('rejects a decode that settles only after the shared workload deadline', async () => {
    const document = createIllustrationDocument('Late image decode');
    const asset = pngAsset('late-image');
    const transaction: CanvasTransaction = {
      id: 'late-image-transaction', clientOperationId: 'late-image-operation', documentId: document.id, actor: AGENT,
      label: 'Reject late image decode', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }],
    };
    let clock = 1_000;
    const clockSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const context = new TransactionImageWorkContext({ budgetMs: 25 });
      await expect(prepareTransactionForCommit(document, transaction, transaction.createdAt, {
        imageWorkContext: context,
        imageDecoder: async () => { clock = 1_025; },
      })).rejects.toThrow('transaction image-work deadline expired');
    } finally {
      clockSpy.mockRestore();
    }
  });

  it('keeps a supported legacy crop deletable, reversible, checkpointable, and recoverable without broadening new admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-legacy-image-inverse-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    service.initialize();
    const document = createIllustrationDocument('Legacy crop compatibility');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    const asset = pngAsset('legacy-crop-asset');
    document.assets[asset.id] = asset;
    const timestamp = nowIso();
    const legacyImage = {
      id: 'legacy-cropped-image', revision: 0, name: 'Legacy cropped image', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM },
      type: 'image' as const, assetId: asset.id, width: 20, height: 20, crop: { x: 0, y: 0, width: 1, height: 1 }, filters: [],
    };
    document.objects[legacyImage.id] = legacyImage;
    layer.objectIds.push(legacyImage.id);
    service.addDocument(document);

    const before = service.getDocument(document.id);
    expect(await service.apply({
      id: createId('tx'), clientOperationId: 'legacy-crop-hostile-replace', documentId: document.id, actor: AGENT,
      label: 'Reject incomplete new crop', createdAt: timestamp,
      operations: [{ kind: 'illustration.object.replace', object: { ...legacyImage, name: 'Should not commit' }, expectedRevision: 0 }],
    })).toMatchObject({ status: 'conflict' });
    expect(service.getDocument(document.id)).toEqual(before);

    const checkpoint = service.createCheckpoint(document.id, 'Legacy crop retained');
    expect(await service.apply({
      id: createId('tx'), clientOperationId: 'legacy-crop-delete', documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Delete legacy crop', createdAt: timestamp,
      operations: [{ kind: 'illustration.object.delete', objectId: legacyImage.id, expectedRevision: 0 }],
    })).toMatchObject({ status: 'committed' });
    expect(await service.undo(document.id)).toMatchObject({ status: 'committed' });
    const undone = service.getDocument(document.id);
    expect(undone?.kind === 'illustration' ? undone.objects[legacyImage.id] : undefined).toMatchObject({ crop: legacyImage.crop });
    expect(undone?.kind === 'illustration' ? undone.objects[legacyImage.id] : undefined).not.toHaveProperty('sourceWidth');
    expect(await service.redo(document.id)).toMatchObject({ status: 'committed' });
    expect(await service.restoreCheckpoint(document.id, checkpoint.id)).toMatchObject({ status: 'committed' });
    await service.flushRecovery();
    const recovered = (await new RecoveryJournal(root).recover()).find((candidate) => candidate.id === document.id);
    expect(recovered?.kind === 'illustration' ? recovered.objects[legacyImage.id] : undefined).toMatchObject({ crop: legacyImage.crop });
    expect(recovered?.kind === 'illustration' ? recovered.objects[legacyImage.id] : undefined).not.toHaveProperty('sourceWidth');
  });

  it('compacts a default-transforming legacy shape inverse so restart recovery preserves exact bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidraw-legacy-shape-inverse-'));
    temporaryPaths.push(root);
    const service = new DocumentService(new RecoveryJournal(root), '1.0.0');
    services.push(service);
    service.initialize();
    const document = createIllustrationDocument('Legacy rectangle recovery');
    const layer = Object.values(document.layers).find((entry) => entry.type === 'vector');
    if (!layer || layer.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso();
    const legacyRectangle = {
      id: 'legacy-defaultless-rectangle', revision: 0, name: 'Legacy defaultless rectangle', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: layer.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, transform: { ...IDENTITY_TRANSFORM },
      type: 'shape' as const, shape: 'rectangle' as const, width: 24, height: 18,
      fill: { kind: 'solid' as const, color: '#8268dd' },
      stroke: { paint: { kind: 'none' as const }, width: 0, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, dash: [] },
    };
    document.objects[legacyRectangle.id] = legacyRectangle;
    layer.objectIds.push(legacyRectangle.id);
    service.addDocument(document);

    expect(await service.apply({
      id: 'legacy-rectangle-delete-transaction', clientOperationId: 'legacy-rectangle-delete-operation', documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Delete legacy rectangle', createdAt: timestamp,
      operations: [{ kind: 'illustration.object.delete', objectId: legacyRectangle.id, expectedRevision: 0 }],
    })).toMatchObject({ status: 'committed' });
    expect(await service.undo(document.id)).toMatchObject({ status: 'committed' });
    const restored = service.getDocument(document.id);
    expect(restored?.kind === 'illustration' ? restored.objects[legacyRectangle.id] : undefined).toEqual(legacyRectangle);
    expect(restored?.kind === 'illustration' ? restored.objects[legacyRectangle.id] : undefined).not.toHaveProperty('cornerRadius');

    await service.flushRecovery();
    const recovered = (await new RecoveryJournal(root).recover()).find((candidate) => candidate.id === document.id);
    expect(recovered?.kind === 'illustration' ? recovered.objects[legacyRectangle.id] : undefined).toEqual(legacyRectangle);
    expect(recovered?.kind === 'illustration' ? recovered.objects[legacyRectangle.id] : undefined).not.toHaveProperty('cornerRadius');
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

  it('keeps historical provider provenance read-only and normalizes an agent asset origin', async () => {
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
    expect(blocked.message).toContain('read-only compatibility metadata');
    expect(service.getDocument(document.id)?.assets[asset.id]).toBeUndefined();

    const assetOnly = { ...transaction, clientOperationId: 'asset-origin-policy', operations: [{ kind: 'asset.add' as const, asset }] };
    expect((await service.apply(assetOnly)).status).toBe('committed');
    const committed = service.getDocument(document.id)!;
    expect(committed.assets[asset.id].source).toBe('embedded');
    expect(committed.provenance).toEqual([]);

    const remove: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: AGENT,
      label: 'Erase provenance', createdAt: nowIso(), operations: [{ kind: 'provenance.delete', provenanceId: provenance.id }],
    };
    expect(await service.apply(remove)).toMatchObject({ status: 'conflict', message: expect.stringContaining('read-only compatibility metadata') });
  });
});
