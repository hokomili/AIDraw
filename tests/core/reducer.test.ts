import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  IDENTITY_TRANSFORM,
  TransactionConflictError,
  applyTransaction,
  createId,
  createIllustrationDocument,
  createPixelDocument,
  findDocumentAssetReferences,
  nowIso,
  type CanvasTransaction,
  type DocumentAsset,
  type ImageObject,
  type ShapeObject,
} from '@aidraw/core';

function shapeTransaction(documentId: string, layerId: string, expectedRevision?: number): CanvasTransaction {
  const timestamp = nowIso();
  const object: ShapeObject = {
    id: createId('shape'), revision: 0, name: 'Coral rectangle', createdAt: timestamp, updatedAt: timestamp,
    createdBy: HUMAN_ACTOR.id, layerId, visible: true, locked: false, opacity: 1, blendMode: 'normal',
    transform: { ...IDENTITY_TRANSFORM, x: 10, y: 12 }, type: 'shape', shape: 'rectangle', width: 120, height: 80,
    fill: { kind: 'solid', color: '#ff6b7a' },
    stroke: { paint: { kind: 'solid', color: '#27213c' }, width: 2, opacity: 1, lineCap: 'round', lineJoin: 'round', dash: [] },
  };
  return {
    id: createId('tx'), clientOperationId: createId('op'), documentId, actor: HUMAN_ACTOR, label: 'Add rectangle', createdAt: timestamp,
    operations: expectedRevision === undefined
      ? [{ kind: 'illustration.object.add', object }]
      : [{ kind: 'illustration.object.replace', object: { ...object, revision: expectedRevision }, expectedRevision }],
  };
}

