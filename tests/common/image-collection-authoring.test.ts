import { describe, expect, it } from 'vitest';
import { TILED_GID_MASK, createPixelDocument, createPixelSprite, createPixelTileset } from '@aidraw/core';

import {
  appendImageCollectionSource,
  createImageCollectionTileset,
  imageCollectionAuthoringGuardError,
  imageCollectionSourceEligibility,
  imageCollectionSourceObservationGuardError,
  imageCollectionSourceDependencyGuards,
  imageCollectionTileIds,
  replaceImageCollectionTileMetadata,
} from '../../src/common/image-collection-authoring';

function collectionFixture() {
  const document = createPixelDocument('project', 'Collection authoring');
  const source0 = createPixelSprite('Tile zero', 9, 7);
  const source3 = createPixelSprite('Tile three', 13, 5);
  const tileset = createPixelTileset('Collection', source0.id, 9, 7, 1, 1);
  tileset.spriteAssetId = undefined;
  tileset.columns = 2;
  tileset.rows = 0;
  tileset.margin = 0;
  tileset.spacing = 0;
  tileset.tiles = {
    0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [], collisions: [], properties: {} },
    3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 0.5, animation: [{ tileId: 0, durationMs: 80 }], collisions: [], properties: { biome: 'cave' } },
  };
  tileset.wangSets = [];
  document.assetIds = [source0.id, source3.id, tileset.id];
  document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [tileset.id]: tileset };
  document.activeAssetId = tileset.id;
  return { document, source0, source3, tileset };
}

