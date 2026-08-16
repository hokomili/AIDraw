import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  CanvasOperationSchema,
  TransactionConflictError,
  applyTransaction,
  createId,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  nowIso,
  type CanvasTransaction,
} from '@aidraw/core';

import {
  appendImageCollectionSource,
  createImageCollectionTileset,
  imageCollectionSourceDependencyGuards,
  removeUnusedImageCollectionSource,
  replaceImageCollectionSource,
  replaceImageCollectionTileMetadata,
} from '../../src/common/image-collection-authoring';
import { planTileObjectCreation } from '../../src/common/tile-object-authoring';

describe('image-collection metadata transaction', () => {
  it('commits and inverses one guarded exact collection tile object while source drift refuses atomically', () => {
    const document = createPixelDocument('project', 'Collection tile object history');
    const source0 = createPixelSprite('Zero', 7, 11); const source3 = createPixelSprite('Three', 13, 5);
    const tileset = createPixelTileset('Collection', source0.id, 13, 11, 1, 1); tileset.spriteAssetId = undefined; tileset.firstGid = 17; tileset.columns = 0; tileset.rows = 0; tileset.wangSets = [];
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 1, animation: [], collisions: [], properties: {} },
    };
    const map = createPixelTilemap('Finite object map'); map.tilesetIds = [tileset.id]; const layer = map.layers[map.layerIds[0]]; layer.type = 'object'; delete layer.chunks; layer.objects = [];
    document.assetIds = [source0.id, source3.id, tileset.id, map.id]; document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [tileset.id]: tileset, [map.id]: map }; document.activeAssetId = map.id;
    const plan = planTileObjectCreation(document, { mapId: map.id, layerId: layer.id, tilesetId: tileset.id, tileId: 3, transforms: { hFlip: true, vFlip: false, diagonal: true }, point: { x: 9, y: 12 }, objectId: 'exact-collection-object' });
    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Place collection tile object', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: plan.asset, expectedRevision: plan.expectedRevision, expectedSpriteDependencies: plan.expectedSpriteDependencies }],
    };
    const applied = applyTransaction(document, transaction); const appliedDocument = applied.document; if (appliedDocument.kind !== 'pixel') throw new Error('Expected pixel document');
    const changedMap = appliedDocument.pixelAssets[map.id]; if (changedMap.type !== 'tilemap') throw new Error('Expected tilemap');
    expect(changedMap.layers[layer.id].objects).toEqual([plan.object]);
    expect(appliedDocument.activity[0]).toMatchObject({ label: 'Place collection tile object', operationCount: 1 });
    expect(() => removeUnusedImageCollectionSource(appliedDocument, tileset.id, 3)).toThrow('tile object');
    const restored = applyTransaction(appliedDocument, applied.inverse, { recordActivity: false }).document; if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    const restoredMap = restored.pixelAssets[map.id]; if (restoredMap.type !== 'tilemap') throw new Error('Expected tilemap'); expect(restoredMap.layers[layer.id].objects).toEqual([]);

    const drifted = structuredClone(document); const changedSource = drifted.pixelAssets[source3.id]; if (changedSource.type !== 'sprite') throw new Error('Expected sprite'); changedSource.revision += 1;
    expect(() => applyTransaction(drifted, transaction)).toThrow(TransactionConflictError);
    const unchangedMap = drifted.pixelAssets[map.id]; if (unchangedMap.type !== 'tilemap') throw new Error('Expected tilemap'); expect(unchangedMap.layers[layer.id].objects).toEqual([]); expect(drifted.activity).toEqual(document.activity);
  });

  it('creates and appends through existing guarded transactions with exact inverse restoration', () => {
    const document = createPixelDocument('project', 'Collection lifecycle history');
    const first = document.pixelAssets[document.activeAssetId]; if (first.type !== 'sprite') throw new Error('Expected sprite');
    first.name = 'First source';
    const second = createPixelSprite('Second source', 12, 9);
    document.assetIds.push(second.id); document.pixelAssets[second.id] = second;
    const sourceBytes = JSON.stringify([first, second]);
    const collection = createImageCollectionTileset(document, 'Objects', [first.id], { id: 'collection-history' });
    const create: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, expectedDocumentRevision: document.revision,
      actor: HUMAN_ACTOR, label: 'Create image collection', createdAt: nowIso(),
      operations: [{ kind: 'pixel.asset.add', asset: collection }, { kind: 'pixel.active-asset.set', assetId: collection.id }],
    };
    const created = applyTransaction(document, create); if (created.document.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(created.document.activeAssetId).toBe(collection.id);
    expect(created.document.pixelAssets[collection.id]).toEqual(collection);
    expect(JSON.stringify([created.document.pixelAssets[first.id], created.document.pixelAssets[second.id]])).toBe(sourceBytes);
    const restoredCreate = applyTransaction(created.document, created.inverse, { recordActivity: false }).document; if (restoredCreate.kind !== 'pixel') throw new Error('Expected pixel document');
    expect(restoredCreate.pixelAssets[collection.id]).toBeUndefined();
    expect(restoredCreate.activeAssetId).toBe(document.activeAssetId);

    const appendPlan = appendImageCollectionSource(created.document, collection.id, second.id);
    const append: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: created.document.id, expectedDocumentRevision: created.document.revision,
      actor: HUMAN_ACTOR, label: 'Append image-collection source', createdAt: nowIso(),
      operations: [{ kind: 'pixel.asset.replace', asset: appendPlan.tileset, expectedRevision: collection.revision, expectedSpriteDependencies: appendPlan.expectedSpriteDependencies }],
    };
    const appended = applyTransaction(created.document, append); if (appended.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const changed = appended.document.pixelAssets[collection.id]; if (changed.type !== 'tileset') throw new Error('Expected tileset');
    expect(changed.tiles[1].imageAssetId).toBe(second.id);
    expect(JSON.stringify([appended.document.pixelAssets[first.id], appended.document.pixelAssets[second.id]])).toBe(sourceBytes);
    const restoredAppend = applyTransaction(appended.document, appended.inverse, { recordActivity: false }).document; if (restoredAppend.kind !== 'pixel') throw new Error('Expected pixel document');
    const restoredTileset = restoredAppend.pixelAssets[collection.id]; if (restoredTileset.type !== 'tileset') throw new Error('Expected tileset');
    expect({ ...restoredTileset, revision: collection.revision, updatedAt: collection.updatedAt }).toEqual(collection);

    const concurrentlyChanged = structuredClone(created.document);
    concurrentlyChanged.name = 'Concurrent canonical edit'; concurrentlyChanged.revision += 1;
    expect(() => applyTransaction(concurrentlyChanged, append)).toThrow(TransactionConflictError);
    expect(concurrentlyChanged.pixelAssets[collection.id]).toEqual(collection);
  });

  it('commits and inverses one complete tileset replacement without changing sparse sources or artwork', () => {
    const document = createPixelDocument('project', 'Collection history');
    const source0 = createPixelSprite('Zero', 8, 12);
    const source3 = createPixelSprite('Three', 17, 6);
    const tileset = createPixelTileset('Collection', source0.id, 8, 12, 1, 1);
    tileset.spriteAssetId = undefined; tileset.columns = 2; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0; tileset.wangSets = [];
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 0.5, animation: [], collisions: [], properties: { biome: 'cave' } },
    };
    document.assetIds = [source0.id, source3.id, tileset.id]; document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [tileset.id]: tileset }; document.activeAssetId = tileset.id;
    const sourceBytes = JSON.stringify([source0, source3]);
    const next = replaceImageCollectionTileMetadata(tileset, 3, { probability: 0.8, animation: [{ tileId: 0, durationMs: 80 }, { tileId: 3, durationMs: 120 }], collisions: [{ id: 'solid', type: 'rectangle', x: 1, y: 1, width: 12, height: 4, properties: { damage: 3 } }], properties: { biome: 'forest', solid: true, cost: 2 } });
    next.tileOffset = { x: -7, y: 11 };
    const expectedSpriteDependencies = imageCollectionSourceDependencyGuards(document, tileset);
    const transaction: CanvasTransaction = { id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR, label: 'Edit image-collection tile', createdAt: nowIso(), operations: [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: tileset.revision, expectedSpriteDependencies }] };
    expect(CanvasOperationSchema.safeParse(transaction.operations[0]).success).toBe(true);
    expect(CanvasOperationSchema.safeParse({ ...transaction.operations[0], expectedSpriteDependencies: [expectedSpriteDependencies[0], expectedSpriteDependencies[0]] }).success).toBe(false);
    expect(CanvasOperationSchema.safeParse({ ...transaction.operations[0], expectedSpriteDependencies: [{ ...expectedSpriteDependencies[0], width: 0 }] }).success).toBe(false);
    const applied = applyTransaction(document, transaction); if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const changed = applied.document.pixelAssets[tileset.id]; if (changed.type !== 'tileset') throw new Error('Expected tileset');
    expect(changed.tiles[3]).toMatchObject({ id: 3, imageAssetId: source3.id, probability: 0.8, animation: [{ tileId: 0, durationMs: 80 }, { tileId: 3, durationMs: 120 }], collisions: [{ id: 'solid', type: 'rectangle', x: 1, y: 1, width: 12, height: 4, properties: { damage: 3 } }], properties: { biome: 'forest', solid: true, cost: 2 } });
    expect(Object.keys(changed.tiles)).toEqual(['0', '3']);
    expect(changed.tileOffset).toEqual({ x: -7, y: 11 });
    expect(applied.document.activity[0]).toMatchObject({ label: 'Edit image-collection tile', actor: HUMAN_ACTOR, operationCount: 1 });
    expect(JSON.stringify([applied.document.pixelAssets[source0.id], applied.document.pixelAssets[source3.id]])).toBe(sourceBytes);
    const restored = applyTransaction(applied.document, applied.inverse, { recordActivity: false }).document; if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    const restoredTileset = restored.pixelAssets[tileset.id]; if (restoredTileset.type !== 'tileset') throw new Error('Expected tileset');
    expect(restoredTileset.tiles).toEqual(tileset.tiles);
    expect(restoredTileset.tileOffset).toEqual({ x: 0, y: 0 });
    expect(() => applyTransaction(document, { ...transaction, operations: [{ kind: 'pixel.asset.replace', asset: next, expectedRevision: 9 }] })).toThrow(TransactionConflictError);
    const dimensionDrift = structuredClone(document);
    const driftedSource = dimensionDrift.pixelAssets[source3.id]; if (driftedSource.type !== 'sprite') throw new Error('Expected sprite');
    driftedSource.width += 1;
    expect(() => applyTransaction(dimensionDrift, transaction)).toThrow(TransactionConflictError);
    expect(dimensionDrift.pixelAssets[tileset.id]).toEqual(tileset);
  });

  it('commits exact-ID source replacement as one asset transaction and inverses the complete prior collection', () => {
    const document = createPixelDocument('project', 'Collection source replacement history');
    const source0 = createPixelSprite('Zero', 8, 10);
    const source3 = createPixelSprite('Three', 18, 14);
    const replacement = createPixelSprite('Replacement', 5, 6);
    const tileset = createPixelTileset('Collection', source0.id, source0.width, source0.height, 1, 1);
    tileset.spriteAssetId = undefined; tileset.columns = 0; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0; tileset.wangSets = [];
    tileset.tileWidth = 18; tileset.tileHeight = 14;
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [{ tileId: 3, durationMs: 70 }], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 0.35, animation: [{ tileId: 0, durationMs: 90 }], collisions: [{ id: 'solid', type: 'rectangle', x: 1, y: 2, width: 4, height: 5, properties: { damage: 2 } }], properties: { terrain: 'stone' } },
    };
    document.assetIds = [source0.id, source3.id, replacement.id, tileset.id];
    document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [replacement.id]: replacement, [tileset.id]: tileset };
    document.activeAssetId = tileset.id;
    const plan = replaceImageCollectionSource(document, tileset.id, 3, replacement.id);
    const sourceBytes = JSON.stringify([source0, source3, replacement]);
    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, actor: HUMAN_ACTOR,
      label: 'Replace image-collection source', createdAt: nowIso(),
      operations: [{ kind: 'pixel.asset.replace', asset: plan.tileset, expectedRevision: tileset.revision, expectedSpriteDependencies: plan.expectedSpriteDependencies }],
    };
    const applied = applyTransaction(document, transaction); if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const changed = applied.document.pixelAssets[tileset.id]; if (changed.type !== 'tileset') throw new Error('Expected tileset');
    expect(changed).toMatchObject({ firstGid: tileset.firstGid, tileWidth: 8, tileHeight: 10, tiles: { 3: { id: 3, imageAssetId: replacement.id, probability: 0.35, animation: [{ tileId: 0, durationMs: 90 }], collisions: tileset.tiles[3].collisions, properties: { terrain: 'stone' } } } });
    expect(JSON.stringify([applied.document.pixelAssets[source0.id], applied.document.pixelAssets[source3.id], applied.document.pixelAssets[replacement.id]])).toBe(sourceBytes);
    expect(applied.document.activity[0]).toMatchObject({ label: 'Replace image-collection source', operationCount: 1 });
    const restored = applyTransaction(applied.document, applied.inverse, { recordActivity: false }).document; if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    const restoredTileset = restored.pixelAssets[tileset.id]; if (restoredTileset.type !== 'tileset') throw new Error('Expected tileset');
    expect({ ...restoredTileset, revision: tileset.revision, updatedAt: tileset.updatedAt }).toEqual(tileset);

    for (const sourceId of [source3.id, replacement.id]) {
      const drifted = structuredClone(document); const source = drifted.pixelAssets[sourceId]; if (source.type !== 'sprite') throw new Error('Expected sprite');
      source.revision += 1;
      expect(() => applyTransaction(drifted, transaction)).toThrow(TransactionConflictError);
      expect(drifted.pixelAssets[tileset.id]).toEqual(tileset);
    }
  });

  it('commits proven-unused exact-ID removal as one document-guarded transaction and restores the complete sparse record', () => {
    const document = createPixelDocument('project', 'Collection source removal history');
    const source0 = createPixelSprite('Zero', 8, 10);
    const source3 = createPixelSprite('Three', 18, 14);
    const source7 = createPixelSprite('Seven', 5, 12);
    const tileset = createPixelTileset('Collection', source0.id, source0.width, source0.height, 1, 1);
    tileset.spriteAssetId = undefined; tileset.columns = 0; tileset.rows = 0; tileset.margin = 0; tileset.spacing = 0; tileset.wangSets = [];
    tileset.tileWidth = 18; tileset.tileHeight = 14;
    tileset.tiles = {
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [{ tileId: 7, durationMs: 70 }], collisions: [], properties: {} },
      3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 0.35, animation: [{ tileId: 0, durationMs: 90 }], collisions: [{ id: 'solid', type: 'rectangle', x: 1, y: 2, width: 4, height: 5, properties: { damage: 2 } }], properties: { terrain: 'stone' } },
      7: { id: 7, sourceX: 0, sourceY: 0, imageAssetId: source7.id, probability: 0.8, animation: [], collisions: [], properties: { retained: true } },
    };
    document.assetIds = [source0.id, source3.id, source7.id, tileset.id];
    document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [source7.id]: source7, [tileset.id]: tileset };
    document.activeAssetId = tileset.id;
    const plan = removeUnusedImageCollectionSource(document, tileset.id, 3);
    const sourceBytes = JSON.stringify([source0, source3, source7]);
    const transaction: CanvasTransaction = {
      id: createId('tx'), clientOperationId: createId('human-op'), documentId: document.id, expectedDocumentRevision: document.revision, actor: HUMAN_ACTOR,
      label: 'Remove unused image-collection source', createdAt: nowIso(),
      operations: [{ kind: 'pixel.asset.replace', asset: plan.tileset, expectedRevision: tileset.revision, expectedSpriteDependencies: plan.expectedSpriteDependencies }],
    };
    const applied = applyTransaction(document, transaction); if (applied.document.kind !== 'pixel') throw new Error('Expected pixel document');
    const changed = applied.document.pixelAssets[tileset.id]; if (changed.type !== 'tileset') throw new Error('Expected tileset');
    expect(Object.keys(changed.tiles)).toEqual(['0', '7']);
    expect(changed).toMatchObject({ firstGid: tileset.firstGid, tileWidth: 8, tileHeight: 12, tiles: { 0: tileset.tiles[0], 7: tileset.tiles[7] } });
    expect(JSON.stringify([applied.document.pixelAssets[source0.id], applied.document.pixelAssets[source3.id], applied.document.pixelAssets[source7.id]])).toBe(sourceBytes);
    expect(applied.document.activity[0]).toMatchObject({ label: 'Remove unused image-collection source', actor: HUMAN_ACTOR, operationCount: 1 });
    const restored = applyTransaction(applied.document, applied.inverse, { recordActivity: false }).document; if (restored.kind !== 'pixel') throw new Error('Expected pixel document');
    const restoredTileset = restored.pixelAssets[tileset.id]; if (restoredTileset.type !== 'tileset') throw new Error('Expected tileset');
    expect({ ...restoredTileset, revision: tileset.revision, updatedAt: tileset.updatedAt }).toEqual(tileset);

    const sourceDrift = structuredClone(document); const driftedSource = sourceDrift.pixelAssets[source3.id]; if (driftedSource.type !== 'sprite') throw new Error('Expected sprite');
    driftedSource.revision += 1;
    expect(() => applyTransaction(sourceDrift, transaction)).toThrow(TransactionConflictError);
    expect(sourceDrift.pixelAssets[tileset.id]).toEqual(tileset);
    const documentDrift = structuredClone(document); documentDrift.revision += 1;
    expect(() => applyTransaction(documentDrift, transaction)).toThrow(TransactionConflictError);
    expect(documentDrift.pixelAssets[tileset.id]).toEqual(tileset);
  });
});
