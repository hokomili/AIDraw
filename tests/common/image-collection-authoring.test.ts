import { describe, expect, it } from 'vitest';
import { createPixelDocument, createPixelSprite, createPixelTileset } from '@aidraw/core';

import {
  imageCollectionAuthoringGuardError,
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
});
