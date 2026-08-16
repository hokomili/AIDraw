import { describe, expect, it } from 'vitest';
import {
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  type PixelDocument,
  type PixelTileset,
} from '@aidraw/core';
import {
  planImageCollectionWangMutation,
  planWangTerrainSelection,
  wangTerrainSelectionPlansMatch,
} from '../../src/common/wang-terrain-authoring';

function fixture(): { document: PixelDocument; collection: PixelTileset; mapId: string } {
  const document = createPixelDocument('project', 'Collection Wang project');
  document.assetIds = []; document.pixelAssets = {};
  const source0 = createPixelSprite('Empty terrain', 8, 8);
  const source3 = createPixelSprite('Filled terrain', 11, 7);
  const collection = createPixelTileset('Sparse terrain', source0.id, 11, 8, 1, 1);
  delete collection.spriteAssetId; collection.firstGid = 20; collection.columns = 2; collection.rows = 0; collection.margin = 0; collection.spacing = 0;
  collection.tiles = {
    0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: source0.id, probability: 1, animation: [], collisions: [], properties: {} },
    3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: source3.id, probability: 1, animation: [{ tileId: 0, durationMs: 100 }], collisions: [], properties: {} },
  };
  collection.wangSets = [{
    id: 'sparse-wang', name: 'Sparse Wang', type: 'mixed',
    colors: [{ id: 1, name: 'Ground', color: '#55aa44', tileId: 3, probability: 1 }],
    tiles: [
      { tileId: 0, wangId: [0, 0, 0, 0, 0, 0, 0, 0] },
      { tileId: 3, wangId: [1, 1, 1, 1, 1, 1, 1, 1] },
    ],
  }];
  const map = createPixelTilemap('Finite terrain map'); map.tilesetIds = [collection.id];
  document.assetIds = [source0.id, source3.id, collection.id, map.id];
  document.pixelAssets = { [source0.id]: source0, [source3.id]: source3, [collection.id]: collection, [map.id]: map };
  document.activeAssetId = map.id;
  return { document, collection, mapId: map.id };
}

const request = (source: ReturnType<typeof fixture>) => ({ mapId: source.mapId, tilesetId: source.collection.id, wangSetId: 'sparse-wang', colorId: 1 });

describe('image-collection Wang terrain admission', () => {
  it('freezes exact sparse representatives, source dependencies, and the document revision', () => {
    const source = fixture();
    const plan = planWangTerrainSelection(source.document, request(source));
    expect(plan).toMatchObject({ imageCollection: true, expectedDocumentRevision: source.document.revision, colorId: 1 });
    expect(plan.wangSet.tiles.map((tile) => tile.tileId)).toEqual([0, 3]);
    expect(plan.expectedSpriteDependencies?.map((guard) => guard.spriteId)).toEqual([
      source.collection.tiles[0].imageAssetId,
      source.collection.tiles[3].imageAssetId,
    ]);
    expect(wangTerrainSelectionPlansMatch(plan, planWangTerrainSelection(structuredClone(source.document), request(source)))).toBe(true);
    const drift = structuredClone(source.document);
    const sprite = drift.pixelAssets[source.collection.tiles[3].imageAssetId!]; if (sprite.type !== 'sprite') throw new Error('Expected sprite'); sprite.revision += 1;
    expect(wangTerrainSelectionPlansMatch(plan, planWangTerrainSelection(drift, request(source)))).toBe(false);
  });

  it('refuses sparse gaps, missing sources, unsupported modes, overlap, and precedence shadows', () => {
    const source = fixture();
    const sourceId = source.collection.tiles[3].imageAssetId!;
    source.collection.tiles[3].imageAssetId = 'missing-source';
    expect(() => planWangTerrainSelection(source.document, request(source))).toThrow('missing its sprite source');
    source.collection.tiles[3].imageAssetId = sourceId;
    source.collection.wangSets[0].tiles[1].tileId = 2;
    expect(() => planWangTerrainSelection(source.document, request(source))).toThrow('sparse gap');
    source.collection.wangSets[0].tiles[1].tileId = 3;
    const map = source.document.pixelAssets[source.mapId]; if (map.type !== 'tilemap') throw new Error('Expected map');
    map.infinite = true;
    expect(() => planWangTerrainSelection(source.document, request(source))).toThrow('finite orthogonal');
    map.infinite = false;
    const overlap = createPixelTileset('Overlap', 'missing-atlas', 8, 8, 4, 1); overlap.firstGid = 20;
    source.document.pixelAssets[overlap.id] = overlap; source.document.assetIds.push(overlap.id); map.tilesetIds.push(overlap.id);
    expect(() => planWangTerrainSelection(source.document, request(source))).toThrow('covered by 2');
    map.tilesetIds.pop(); delete source.document.pixelAssets[overlap.id]; source.document.assetIds.pop();
    const shadow = createPixelTileset('Short higher range', 'missing-atlas', 8, 8, 1, 1); shadow.firstGid = 22;
    source.document.pixelAssets[shadow.id] = shadow; source.document.assetIds.push(shadow.id); map.tilesetIds.push(shadow.id);
    expect(() => planWangTerrainSelection(source.document, request(source))).toThrow('does not resolve exactly');
  });

  it('refuses the complete collection source budget before terrain admission', () => {
    const source = fixture();
    for (const tileId of [0, 3]) {
      const sprite = source.document.pixelAssets[source.collection.tiles[tileId].imageAssetId!];
      if (sprite.type !== 'sprite') throw new Error('Expected sprite');
      sprite.width = 8_192; sprite.height = 8_192;
    }
    expect(() => planWangTerrainSelection(source.document, request(source))).toThrow('64-megapixel');
  });

  it('refuses a missing collection animation target before terrain admission', () => {
    const source = fixture();
    source.collection.tiles[3].animation[0].tileId = 2;
    expect(() => planWangTerrainSelection(source.document, request(source))).toThrow('sparse gap or missing source');
    const next = structuredClone(source.collection);
    next.wangSets[0].name = 'Still invalid';
    expect(() => planImageCollectionWangMutation(source.document, source.collection, next)).toThrow('sparse gap or missing source');
  });

  it('admits metadata replacement only across exact finite attachments and complete source guards', () => {
    const source = fixture();
    const next = structuredClone(source.collection);
    next.wangSets[0].name = 'Renamed exact terrain';
    expect(planImageCollectionWangMutation(source.document, source.collection, next)).toMatchObject({
      expectedDocumentRevision: source.document.revision,
      expectedSpriteDependencies: [{ spriteId: source.collection.tiles[0].imageAssetId }, { spriteId: source.collection.tiles[3].imageAssetId }],
    });
    const detached = structuredClone(source.document);
    const map = detached.pixelAssets[source.mapId]; if (map.type !== 'tilemap') throw new Error('Expected map'); map.tilesetIds = [];
    expect(() => planImageCollectionWangMutation(detached, source.collection, next)).toThrow('Attach this image collection');
    const mixedEdit = structuredClone(next); mixedEdit.tileOffset.x = 1;
    expect(() => planImageCollectionWangMutation(source.document, source.collection, mixedEdit)).toThrow('cannot change any other image-collection field');
  });
});