describe('image-collection authoring boundary', () => {
  it('creates exact source-ordered tiles and appends above the sparse authored span without rebasing', () => {
    const document = createPixelDocument('project', 'Collection lifecycle');
    const first = createPixelSprite('First', 7, 11);
    const second = createPixelSprite('Second', 19, 5);
    const appended = createPixelSprite('Appended', 23, 13);
    document.assetIds = [second.id, first.id, appended.id];
    document.pixelAssets = { [first.id]: first, [second.id]: second, [appended.id]: appended };
    document.activeAssetId = second.id;
    const collection = createImageCollectionTileset(document, '  Environment  ', [second.id, first.id], { id: 'collection', createdAt: '2026-08-16T00:00:00.000Z', createdBy: 'tester' });
    expect(collection).toMatchObject({ id: 'collection', name: 'Environment', firstGid: 1, tileWidth: 19, tileHeight: 11, columns: 0, rows: 0, createdBy: 'tester' });
    expect(collection.spriteAssetId).toBeUndefined();
    expect(collection.tiles).toEqual({
      0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: second.id, probability: 1, animation: [], collisions: [], properties: {} },
      1: { id: 1, sourceX: 0, sourceY: 0, imageAssetId: first.id, probability: 1, animation: [], collisions: [], properties: {} },
    });
    document.assetIds.push(collection.id);
    document.pixelAssets[collection.id] = collection;
    delete collection.tiles[1];
    collection.tiles[3] = { id: 3, sourceX: 0, sourceY: 0, imageAssetId: first.id, probability: 0.4, animation: [], collisions: [], properties: { preserved: true } };
    const plan = appendImageCollectionSource(document, collection.id, appended.id);
    expect(plan.tileId).toBe(4);
    expect(plan.tileset.firstGid).toBe(1);
    expect(plan.tileset.tiles[3]).toEqual(collection.tiles[3]);
    expect(plan.tileset.tiles[4]).toMatchObject({ id: 4, imageAssetId: appended.id, probability: 1 });
    expect(plan.tileset).toMatchObject({ tileWidth: 23, tileHeight: 13 });
    expect(plan.expectedSpriteDependencies.map(({ spriteId }) => spriteId)).toEqual([second.id, first.id, appended.id]);
    const later = createImageCollectionTileset(document, 'Later collection', [appended.id], { id: 'later-collection' });
    expect(later.firstGid).toBe(5);
  });

  it('refuses animated, duplicate, oversized, overlapping, and exhausted lifecycle inputs', () => {
    const document = createPixelDocument('project', 'Collection refusals');
    const source = createPixelSprite('Source', 8, 8);
    const animated = createPixelSprite('Animated', 8, 8);
    animated.frameIds.push('frame-2'); animated.frames['frame-2'] = { ...animated.frames[animated.frameIds[0]], id: 'frame-2' };
    document.assetIds = [source.id, animated.id]; document.pixelAssets = { [source.id]: source, [animated.id]: animated }; document.activeAssetId = source.id;
    expect(imageCollectionSourceEligibility(document, source.id)).toBeUndefined();
    expect(imageCollectionSourceEligibility(document, animated.id)).toMatch(/one-frame sprites/);
    expect(() => createImageCollectionTileset(document, 'Collection', [source.id, source.id])).toThrow(/unique/);
    expect(() => createImageCollectionTileset(document, 'Collection', [animated.id])).toThrow(/one-frame/);
    expect(() => createImageCollectionTileset(document, 'Collection', Array.from({ length: 1_024 }, (_, index) => `source-${index}`))).toThrow(/at most 1,023/);
    const maximum = createPixelSprite('Maximum', 8_192, 8_192);
    const overflow = createPixelSprite('Overflow', 1, 1);
    document.assetIds.push(maximum.id, overflow.id);
    Object.assign(document.pixelAssets, { [maximum.id]: maximum, [overflow.id]: overflow });
    expect(() => createImageCollectionTileset(document, 'Too many pixels', [maximum.id, overflow.id])).toThrow(/64-megapixel/);
    const collection = createImageCollectionTileset(document, 'Collection', [source.id], { id: 'collection' });
    collection.firstGid = 4;
    const other = createPixelTileset('Atlas', source.id, 8, 8, 1, 1); other.firstGid = 5;
    const appendSource = createPixelSprite('Append', 8, 8);
    document.assetIds.push(collection.id, other.id, appendSource.id);
    Object.assign(document.pixelAssets, { [collection.id]: collection, [other.id]: other, [appendSource.id]: appendSource });
    expect(() => appendImageCollectionSource(document, collection.id, source.id)).toThrow(/already belongs/);
    expect(() => appendImageCollectionSource(document, collection.id, appendSource.id)).toThrow(/overlapping tileset/);
    other.firstGid = 20;
    collection.firstGid = TILED_GID_MASK;
    expect(() => appendImageCollectionSource(document, collection.id, appendSource.id)).toThrow(/28-bit/);
  });

  it('selects only exact sparse IDs and replaces metadata without changing source topology', () => {
    const { document, tileset, source0, source3 } = collectionFixture();
    expect(imageCollectionTileIds(tileset)).toEqual([0, 3]);
    expect(imageCollectionSourceDependencyGuards(document, tileset)).toEqual([
      { spriteId: source0.id, expectedRevision: source0.revision, width: source0.width, height: source0.height },
      { spriteId: source3.id, expectedRevision: source3.revision, width: source3.width, height: source3.height },
    ]);
    const next = replaceImageCollectionTileMetadata(tileset, 3, {
      probability: 0.75,
      animation: [{ tileId: 3, durationMs: 125 }, { tileId: 0, durationMs: 75 }],
      collisions: [{ id: 'collision-3', type: 'rectangle', x: 1, y: 2, width: 7, height: 3, properties: { damage: 4 } }],
      properties: { biome: 'forest', solid: true, cost: 2 },
    });
    expect(next.tiles[3]).toMatchObject({ id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 0.75 });
    expect(next.tiles[3].collisions).toEqual([{ id: 'collision-3', type: 'rectangle', x: 1, y: 2, width: 7, height: 3, properties: { damage: 4 } }]);
    expect(next.tiles[0].imageAssetId).toBe(source0.id);
    expect(Object.keys(next.tiles)).toEqual(['0', '3']);
    expect(tileset.tiles[3]).toMatchObject({ probability: 0.5, properties: { biome: 'cave' } });
    expect(() => replaceImageCollectionTileMetadata(tileset, 2, { probability: 1 })).toThrow(/unavailable/);
    expect(() => replaceImageCollectionTileMetadata(tileset, 3, { animation: [{ tileId: 2, durationMs: 100 }] })).toThrow(/existing sparse tile IDs/);
  });

  it('refuses stale collection, topology, and sprite-source observations before submission', () => {
    const { document, source3, tileset } = collectionFixture();
    expect(imageCollectionAuthoringGuardError(document, structuredClone(document), tileset.id)).toBeUndefined();
    const staleTileset = structuredClone(document);
    if (staleTileset.pixelAssets[tileset.id].type !== 'tileset') throw new Error('Expected tileset');
    staleTileset.pixelAssets[tileset.id].revision += 1;
    expect(imageCollectionAuthoringGuardError(document, staleTileset, tileset.id)).toMatch(/collection changed/);
    const changedSource = structuredClone(document);
    if (changedSource.pixelAssets[source3.id].type !== 'sprite') throw new Error('Expected sprite');
    changedSource.pixelAssets[source3.id].revision += 1;
    expect(imageCollectionAuthoringGuardError(document, changedSource, tileset.id)).toMatch(/tile 3 source changed/);
    const missingSource = structuredClone(document);
    delete missingSource.pixelAssets[source3.id];
    expect(imageCollectionAuthoringGuardError(document, missingSource, tileset.id)).toMatch(/tile 3 is missing/);
    expect(() => imageCollectionSourceDependencyGuards(missingSource, tileset)).toThrow(/tile 3 is missing/);
    const changedTopology = structuredClone(document);
    const changedTileset = changedTopology.pixelAssets[tileset.id];
    if (changedTileset.type !== 'tileset') throw new Error('Expected tileset');
    delete changedTileset.tiles[3];
    expect(imageCollectionAuthoringGuardError(document, changedTopology, tileset.id)).toMatch(/tile IDs changed/);
  });

  it('refuses a chooser source that changed after it was displayed', () => {
    const document = createPixelDocument('project', 'Collection source observation');
    const source = document.pixelAssets[document.activeAssetId]; if (source.type !== 'sprite') throw new Error('Expected sprite');
    expect(imageCollectionSourceObservationGuardError(document, structuredClone(document), [source.id])).toBeUndefined();
    const revised = structuredClone(document);
    const revisedSource = revised.pixelAssets[source.id]; if (revisedSource.type !== 'sprite') throw new Error('Expected sprite');
    revisedSource.revision += 1;
    expect(imageCollectionSourceObservationGuardError(document, revised, [source.id])).toMatch(/changed/);
    const missing = structuredClone(document); delete missing.pixelAssets[source.id];
    expect(imageCollectionSourceObservationGuardError(document, missing, [source.id])).toMatch(/missing or changed kind/);
  });
});
