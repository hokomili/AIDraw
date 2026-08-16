import {
  captureTileStamp,
  createPixelDocument,
  createPixelSprite,
  createPixelTilemap,
  createPixelTileset,
  decodeTiledGid,
  placeTileStamp,
  type PixelDocument,
  type PixelTilemap,
  type PixelTileset,
} from '@aidraw/core';
import { describe, expect, it } from 'vitest';
import {
  attachedMapTileAuthoringTilesets,
  imageCollectionAuthoringTileIds,
  mapTileAuthoringPlansMatch,
  planMapTileAuthoringSelection,
} from '../../src/common/map-tile-authoring';
import { resolveRenderedTilesetTileSource } from '../../src/common/tile-animation';

function fixture(): {
  document: PixelDocument;
  map: PixelTilemap;
  atlas: PixelTileset;
  collection: PixelTileset;
  narrowId: string;
  wideId: string;
} {
  const document = createPixelDocument('project', 'Current collection tile');
  document.assetIds = [];
  document.pixelAssets = {};
  const atlasSprite = createPixelSprite('Atlas pixels', 16, 8);
  const atlas = createPixelTileset('Atlas', atlasSprite.id, 8, 8, 2, 1);
  atlas.firstGid = 1;
  const narrow = createPixelSprite('Narrow tile', 7, 13);
  const wide = createPixelSprite('Wide tile', 19, 5);
  const collection = createPixelTileset('Sparse collection', narrow.id, 19, 13, 1, 1);
  collection.spriteAssetId = undefined;
  collection.firstGid = 17;
  collection.columns = 2;
  collection.rows = 0;
  collection.wangSets = [];
  collection.tiles = {
    0: { id: 0, sourceX: 0, sourceY: 0, imageAssetId: narrow.id, probability: 1, animation: [], collisions: [], properties: {} },
    3: { id: 3, sourceX: 0, sourceY: 0, imageAssetId: wide.id, probability: 1, animation: [{ tileId: 0, durationMs: 90 }], collisions: [], properties: {} },
  };
  const map = createPixelTilemap('Finite map');
  map.tilesetIds = [atlas.id, collection.id];
  document.pixelAssets = {
    [atlasSprite.id]: atlasSprite,
    [atlas.id]: atlas,
    [narrow.id]: narrow,
    [wide.id]: wide,
    [collection.id]: collection,
    [map.id]: map,
  };
  document.assetIds = [atlasSprite.id, atlas.id, narrow.id, wide.id, collection.id, map.id];
  document.activeAssetId = map.id;
  return { document, map, atlas, collection, narrowId: narrow.id, wideId: wide.id };
}