describe('transaction reducer', () => {
  it('applies an atomic object addition and provides an exact inverse', () => {
    const document = createIllustrationDocument();
    const vector = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector')!;
    const transaction = shapeTransaction(document.id, vector.id);
    const applied = applyTransaction(document, transaction);
    if (applied.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(Object.keys(applied.document.objects)).toHaveLength(1);
    expect(applied.document.revision).toBe(1);
    expect(applied.document.activity[0].actor.id).toBe('human');

    const undone = applyTransaction(applied.document, applied.inverse);
    if (undone.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(Object.keys(undone.document.objects)).toHaveLength(0);
    expect(undone.document.revision).toBe(2);
  });

  it('rejects stale entity revisions without mutating the source', () => {
    const document = createIllustrationDocument();
    const vector = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector')!;
    const added = applyTransaction(document, shapeTransaction(document.id, vector.id)).document;
    if (added.kind !== 'illustration') throw new Error('Expected illustration');
    const object = Object.values(added.objects)[0];
    const stale: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('op'), documentId: added.id, actor: HUMAN_ACTOR, label: 'Stale move', createdAt: nowIso(),
      operations: [{ kind: 'illustration.object.replace', object: { ...object, transform: { ...object.transform, x: 44 } }, expectedRevision: 99 }],
    };
    expect(() => applyTransaction(added, stale)).toThrow(TransactionConflictError);
    expect(Object.values(added.objects)[0].transform.x).toBe(10);
  });

  it('moves layers into groups and restores their prior order on undo', () => {
    const document = createIllustrationDocument(); const timestamp = nowIso(); const vectorId = document.layerIds.find((id) => document.layers[id].type === 'vector')!;
    const group = { id: createId('layer'), revision: 0, name: 'Folder', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const, type: 'group' as const, childIds: [] };
    const added = applyTransaction(document, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Add group', createdAt: timestamp, operations: [{ kind: 'illustration.layer.add', layer: group }] }).document;
    const moved = applyTransaction(added, { id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Group layer', createdAt: timestamp, operations: [{ kind: 'illustration.layer.move', layerId: vectorId, parentId: group.id, expectedRevision: 0 }] });
    if (moved.document.kind !== 'illustration') throw new Error('Expected illustration');
    const movedGroup = moved.document.layers[group.id]; expect(moved.document.layerIds).not.toContain(vectorId); if (movedGroup.type !== 'group') throw new Error('Expected group'); expect(movedGroup.childIds).toContain(vectorId);
    const restored = applyTransaction(moved.document, moved.inverse).document;
    if (restored.kind !== 'illustration') throw new Error('Expected illustration');
    expect(restored.layerIds).toContain(vectorId); expect(restored.layers[vectorId].parentId).toBeUndefined();
  });

  it('reorders vector objects with a revision-checked, exactly undoable move', () => {
    const document = createIllustrationDocument();
    const vector = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector')!;
    const first = applyTransaction(document, shapeTransaction(document.id, vector.id)).document;
    const second = applyTransaction(first, shapeTransaction(document.id, vector.id)).document;
    if (second.kind !== 'illustration') throw new Error('Expected illustration');
    const layerBefore = second.layers[vector.id];
    if (layerBefore.type !== 'vector') throw new Error('Expected vector layer');
    const [firstId, secondId] = layerBefore.objectIds;

    const moved = applyTransaction(second, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: second.id, actor: HUMAN_ACTOR,
      label: 'Move object up', createdAt: nowIso(),
      operations: [{ kind: 'illustration.object.move', objectId: firstId, layerId: vector.id, index: 1, expectedRevision: second.objects[firstId].revision }],
    });
    if (moved.document.kind !== 'illustration') throw new Error('Expected illustration');
    const movedLayer = moved.document.layers[vector.id];
    if (movedLayer.type !== 'vector') throw new Error('Expected vector layer');
    expect(movedLayer.objectIds).toEqual([secondId, firstId]);
    expect(moved.document.objects[firstId].revision).toBe(1);

    const restored = applyTransaction(moved.document, moved.inverse).document;
    if (restored.kind !== 'illustration') throw new Error('Expected illustration');
    const restoredLayer = restored.layers[vector.id];
    if (restoredLayer.type !== 'vector') throw new Error('Expected vector layer');
    expect(restoredLayer.objectIds).toEqual([firstId, secondId]);
  });

  it('moves an object across vector layers and restores its source layer on undo', () => {
    const document = createIllustrationDocument();
    const source = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector')!;
    const timestamp = nowIso();
    const target = {
      id: createId('layer'), revision: 0, name: 'Foreground', createdAt: timestamp, updatedAt: timestamp,
      createdBy: HUMAN_ACTOR.id, visible: true, locked: false, opacity: 1, blendMode: 'normal' as const,
      type: 'vector' as const, objectIds: [],
    };
    const withLayer = applyTransaction(document, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Add vector layer', createdAt: timestamp, operations: [{ kind: 'illustration.layer.add', layer: target }],
    }).document;
    const withObject = applyTransaction(withLayer, shapeTransaction(document.id, source.id)).document;
    if (withObject.kind !== 'illustration') throw new Error('Expected illustration');
    const objectId = Object.keys(withObject.objects)[0];
    const moved = applyTransaction(withObject, {
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Move to foreground', createdAt: timestamp,
      operations: [{ kind: 'illustration.object.move', objectId, layerId: target.id, expectedRevision: withObject.objects[objectId].revision }],
    });
    if (moved.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(moved.document.objects[objectId].layerId).toBe(target.id);
    const targetLayer = moved.document.layers[target.id];
    if (targetLayer.type !== 'vector') throw new Error('Expected vector layer');
    expect(targetLayer.objectIds).toContain(objectId);

    const restored = applyTransaction(moved.document, moved.inverse).document;
    if (restored.kind !== 'illustration') throw new Error('Expected illustration');
    expect(restored.objects[objectId].layerId).toBe(source.id);
    const sourceLayer = restored.layers[source.id];
    if (sourceLayer.type !== 'vector') throw new Error('Expected vector layer');
    expect(sourceLayer.objectIds).toContain(objectId);
  });

  it('rejects referenced asset deletion and supports an explicit ordered cascade with an exact inverse', () => {
    const document = createIllustrationDocument();
    const vector = document.layerIds.map((id) => document.layers[id]).find((layer) => layer.type === 'vector')!;
    if (vector.type !== 'vector') throw new Error('Expected vector layer');
    const timestamp = nowIso();
    const asset: DocumentAsset = { id: 'asset-image', name: 'Referenced image', mimeType: 'image/png', byteLength: 0, sha256: '0'.repeat(64), source: 'embedded' };
    const object: ImageObject = {
      id: 'image-object', revision: 0, name: 'Image object', createdAt: timestamp, updatedAt: timestamp, createdBy: HUMAN_ACTOR.id,
      layerId: vector.id, visible: true, locked: false, opacity: 1, blendMode: 'normal', transform: { ...IDENTITY_TRANSFORM },
      type: 'image', assetId: asset.id, width: 1, height: 1, filters: [],
    };
    document.assets[asset.id] = asset;
    document.objects[object.id] = object;
    vector.objectIds.push(object.id);
    const deletion = (operations: CanvasTransaction['operations']): CanvasTransaction => ({
      id: createId('tx'), clientOperationId: createId('op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Delete embedded image', createdAt: timestamp, operations,
    });

    expect(() => applyTransaction(document, deletion([{ kind: 'asset.delete', assetId: asset.id }]))).toThrow(/still referenced by objects\.image-object\.assetId/);
    const removed = applyTransaction(document, deletion([
      { kind: 'illustration.object.delete', objectId: object.id, expectedRevision: 0 },
      { kind: 'asset.delete', assetId: asset.id },
    ]));
    if (removed.document.kind !== 'illustration') throw new Error('Expected illustration');
    expect(removed.document.assets[asset.id]).toBeUndefined();
    expect(removed.document.objects[object.id]).toBeUndefined();

    const restored = applyTransaction(removed.document, removed.inverse).document;
    if (restored.kind !== 'illustration') throw new Error('Expected illustration');
    expect(restored.assets[asset.id]).toEqual(asset);
    expect(restored.objects[object.id]).toEqual(object);
  });

  it('reports linked-preview and provenance references to embedded assets', () => {
    const document = createPixelDocument('project');
    const asset: DocumentAsset = { id: 'source-image', name: 'Source', mimeType: 'image/png', byteLength: 0, sha256: '0'.repeat(64), source: 'embedded' };
    document.assets[asset.id] = asset;
    document.linkedAssets.push({ id: 'link-1', name: 'Linked source', mode: 'linked', cachedPreviewAssetId: asset.id });
    document.provenance.push({
      id: 'provenance-1', assetId: asset.id, provider: 'external', modelOrWorkflow: 'manual', sourceAssetIds: [asset.id], maskAssetId: asset.id, createdAt: nowIso(),
    });
    expect(findDocumentAssetReferences(document, asset.id)).toEqual(expect.arrayContaining([
      'linkedAssets.link-1.cachedPreviewAssetId',
      'provenance.provenance-1.assetId',
      'provenance.provenance-1.sourceAssetIds.0',
      'provenance.provenance-1.maskAssetId',
    ]));
  });
});
