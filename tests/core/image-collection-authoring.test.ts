import { describe, expect, it } from 'vitest';
import {
  HUMAN_ACTOR,
  CanvasOperationSchema,
  TransactionConflictError,
  applyTransaction,
  createId,
  createPixelDocument,
  createPixelSprite,
  createPixelTileset,
  nowIso,
  type CanvasTransaction,
} from '@aidraw/core';

import { imageCollectionSourceDependencyGuards, replaceImageCollectionTileMetadata } from '../../src/common/image-collection-authoring';

describe('image-collection metadata transaction', () => {
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
});