describe('exact map-tile human authoring', () => {
  it('lists attached tilesets in authored order and enumerates only exact sparse collection IDs', () => {
    const source = fixture();
    expect(attachedMapTileAuthoringTilesets(source.document, source.map).map((tileset) => tileset.id)).toEqual([
      source.atlas.id,
      source.collection.id,
    ]);
    expect(imageCollectionAuthoringTileIds(source.collection)).toEqual([0, 3]);
    expect(imageCollectionAuthoringTileIds(source.atlas)).toEqual([]);
  });

  it('plans one exact transformed sparse tile with complete document and source guards', () => {
    const source = fixture();
    const plan = planMapTileAuthoringSelection(source.document, {
      mapId: source.map.id,
      tilesetId: source.collection.id,
      tileId: 3,
      transforms: { hFlip: true, vFlip: false, diagonal: true },
    });
    expect(decodeTiledGid(plan.rawGid)).toEqual({ gid: 20, hFlip: true, vFlip: false, diagonal: true });
    expect(plan).toMatchObject({
      documentId: source.document.id,
      mapId: source.map.id,
      mapRevision: source.map.revision,
      tilesetId: source.collection.id,
      tilesetRevision: source.collection.revision,
      tileId: 3,
      imageCollection: true,
      sourceId: source.wideId,
      expectedDocumentRevision: source.document.revision,
    });
    expect(plan.expectedSpriteDependencies).toEqual([
      { spriteId: source.narrowId, expectedRevision: 0, width: 7, height: 13 },
      { spriteId: source.wideId, expectedRevision: 0, width: 19, height: 5 },
    ]);
    expect(plan.tileset).not.toBe(source.collection);
    expect(plan.tileset).toEqual(source.collection);
    expect(resolveRenderedTilesetTileSource(source.document, plan.tileset, plan.tileId, 0)).toMatchObject({
      localId: 0,
      sprite: { id: source.narrowId, width: 7, height: 13 },
      rect: { x: 0, y: 0, width: 7, height: 13 },
    });
  });

  it('preserves the atlas predecessor choice without adding a document-wide guard', () => {
    const source = fixture();
    const plan = planMapTileAuthoringSelection(source.document, {
      mapId: source.map.id,
      tilesetId: source.atlas.id,
      tileId: 1,
      transforms: { hFlip: false, vFlip: true, diagonal: false },
    });
    expect(decodeTiledGid(plan.rawGid)).toEqual({ gid: 2, hFlip: false, vFlip: true, diagonal: false });
    expect(plan.imageCollection).toBe(false);
    expect(plan.expectedDocumentRevision).toBeUndefined();
    expect(plan.expectedSpriteDependencies).toBeUndefined();
  });

  it('refuses sparse gaps, unsupported modes, missing sources, transforms, ambiguity, and precedence shadows', () => {
    const source = fixture();
    const request = {
      mapId: source.map.id,
      tilesetId: source.collection.id,
      tileId: 3,
      transforms: { hFlip: false, vFlip: false, diagonal: false },
    };
    expect(() => planMapTileAuthoringSelection(source.document, { ...request, tileId: 2 })).toThrow('sparse gap');
    source.map.orientation = 'isometric';
    expect(() => planMapTileAuthoringSelection(source.document, request)).toThrow('finite orthogonal');
    source.map.orientation = 'orthogonal'; source.map.infinite = true;
    expect(() => planMapTileAuthoringSelection(source.document, request)).toThrow('finite orthogonal');
    source.map.infinite = false;

    source.collection.transformations = { hFlip: false, vFlip: false, rotate: false };
    expect(() => planMapTileAuthoringSelection(source.document, { ...request, transforms: { hFlip: true, vFlip: false, diagonal: false } })).toThrow('not permitted');
    source.collection.transformations = { hFlip: true, vFlip: true, rotate: true };

    const overlap = createPixelTileset('Overlap', source.narrowId, 7, 13, 1, 1);
    overlap.firstGid = 20;
    source.document.pixelAssets[overlap.id] = overlap;
    source.map.tilesetIds.push(overlap.id);
    expect(() => planMapTileAuthoringSelection(source.document, request)).toThrow('covered by 2 attached tileset ranges');
    source.map.tilesetIds.pop();

    const shortShadow = createPixelTileset('Short higher precedence', source.narrowId, 7, 13, 1, 1);
    shortShadow.firstGid = 19;
    source.document.pixelAssets[shortShadow.id] = shortShadow;
    source.map.tilesetIds.push(shortShadow.id);
    expect(() => planMapTileAuthoringSelection(source.document, request)).toThrow('does not resolve exactly');
    source.map.tilesetIds.pop();

    const narrow = source.document.pixelAssets[source.narrowId]; const wide = source.document.pixelAssets[source.wideId];
    if (narrow.type !== 'sprite' || wide.type !== 'sprite') throw new Error('Expected sprites');
    narrow.width = 8_192; narrow.height = 8_192; wide.width = 1; wide.height = 1;
    expect(() => planMapTileAuthoringSelection(source.document, request)).toThrow('64-megapixel');
    narrow.width = 7; narrow.height = 13; wide.width = 19; wide.height = 5;
    delete source.document.pixelAssets[source.wideId];
    expect(() => planMapTileAuthoringSelection(source.document, request)).toThrow('missing its sprite source');
  });

  it('detects visible-to-action source or canonical drift but admits a stable rerender', () => {
    const source = fixture();
    const request = {
      mapId: source.map.id,
      tilesetId: source.collection.id,
      tileId: 0,
      transforms: { hFlip: false, vFlip: false, diagonal: false },
    };
    const observed = planMapTileAuthoringSelection(source.document, request);
    expect(mapTileAuthoringPlansMatch(observed, planMapTileAuthoringSelection(structuredClone(source.document), request))).toBe(true);

    const sourceDrift = structuredClone(source.document);
    const changedSource = sourceDrift.pixelAssets[source.narrowId]; if (changedSource.type !== 'sprite') throw new Error('Expected sprite');
    changedSource.revision += 1; sourceDrift.revision += 1;
    expect(mapTileAuthoringPlansMatch(observed, planMapTileAuthoringSelection(sourceDrift, request))).toBe(false);

    const tilesetDrift = structuredClone(source.document);
    const changedTileset = tilesetDrift.pixelAssets[source.collection.id]; if (changedTileset.type !== 'tileset') throw new Error('Expected tileset');
    changedTileset.revision += 1; tilesetDrift.revision += 1;
    expect(mapTileAuthoringPlansMatch(observed, planMapTileAuthoringSelection(tilesetDrift, request))).toBe(false);
  });

  it('captures and places the exact transformed collection GID through a persistent saved stamp', () => {
    const source = fixture();
    const plan = planMapTileAuthoringSelection(source.document, {
      mapId: source.map.id,
      tilesetId: source.collection.id,
      tileId: 3,
      transforms: { hFlip: true, vFlip: true, diagonal: true },
    });
    const stamp = captureTileStamp('saved-collection', 'Saved collection tile', [{ x: 4, y: 7 }], () => plan.rawGid);
    expect(stamp.cells).toEqual([{ x: 0, y: 0, gid: plan.rawGid }]);
    const placed = placeTileStamp(stamp, 2, 3, { width: source.map.width, height: source.map.height });
    expect(placed).toEqual({ changes: [{ x: 2, y: 3, gid: plan.rawGid }], dropped: 0 });
    expect(decodeTiledGid(placed.changes[0].gid)).toEqual({ gid: 20, hFlip: true, vFlip: true, diagonal: true });
  });
});
